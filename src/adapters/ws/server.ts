import WebSocket, { WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import type { SignalStore } from "../../core/signal-store.js";
import type { EventLog, LoggedEvent } from "../../log/event-log.js";
import type { RadarConfig } from "../../config/types.js";
import type { TickLoopHandle } from "../../core/tick-loop.js";
import type { ModbusTransactionCounter } from "../modbus/metrics.js";
import type { UdpEncoderEmitter } from "../udp/encoder.js";
import type { AssertionEngine, AssertionResult } from "../../core/assertions.js";
import type { ScenarioRunner, ScenarioStepEvent } from "../../core/scenarios.js";
import { nowMonotonicUs } from "../../core/clock.js";

type DegradeKind =
  | "loss"
  | "burst"
  | "duplicate"
  | "reorder"
  | "jitter"
  | "freeze"
  | "encoder_invalid"
  | "seq_jump"
  | "silence";

interface ClientMessage {
  type: "force" | "release" | "resume_from" | "propagation" | "degrade" | "scenario";
  actor: string;
  signal?: string;
  value?: boolean | number;
  n?: number;
  cut?: boolean;
  kind?: DegradeKind;
  active?: boolean;
  action?: "start" | "abort";
  id?: string;
}

// Aplica un mensaje "degrade" al estado mutable del emisor UDP y devuelve el
// payload que se registra como evento (interfaces/udp-encoder.md#6).
function applyDegradation(emitter: UdpEncoderEmitter, msg: ClientMessage): Record<string, unknown> | null {
  const d = emitter.degradation;
  const num = Number(msg.value ?? 0);
  switch (msg.kind) {
    case "loss":
      d.lossProbability = Math.min(1, Math.max(0, num));
      return { probability: d.lossProbability };
    case "burst": {
      const durationMs = Math.max(0, num);
      d.burstUntilUs = durationMs > 0 ? nowMonotonicUs() + durationMs * 1000 : null;
      return { duration_ms: durationMs };
    }
    case "duplicate":
      d.duplicateProbability = Math.min(1, Math.max(0, num));
      return { probability: d.duplicateProbability };
    case "reorder":
      d.reorderWindowMs = Math.max(0, num);
      return { window_ms: d.reorderWindowMs };
    case "jitter":
      d.jitterMaxMs = Math.max(0, num);
      return { max_ms: d.jitterMaxMs };
    case "freeze":
      d.frozen = Boolean(msg.active);
      return { active: d.frozen };
    case "encoder_invalid":
      d.encoderInvalid = Boolean(msg.active);
      return { active: d.encoderInvalid };
    case "seq_jump":
      d.seqJumpPending = Math.trunc(num);
      return { delta: d.seqJumpPending };
    case "silence":
      d.silent = Boolean(msg.active);
      return { active: d.silent };
    default:
      return null;
  }
}

// Canal WebSocket: state (10Hz, se pierde sin drama) y event (numerado,
// persistido antes de enviar) van por canales con politicas opuestas
// (D-13, interfaces/websocket.md).
export function startWsServer(
  httpServer: HttpServer,
  config: RadarConfig,
  store: SignalStore,
  eventLog: EventLog,
  tickLoop: TickLoopHandle,
  modbusMetrics: ModbusTransactionCounter,
  udpEmitter: UdpEncoderEmitter,
  assertionEngine: AssertionEngine,
  scenarioRunner: ScenarioRunner,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });
  // Ultimo resultado conocido de cada asercion: es lo que un paso "assert"
  // de escenario reporta como checkpoint (observabilidad.md#escenarios).
  const latestAssertionResults = new Map<string, AssertionResult>();

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
  store.on("propagation-cut", (e: { id: string; value: unknown; actor: string }) => {
    sendEvent(
      eventLog.log({
        kind: "propagation_cut",
        signal: e.id,
        actor: e.actor,
        payload: { frozen_value: e.value },
      }),
    );
  });
  store.on("propagation-restored", (e: { id: string; actor: string }) => {
    sendEvent(eventLog.log({ kind: "propagation_restored", signal: e.id, actor: e.actor }));
  });

  // Aserciones (fase 3, D-14): el simulador es quien decide pasa/falla,
  // nunca la interfaz.
  assertionEngine.on("result", (r: AssertionResult) => {
    latestAssertionResults.set(r.assertionId, r);
    sendEvent(eventLog.log({ kind: "assertion_result", actor: "simulador", payload: r }));
  });

  // Escenarios (fase 3): cada paso se registra; un paso "assert" adjunta el
  // ultimo resultado conocido de esa asercion como checkpoint.
  scenarioRunner.on("step", (e: ScenarioStepEvent) => {
    if (e.step.action === "assert") {
      const result = e.step.id ? (latestAssertionResults.get(e.step.id) ?? null) : null;
      sendEvent(
        eventLog.log({
          kind: "scenario_assert",
          actor: e.actor,
          payload: { scenario_id: e.scenarioId, assertion_id: e.step.id, result },
        }),
      );
      return;
    }
    sendEvent(
      eventLog.log({
        kind: "scenario_step",
        actor: e.actor,
        payload: { scenario_id: e.scenarioId, step: e.step, index: e.index },
      }),
    );
  });
  scenarioRunner.on("finished", (e: { scenarioId: string }) => {
    sendEvent(eventLog.log({ kind: "scenario_finished", payload: { scenario_id: e.scenarioId } }));
  });
  scenarioRunner.on("aborted", (e: { scenarioId: string; actor: string }) => {
    sendEvent(
      eventLog.log({ kind: "scenario_aborted", actor: e.actor, payload: { scenario_id: e.scenarioId } }),
    );
  });

  const stateTimer = setInterval(() => {
    const signals: Record<string, { v: unknown; m: string; q: string; c?: boolean; by?: string }> = {};
    for (const def of config.signals) {
      const r = store.read(def.id);
      signals[def.id] = {
        v: r.value,
        m: r.mode,
        q: r.quality,
        ...(r.cut ? { c: true } : {}),
        ...(r.forcedBy ? { by: r.forcedBy } : {}),
      };
    }
    broadcast({ type: "state", t_us: nowMonotonicUs(), signals });
  }, 100);

  const metricsTimer = setInterval(() => {
    const d = udpEmitter.degradation;
    broadcast({
      type: "metrics",
      t_us: nowMonotonicUs(),
      modbus_tx_per_s: modbusMetrics.takeAndReset(),
      tick_deviation_ms: Number(tickLoop.lastDeviationMs().toFixed(2)),
      // Estado real del servidor, no lo que el cliente cree haber mandado:
      // la demo comparte sesion entre varios operadores (contexto.md).
      degradation: {
        loss_probability: d.lossProbability,
        burst_active: d.burstUntilUs !== null,
        duplicate_probability: d.duplicateProbability,
        reorder_window_ms: d.reorderWindowMs,
        jitter_max_ms: d.jitterMaxMs,
        frozen: d.frozen,
        encoder_invalid: d.encoderInvalid,
        silent: d.silent,
      },
      scenario: {
        running: scenarioRunner.isRunning(),
        id: scenarioRunner.currentScenarioId(),
      },
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
        case "propagation": {
          if (!msg.signal || !store.has(msg.signal)) return;
          if (msg.cut) store.cutPropagation(msg.signal, msg.actor);
          else store.restorePropagation(msg.signal, msg.actor);
          break;
        }
        case "degrade": {
          const payload = applyDegradation(udpEmitter, msg);
          if (!payload) return;
          sendEvent(eventLog.log({ kind: `degrade_${msg.kind}`, actor: msg.actor, payload }));
          break;
        }
        case "scenario": {
          if (msg.action === "start" && msg.id) {
            const result = scenarioRunner.start(msg.id, msg.actor);
            if (!result.ok) {
              sendEvent(
                eventLog.log({
                  kind: "scenario_rejected",
                  actor: msg.actor,
                  payload: { scenario_id: msg.id, error: result.error },
                }),
              );
            }
          } else if (msg.action === "abort") {
            const result = scenarioRunner.abort(msg.actor);
            if (!result.ok) {
              sendEvent(
                eventLog.log({ kind: "scenario_rejected", actor: msg.actor, payload: { error: result.error } }),
              );
            }
          }
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
