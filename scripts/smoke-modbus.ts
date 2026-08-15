import { createRequire } from "node:module";
// El default export de modbus-serial no tipa bien bajo moduleResolution
// NodeNext ("not constructable"); a diferencia de ajv no hay named export
// alternativo. require() evita el problema; es un script de humo, no
// codigo de produccion.
const ModbusRTU = createRequire(import.meta.url)("modbus-serial");
import { loadConfig } from "../src/config/load.js";
import { SignalStore } from "../src/core/signal-store.js";
import { startTickLoop } from "../src/core/tick-loop.js";
import { startModbusServer } from "../src/adapters/modbus/server.js";
import { ModbusTransactionCounter } from "../src/adapters/modbus/metrics.js";

const config = loadConfig(new URL("../config/rd100s.seed.json", import.meta.url).pathname);
const store = new SignalStore(config);
const tickLoop = startTickLoop(store, config.tick_ms);
const server = startModbusServer(config, store, new ModbusTransactionCounter());

server.on("initialized", async () => {
  const client = new ModbusRTU();
  await client.connectTCP("127.0.0.1", { port: config.transports.modbus_tcp.port });
  client.setTimeout(2000);

  try {
    // 1) DI de solo lectura, unit 1 (tx/ADAM 4051): tx.tx_on_status, coil addr 0.
    client.setID(1);
    const di = await client.readCoils(0, 1);
    console.log("DI tx.tx_on_status (unit 1, addr 0) =", di.data[0], "esperado false (initial)");

    // 2) Escritura de solo lectura sobre una DI debe dar excepcion.
    try {
      await client.writeCoil(0, true);
      console.log("FALLA: no exception al escribir una DI de solo lectura");
    } catch (e) {
      console.log("OK excepcion en escritura DI:", (e as Error).message);
    }

    // 3) AI de solo lectura, unit 4 (tx/ADAM 4117): tx.mps_output_voltage_sample, holding addr 0.
    //    initial 0.0 kV sobre range [0,30], raw_range [0,65535] -> raw esperado 0.
    client.setID(4);
    const ai = await client.readHoldingRegisters(0, 1);
    console.log("AI tx.mps_output_voltage_sample (unit 4, addr 0) raw =", ai.data[0], "esperado 0");

    // 4) DO de escritura, unit 3 (tx/ADAM 4069): tx.turn_on_tx_command, coil addr 16.
    client.setID(3);
    await client.writeCoil(16, true);
    await new Promise((r) => setTimeout(r, config.tick_ms * 2)); // esperar a que el tick drene la escritura
    const doRead = await client.readCoils(16, 1);
    console.log("DO tx.turn_on_tx_command tras escribir true y esperar un tick =", doRead.data[0], "esperado true");

    // 5) AO de escritura, unit 2 (tx/ADAM 4024): tx.voltage_reference_mps, holding addr 0, range [0,10]V, raw [0,65535].
    //    Escribir 5V -> raw esperado ~32768.
    client.setID(2);
    await client.writeRegister(0, 32768);
    await new Promise((r) => setTimeout(r, config.tick_ms * 2));
    const aoRead = await client.readHoldingRegisters(0, 1);
    console.log("AO tx.voltage_reference_mps tras escribir raw 32768 (~5V) =", aoRead.data[0], "esperado ~32768");

    // 6) multi-unit routing: unit 1 addr 0 (tx) y unit 11 addr 0 (ant) son señales DISTINTAS,
    //    no deben contaminarse (a diferencia de jsmodbus en fase 0).
    client.setID(11);
    const diAnt = await client.readCoils(0, 1);
    console.log("DI ant unit 11 addr 0 =", diAnt.data[0], "(independiente de unit 1)");

    console.log("\nE2E: fin sin errores no esperados.");
  } catch (e) {
    console.error("ERROR INESPERADO", e);
  } finally {
    client.close(() => {});
    tickLoop.stop();
    server.close(() => process.exit(0));
  }
});
