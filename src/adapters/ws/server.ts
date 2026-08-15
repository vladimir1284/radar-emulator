import WebSocket, { WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import type { SignalStore } from "../../core/signal-store.js";
import type { EventLog, LoggedEvent } from "../../log/event-log.js";
import type { RadarConfig } from "../../config/types.js";
import type { TickLoopHandle } from "../../core/tick-loop.js";
import type { ModbusTransactionCounter } from "../modbus/metrics.js";
import { nowMonotonicUs } from "../../core/clock.js";

interface ClientMessage {
  type: "force" | "release" | "resume_from";
  actor: string;
  signal?: string;
  value?: boolean | number;
  n?: number;
}

// Canal WebSocket: state (10Hz, se pierde sin drama) y event (numerado,
// persistido antes de enviar) van por canales con politicas opuestas
// (D-13, interfaces/websocket.md). "degrade"/"propagation"/"scenario" son
// fase 2/3, no se manejan todavia.
export function startWsServer(
  httpServer: HttpServer,
  config: RadarConfig,
  store: SignalStore,
  eventLog: EventLog,
  tickLoop: TickLoopHandle,
  modbusMetrics: ModbusTransactionCounter,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(message: unknown): void {
    const json = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  function broadcastSession(): void {
    broadcast({
      type: "session",
      id: eventLog.sessionInfo.id,
      config_hash: eventLog.sessionInfo.configHash,
      started_at_wall: eventLog.sessionInfo.startedAtWall,
      tick_ms: eventLog.sessionInfo.tickMs,
      connected: wss.clients.size,
    });
  }

  function sendEvent(logged: LoggedEvent): void {
    broadcast({ type: "event", ...logged });
  }

  // El evento se persiste (eventLog.log) antes de transmitirse (sendEvent),
  // cumpliendo D-13.
  store.on("forced", (e: { id: string; value: unknown; actor: string }) => {
    sendEvent(
      eventLog.log({ kind: "force", signal: e.id, actor: e.actor, payload: { value: e.value } }),
    );
  });
  store.on("released", (e: { id: string; value: unknown; actor: string }) => {
    sendEvent(
      eventLog.log({ kind: "release", signal: e.id, actor: e.actor, payload: { value: e.value } }),
    );
  });
  store.on("applied-write", (e: { id: string; value: unknown }) => {
    sendEvent(
      eventLog.log({
        kind: "controller_write",
        signal: e.id,
        actor: "controller",
        payload: { value: e.value },
      }),
    );
  });

  const stateTimer = setInterval(() => {
    const signals: Record<string, { v: unknown; m: string; q: string }> = {};
    for (const def of config.signals) {
      const r = store.read(def.id);
      signals[def.id] = { v: r.value, m: r.mode, q: r.quality };
    }
    broadcast({ type: "state", t_us: nowMonotonicUs(), signals });
  }, 100);

  const metricsTimer = setInterval(() => {
    broadcast({
      type: "metrics",
      t_us: nowMonotonicUs(),
      modbus_tx_per_s: modbusMetrics.takeAndReset(),
      tick_deviation_ms: Number(tickLoop.lastDeviationMs().toFixed(2)),
    });
  }, 1000);

  wss.on("connection", (ws) => {
    broadcastSession();

    ws.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // actor obligatorio en todo mensaje de cliente (websocket.md).
      if (!msg.actor) return;

      switch (msg.type) {
        case "force": {
          if (!msg.signal || msg.value === undefined || !store.has(msg.signal)) return;
          store.force(msg.signal, msg.value, msg.actor);
          break;
        }
        case "release": {
          if (!msg.signal || !store.has(msg.signal)) return;
          store.release(msg.signal, msg.actor);
          break;
        }
        case "resume_from": {
          if (typeof msg.n !== "number") return;
          for (const logged of eventLog.getSince(msg.n)) {
            ws.send(JSON.stringify({ type: "event", ...logged }));
          }
          break;
        }
      }
    });

    ws.on("close", () => broadcastSession());
  });

  wss.on("close", () => {
    clearInterval(stateTimer);
    clearInterval(metricsTimer);
  });

  return wss;
}
