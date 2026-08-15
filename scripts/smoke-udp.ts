import dgram from "node:dgram";
import { loadConfig } from "../src/config/load.js";
import { SignalStore } from "../src/core/signal-store.js";
import { UdpEncoderEmitter, STATUS_BIT, PACKET_SIZE } from "../src/adapters/udp/encoder.js";

const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const TEST_PORT = 18095;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ParsedPacket {
  magic: number;
  version: number;
  seq: number;
  tUs: bigint;
  azMdeg: number;
  elMdeg: number;
  azRateMdeg: number;
  elRateMdeg: number;
  status: number;
}

function parsePacket(buf: Buffer): ParsedPacket {
  assert(buf.length === PACKET_SIZE, `paquete deberia ser de ${PACKET_SIZE} bytes, fue ${buf.length}`);
  return {
    magic: buf.readUInt16LE(0),
    version: buf.readUInt8(2),
    seq: buf.readUInt32LE(4),
    tUs: buf.readBigUInt64LE(8),
    azMdeg: buf.readInt32LE(16),
    elMdeg: buf.readInt32LE(20),
    azRateMdeg: buf.readInt32LE(24),
    elRateMdeg: buf.readInt32LE(28),
    status: buf.readUInt16LE(32),
  };
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  config.transports.encoder_udp.dest_host = "127.0.0.1";
  config.transports.encoder_udp.dest_port = TEST_PORT;
  config.transports.encoder_udp.rate_hz = 50; // 20ms, mas facil de esperar en el test

  const store = new SignalStore(config);
  store.force("ant.az_position", 45.0, "smoke");
  store.force("ant.el_position", 10.0, "smoke");
  store.force("ant.az_rate", 18.0, "smoke");

  const received: ParsedPacket[] = [];
  const receiver = dgram.createSocket("udp4");
  receiver.on("message", (msg) => received.push(parsePacket(msg)));
  await new Promise<void>((resolve) => receiver.bind(TEST_PORT, "127.0.0.1", resolve));

  const emitter = new UdpEncoderEmitter(config, store);
  emitter.start();

  // Drena cualquier paquete en vuelo de la fase anterior antes de limpiar
  // el buffer: el envio es sincrono por tick pero la entrega UDP local no
  // lo es, asi que un paquete emitido bajo el estado viejo puede llegar
  // despues de que ya cambiamos de degradacion si no se espera un poco.
  async function settleAndClear(ms: number): Promise<void> {
    await sleep(ms);
    received.length = 0;
  }

  try {
    await sleep(250); // ~12 paquetes a 50Hz
    assert(received.length >= 8, `esperaba varios paquetes en 250ms a 50Hz, llegaron ${received.length}`);

    const first = received[0]!;
    assert(first.magic === 0x5244, `magic deberia ser 0x5244, fue 0x${first.magic.toString(16)}`);
    assert(first.version === 1, `version deberia ser 1, fue ${first.version}`);
    assert(first.azMdeg === 45_000, `az_mdeg deberia ser 45000 (45 deg), fue ${first.azMdeg}`);
    assert(first.elMdeg === 10_000, `el_mdeg deberia ser 10000 (10 deg), fue ${first.elMdeg}`);
    assert(first.azRateMdeg === 18_000, `az_rate_mdeg deberia ser 18000, fue ${first.azRateMdeg}`);
    assert((first.status & STATUS_BIT.SIM) !== 0, "bit SIM deberia estar activo siempre");
    assert((first.status & STATUS_BIT.AZ_VALID) !== 0, "AZ_VALID deberia estar activo sin degradacion");
    assert((first.status & STATUS_BIT.DEGRADED) === 0, "DEGRADED no deberia estar activo sin degradacion");

    for (let i = 1; i < received.length; i++) {
      const prevSeq = received[i - 1]!.seq;
      const seq = received[i]!.seq;
      assert(seq === (prevSeq + 1) >>> 0, `seq deberia ser consecutiva: ${prevSeq} -> ${seq}`);
    }
    console.log(`paquete nominal OK (${received.length} paquetes, seq consecutiva, campos correctos)`);

    // --- silencio total ---
    await settleAndClear(150);
    emitter.degradation.silent = true;
    await sleep(150);
    assert(received.length === 0, `silencio total no deberia emitir nada, llegaron ${received.length}`);
    emitter.degradation.silent = false;
    console.log("silencio total: OK");

    // --- encoder invalido ---
    await settleAndClear(150);
    emitter.degradation.encoderInvalid = true;
    await sleep(80);
    assert(received.length > 0, "deberia seguir emitiendo con encoder invalido, solo cambia el bit");
    assert(
      (received[0]!.status & STATUS_BIT.AZ_VALID) === 0,
      "AZ_VALID deberia estar en cero con encoderInvalid activo",
    );
    assert((received[0]!.status & STATUS_BIT.DEGRADED) !== 0, "DEGRADED deberia estar activo");
    emitter.degradation.encoderInvalid = false;
    console.log("encoder invalido: bits correctos, OK");

    // --- congelacion ---
    await settleAndClear(150);
    emitter.degradation.frozen = true;
    await sleep(30);
    store.force("ant.az_position", 99.0, "smoke"); // el valor real cambia...
    await sleep(120);
    const azValues = new Set(received.map((p) => p.azMdeg));
    assert(azValues.size === 1, `congelado deberia mandar siempre el mismo az_mdeg, vi ${[...azValues]}`);
    const seqs = received.map((p) => p.seq);
    assert(seqs[seqs.length - 1]! > seqs[0]!, "seq debe seguir avanzando durante la congelacion");
    emitter.degradation.frozen = false;
    console.log("congelacion: posicion fija, seq avanzando, OK");

    // --- perdida total (probabilidad 1) ---
    await settleAndClear(150);
    emitter.degradation.lossProbability = 1;
    await sleep(120);
    assert(received.length === 0, `perdida probabilidad 1 no deberia entregar nada, llegaron ${received.length}`);
    emitter.degradation.lossProbability = 0;
    console.log("perdida (probabilidad 1): OK");

    // --- duplicacion (probabilidad 1) ---
    await settleAndClear(150);
    emitter.degradation.duplicateProbability = 1;
    await sleep(100);
    const uniqueSeqs = new Set(received.map((p) => p.seq));
    assert(
      received.length >= uniqueSeqs.size * 2 - 1,
      `con duplicacion=1 cada seq deberia repetirse, ${received.length} paquetes / ${uniqueSeqs.size} seq unicas`,
    );
    emitter.degradation.duplicateProbability = 0;
    console.log("duplicacion (probabilidad 1): OK");

    // --- rafaga de perdida (duracion fija) ---
    await settleAndClear(150);
    const nowUsBurst = Number(process.hrtime.bigint() / 1000n);
    emitter.degradation.burstUntilUs = nowUsBurst + 80_000; // 80ms de corte
    await sleep(50);
    assert(received.length === 0, "durante la rafaga no deberia llegar nada");
    await sleep(80);
    assert(received.length > 0, "tras la rafaga deberia volver a emitir");
    console.log("rafaga de perdida: corte y recuperacion, OK");

    // --- jitter/reordenamiento: no debe romper nada, y algo debe llegar ---
    await settleAndClear(150);
    emitter.degradation.jitterMaxMs = 15;
    emitter.degradation.reorderWindowMs = 40;
    await sleep(200);
    assert(received.length > 0, "con jitter/reorder deberia seguir llegando trafico");
    emitter.degradation.jitterMaxMs = 0;
    emitter.degradation.reorderWindowMs = 0;
    console.log(`jitter+reorder: ${received.length} paquetes recibidos sin romper, OK`);

    // --- salto de secuencia ---
    received.length = 0;
    await sleep(40);
    const seqBefore = received[received.length - 1]!.seq;
    emitter.degradation.seqJumpPending = 1000;
    await sleep(60);
    const afterJump = received.find((p) => p.seq > seqBefore + 1);
    assert(afterJump !== undefined, "deberia verse un salto de secuencia mayor a +1");
    console.log(`salto de secuencia: de ${seqBefore} a ${afterJump!.seq}, OK`);

    console.log("\nUDP encoder E2E: fin sin errores no esperados.");
  } finally {
    emitter.stop();
    receiver.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
