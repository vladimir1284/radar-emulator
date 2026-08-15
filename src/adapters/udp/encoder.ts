import dgram from "node:dgram";
import type { RadarConfig } from "../../config/types.js";
import type { SignalStore } from "../../core/signal-store.js";
import { nowMonotonicUs } from "../../core/clock.js";

// RD100S-ENC-UDP v1 (docs/interfaces/udp-encoder.md). 36 octetos exactos,
// little-endian.
const MAGIC = 0x5244;
const VERSION = 0x01;
export const PACKET_SIZE = 36;

export const STATUS_BIT = {
  AZ_VALID: 1 << 0,
  EL_VALID: 1 << 1,
  AZ_REF_OK: 1 << 2,
  EL_REF_OK: 1 << 3,
  AZ_FAULT: 1 << 4,
  EL_FAULT: 1 << 5,
  SIM: 1 << 6,
  DEGRADED: 1 << 7,
} as const;

export interface PacketFields {
  seq: number;
  tUs: bigint;
  azMdeg: number;
  elMdeg: number;
  azRateMdeg: number;
  elRateMdeg: number;
  status: number;
}

export function buildPacket(f: PacketFields): Buffer {
  const buf = Buffer.alloc(PACKET_SIZE);
  buf.writeUInt16LE(MAGIC, 0);
  buf.writeUInt8(VERSION, 2);
  buf.writeUInt8(0, 3);
  buf.writeUInt32LE(f.seq >>> 0, 4);
  buf.writeBigUInt64LE(BigInt.asUintN(64, f.tUs), 8);
  buf.writeInt32LE(f.azMdeg | 0, 16);
  buf.writeInt32LE(f.elMdeg | 0, 20);
  buf.writeInt32LE(f.azRateMdeg | 0, 24);
  buf.writeInt32LE(f.elRateMdeg | 0, 28);
  buf.writeUInt16LE(f.status & 0xffff, 32);
  buf.writeUInt16LE(0, 34);
  return buf;
}

// D-25: modelo de degradaciones deliberadamente simple (ver docs). Estado
// mutable expuesto directamente: el adaptador WS lo escribe, el emisor lo lee.
export interface DegradationState {
  lossProbability: number;
  burstUntilUs: number | null;
  duplicateProbability: number;
  reorderWindowMs: number;
  jitterMaxMs: number;
  frozen: boolean;
  frozenAzMdeg: number;
  frozenElMdeg: number;
  encoderInvalid: boolean;
  seqJumpPending: number;
  silent: boolean;
}

export function defaultDegradationState(): DegradationState {
  return {
    lossProbability: 0,
    burstUntilUs: null,
    duplicateProbability: 0,
    reorderWindowMs: 0,
    jitterMaxMs: 0,
    frozen: false,
    frozenAzMdeg: 0,
    frozenElMdeg: 0,
    encoderInvalid: false,
    seqJumpPending: 0,
    silent: false,
  };
}

function degradationActive(d: DegradationState): boolean {
  return (
    d.lossProbability > 0 ||
    d.burstUntilUs !== null ||
    d.duplicateProbability > 0 ||
    d.reorderWindowMs > 0 ||
    d.jitterMaxMs > 0 ||
    d.frozen ||
    d.encoderInvalid ||
    d.seqJumpPending !== 0 ||
    d.silent
  );
}

function degToMdeg(deg: number): number {
  return Math.round(deg * 1000);
}

const SOCKET_ERROR_LOG_INTERVAL_MS = 5000;

export class UdpEncoderEmitter {
  readonly degradation: DegradationState = defaultDegradationState();
  private readonly socket = dgram.createSocket("udp4");
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private socketErrorsSinceLastLog = 0;
  private lastSocketErrorLogAt = 0;

  constructor(
    private readonly config: RadarConfig,
    private readonly store: SignalStore,
  ) {
    // Sin este listener, un error del socket (p.ej. "dest_host" que no
    // resuelve por DNS) es un 'error' no manejado y tira todo el proceso
    // (AGENTS.md: nada del emulador debe poder matar el proceso por un
    // problema de red del lado del controlador). Se acumula y se reporta
    // cada pocos segundos, no una linea por paquete: a 100Hz un DNS caido
    // inundaria el log en segundos.
    this.socket.on("error", (err) => {
      this.socketErrorsSinceLastLog += 1;
      const now = nowMonotonicUs() / 1000;
      if (now - this.lastSocketErrorLogAt >= SOCKET_ERROR_LOG_INTERVAL_MS) {
        console.error(
          `udp encoder: ${this.socketErrorsSinceLastLog} error(es) de socket en los ultimos ~${SOCKET_ERROR_LOG_INTERVAL_MS / 1000}s, ultimo: ${err.message}`,
        );
        this.socketErrorsSinceLastLog = 0;
        this.lastSocketErrorLogAt = now;
      }
    });
  }

  start(): void {
    const cfg = this.config.transports.encoder_udp;
    if (!cfg.enabled) return;
    const intervalMs = 1000 / cfg.rate_hz;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.socket.close();
  }

  private tick(): void {
    const d = this.degradation;
    const cfg = this.config.transports.encoder_udp;
    const nowUs = nowMonotonicUs();

    if (d.silent) return;
    if (d.burstUntilUs !== null) {
      if (nowUs < d.burstUntilUs) return;
      d.burstUntilUs = null;
    }

    this.seq = (this.seq + 1 + d.seqJumpPending) >>> 0;
    d.seqJumpPending = 0;

    if (d.lossProbability > 0 && Math.random() < d.lossProbability) return;

    const azReading = this.store.read(cfg.azimuth_signal);
    const elReading = this.store.read(cfg.elevation_signal);
    const azRateReading = this.store.read(cfg.az_rate_signal);
    const elRateReading = this.store.read(cfg.el_rate_signal);

    let azMdeg = degToMdeg(azReading.value as number);
    let elMdeg = degToMdeg(elReading.value as number);
    azMdeg = ((azMdeg % 360_000) + 360_000) % 360_000;

    if (d.frozen) {
      azMdeg = d.frozenAzMdeg;
      elMdeg = d.frozenElMdeg;
    } else {
      d.frozenAzMdeg = azMdeg;
      d.frozenElMdeg = elMdeg;
    }

    let status = STATUS_BIT.SIM;
    status |= STATUS_BIT.AZ_REF_OK | STATUS_BIT.EL_REF_OK; // PEND-udp-ref-ok: sin señal de referenciado aun
    if (!d.encoderInvalid) status |= STATUS_BIT.AZ_VALID | STATUS_BIT.EL_VALID;
    // Nada especifico del RD100S cableado (AGENTS.md): que señal marca falla
    // de cada eje, si alguna, es un dato de configuracion.
    if (cfg.az_fault_signal && this.store.read(cfg.az_fault_signal).value) status |= STATUS_BIT.AZ_FAULT;
    if (cfg.el_fault_signal && this.store.read(cfg.el_fault_signal).value) status |= STATUS_BIT.EL_FAULT;
    if (degradationActive(d)) status |= STATUS_BIT.DEGRADED;

    const packet = buildPacket({
      seq: this.seq,
      tUs: BigInt(nowUs),
      azMdeg,
      elMdeg,
      azRateMdeg: degToMdeg(azRateReading.value as number),
      elRateMdeg: degToMdeg(elRateReading.value as number),
      status,
    });

    const extraDelayMs = Math.max(
      d.jitterMaxMs > 0 ? Math.random() * d.jitterMaxMs : 0,
      d.reorderWindowMs > 0 ? Math.random() * d.reorderWindowMs : 0,
    );
    this.send(packet, extraDelayMs, cfg.dest_host, cfg.dest_port);
    if (d.duplicateProbability > 0 && Math.random() < d.duplicateProbability) {
      this.send(packet, extraDelayMs, cfg.dest_host, cfg.dest_port);
    }
  }

  private send(packet: Buffer, delayMs: number, host: string, port: number): void {
    const doSend = () => this.socket.send(packet, port, host);
    if (delayMs > 0) setTimeout(doSend, delayMs);
    else doSend();
  }
}
