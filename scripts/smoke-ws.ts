import { mkdirSync, rmSync } from "node:fs";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config/load.js";
import { SignalStore } from "../src/core/signal-store.js";
import { startTickLoop } from "../src/core/tick-loop.js";
import { ModbusTransactionCounter } from "../src/adapters/modbus/metrics.js";
import { EventLog } from "../src/log/event-log.js";
import { createHttpServer } from "../src/adapters/http/static-server.js";
import { startWsServer } from "../src/adapters/ws/server.js";

const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const DB_PATH = `${DATA_DIR}/emulator-smoke.sqlite`;
const HTTP_PORT = 18080;

interface SessionMsg {
  type: "session";
  id: string;
  connected: number;
}
interface StateMsg {
  type: "state";
  signals: Record<string, { v: boolean | number; m: string; q: string }>;
}
interface EventMsg {
  type: "event";
  n: number;
  kind: string;
  signal?: string;
}
type WsMsg = SessionMsg | StateMsg | EventMsg;

// Cola de mensajes recibidos: el listener se engancha desde el momento en
// que se crea el socket, no cuando se llama waitFor. Sin esto hay una
// carrera real entre "session" (que el servidor manda apenas conecta) y el
// listener que lo esperaria.
class MessageQueue {
  private readonly buffer: WsMsg[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (raw: Buffer) => {
      this.buffer.push(JSON.parse(raw.toString()) as WsMsg);
    });
  }

  waitFor<T extends WsMsg>(predicate: (m: WsMsg) => m is T, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const tryConsume = (): boolean => {
        const idx = this.buffer.findIndex(predicate);
        if (idx === -1) return false;
        const [msg] = this.buffer.splice(idx, 1);
        resolve(msg as T);
        return true;
      };
      if (tryConsume()) return;
      const poll = setInterval(() => {
        if (tryConsume()) clearInterval(poll);
      }, 20);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error("timeout esperando mensaje"));
      }, timeoutMs);
    });
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const config = loadConfig(CONFIG_PATH);
  const analogWritable = config.signals.find((s) => s.kind === "AO");
  if (!analogWritable) throw new Error("la semilla no tiene señales AO");
  const signalId = analogWritable.id;

  const eventLog = new EventLog(DB_PATH, "smoke-test-hash", config.tick_ms);
  const store = new SignalStore(config);
  const tickLoop = startTickLoop(store, config.tick_ms);
  const metrics = new ModbusTransactionCounter();

  const httpServer = createHttpServer(
    new URL("../public", import.meta.url).pathname,
    eventLog,
    config,
    "smoke-test-hash",
  );
  const wss = startWsServer(httpServer, config, store, eventLog, tickLoop, metrics);

  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, resolve));

  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`);
  const queue = new MessageQueue(ws);

  try {
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    const isSession = (m: WsMsg): m is SessionMsg => m.type === "session";
    const isState = (m: WsMsg): m is StateMsg => m.type === "state";
    const isForceEvent = (m: WsMsg): m is EventMsg => m.type === "event" && m.kind === "force";
    const isReleaseEvent = (m: WsMsg): m is EventMsg => m.type === "event" && m.kind === "release";

    const session = await queue.waitFor(isSession);
    console.log("session:", session.id.slice(0, 8), "connected:", session.connected, "esperado 1");

    const state1 = await queue.waitFor(isState);
    console.log(
      "state antes de forzar:",
      signalId,
      "=",
      state1.signals[signalId],
      "esperado modo auto",
    );

    ws.send(JSON.stringify({ type: "force", actor: "op-smoke", signal: signalId, value: 7.5 }));
    const forceEvent = await queue.waitFor(isForceEvent);
    console.log("event force recibido, n =", forceEvent.n, "signal =", forceEvent.signal);

    const stateAfterForce = await queue.waitFor(
      (m): m is StateMsg => isState(m) && m.signals[signalId]?.m === "forced",
    );
    console.log("state tras forzar:", stateAfterForce.signals[signalId], "esperado v=7.5 m=forced");

    ws.send(JSON.stringify({ type: "release", actor: "op-smoke", signal: signalId }));
    const releaseEvent = await queue.waitFor(isReleaseEvent);
    console.log("event release recibido, n =", releaseEvent.n);

    // Mensaje sin actor: debe ignorarse sin romper la conexion.
    ws.send(JSON.stringify({ type: "force", signal: signalId, value: 1 }));

    ws.send(JSON.stringify({ type: "resume_from", actor: "op-smoke", n: 0 }));
    const resent = await queue.waitFor((m): m is EventMsg => isForceEvent(m) && m.n === forceEvent.n);
    console.log("resume_from re-envio el evento n =", resent.n, "OK");

    const exportRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/session/export`);
    const exportBody = (await exportRes.json()) as { events: unknown[] };
    console.log(
      "export HTTP status",
      exportRes.status,
      "eventos exportados =",
      exportBody.events.length,
      "esperado >= 2",
    );

    console.log("\nWS/HTTP/SQLite E2E: fin sin errores no esperados.");
  } finally {
    ws.close();
    tickLoop.stop();
    eventLog.close();
    wss.close();
    httpServer.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
