import dgram from "node:dgram";
import { createRequire } from "node:module";
import { loadConfig } from "../src/config/load.js";
import { SignalStore } from "../src/core/signal-store.js";
import { startTickLoop } from "../src/core/tick-loop.js";
import { startAxisLoop } from "../src/core/axis-loop.js";
import { compileModel } from "../src/core/model.js";
import { startModbusServer } from "../src/adapters/modbus/server.js";
import { ModbusTransactionCounter } from "../src/adapters/modbus/metrics.js";
import { UdpEncoderEmitter } from "../src/adapters/udp/encoder.js";

// Criterio de salida de fase 2 (fases.md): "Encender el transmisor desde el
// controlador produce una secuencia temporal completa y coherente, y el
// controlador cierra el lazo de posicion contra el stream UDP. Las
// degradaciones del stream se activan ... y el controlador reacciona."
// Este script simula al controlador con un cliente Modbus real, y observa
// el stream UDP real con un socket crudo: es la prueba mas fiel a como se
// vera esto contra el RD100S de verdad, sin mockear ninguna de las dos
// interfaces externas.

const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const MODBUS_PORT = 15502;
const UDP_PORT = 18096;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  config.transports.modbus_tcp.port = MODBUS_PORT;
  config.transports.encoder_udp.dest_host = "127.0.0.1";
  config.transports.encoder_udp.dest_port = UDP_PORT;
  config.transports.encoder_udp.rate_hz = 50;

  const { graph, axisBlocks } = compileModel(config);
  const store = new SignalStore(config);
  const tickLoop = startTickLoop(store, config.tick_ms, (s) => graph.evaluate(s));
  const axisLoop = startAxisLoop(store, axisBlocks, config.rate_groups.fast ?? 10);
  const modbusMetrics = new ModbusTransactionCounter();
  const modbusServer = startModbusServer(config, store, modbusMetrics);
  // Enganchado ANTES de cualquier otro await: modbus-serial puede emitir
  // "initialized" en el mismo tick, y un listener tardio se lo pierde
  // (misma carrera ya vista en scripts/smoke-fase2-e2e.ts vecinos).
  const modbusReady = new Promise<void>((resolve) => modbusServer.on("initialized", () => resolve()));

  const udpEmitter = new UdpEncoderEmitter(config, store);
  udpEmitter.start();

  const udpPackets: Buffer[] = [];
  const udpReceiver = dgram.createSocket("udp4");
  udpReceiver.on("message", (msg) => udpPackets.push(msg));
  await new Promise<void>((resolve) => udpReceiver.bind(UDP_PORT, "127.0.0.1", resolve));

  await modbusReady;

  const ModbusRTU = createRequire(import.meta.url)("modbus-serial");
  const client = new ModbusRTU();
  await client.connectTCP("127.0.0.1", { port: MODBUS_PORT });
  client.setTimeout(2000);

  try {
    // === Secuencia de encendido del transmisor, comandada por Modbus real ===
    // Precondiciones fisicas que en el banco real forzaria un operador (no
    // hay bloque que las produzca todavia): las 6 condiciones de interlock.
    for (const [id] of [
      ["tx.interlock_ok_status"],
      ["tx.wg_pressure_ok_status"],
      ["tx.cb_blower_ok_status"],
      ["tx.magnetron_blower_ok_status"],
      ["tx.pha_seq_ok_status"],
      ["tx.duty_cycle_ok_status"],
    ]) {
      store.force(id!, true, "operador-banco");
    }

    client.setID(3); // tx/ADAM 4069: turn_on_tx_command, coil 16
    await client.writeCoil(16, true);
    await sleep(config.tick_ms * 2);

    client.setID(1); // tx/ADAM 4051: tx_on_status, coil 0
    const txOn = await client.readCoils(0, 1);
    assert(txOn.data[0] === true, "el controlador deberia leer tx_on_status=true tras encender");
    console.log("Modbus: controlador enciende Tx, tx_on_status=true reflejado en unit 1: OK");

    client.setID(3);
    await client.writeCoil(16, false); // soltar el pulso
    await sleep(config.tick_ms);

    // === Cierre del lazo de posicion: comandar el eje por Modbus, observar UDP ===
    store.force("ant.au_on_status", true, "operador-banco");

    client.setID(13); // ant/ADAM 4069: enable_drive_az_conmand, coil 17
    await client.writeCoil(17, true);
    client.setID(12); // ant/ADAM 4024: speed_reference_driver_az, holding 0, range [-10,10]V -> raw unsigned 16 bits
    // 5V sobre rango [-10,10]V con raw_range bipolar [-32768,32767]:
    // signedRaw = -32768 + (5-(-10))/(10-(-10)) * 65535 = 16383, positivo -> palabra sin signo igual.
    await client.writeRegister(0, 16383);
    await sleep(400); // dejar que el eje acelere y se mueva

    await sleep(150); // asegurar que llegaron paquetes UDP tras el movimiento
    assert(udpPackets.length > 5, `deberian haber llegado varios paquetes UDP, llegaron ${udpPackets.length}`);

    const azValues = udpPackets.map((p) => p.readInt32LE(16));
    const first = azValues[0]!;
    const last = azValues[azValues.length - 1]!;
    assert(
      last > first && last < 20_000,
      `az_mdeg deberia haber avanzado (5V*3.6deg/s/V) sin envolver, de ${first} a ${last}`,
    );
    console.log(
      `UDP: az_mdeg paso de ${first} a ${last} tras comandar 5V por Modbus unit 12 (lazo cerrado): OK`,
    );

    const magicOk = udpPackets.every((p) => p.readUInt16LE(0) === 0x5244);
    assert(magicOk, "todos los paquetes deberian tener el magic correcto");
    console.log(`${udpPackets.length} paquetes UDP con magic/formato correcto: OK`);

    // === Degradacion activada "desde la interfaz" (aqui: llamada directa al
    // estado del emisor, que es exactamente lo que hace el WS handler) ===
    udpPackets.length = 0;
    udpEmitter.degradation.silent = true;
    await sleep(100);
    assert(udpPackets.length === 0, "silencio total deberia cortar el stream por completo");
    udpEmitter.degradation.silent = false;
    console.log("degradacion (silencio total) corta el stream: OK");

    console.log("\nFase 2 E2E (Modbus real + UDP real, controlador simulado): fin sin errores no esperados.");
  } finally {
    client.close(() => {});
    tickLoop.stop();
    axisLoop.stop();
    udpEmitter.stop();
    udpReceiver.close();
    await new Promise<void>((resolve) => modbusServer.close(() => resolve()));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
