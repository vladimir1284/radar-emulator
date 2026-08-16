import { mkdirSync, rmSync } from "node:fs";
import { WebSocket } from "ws";
import { EventLog } from "../src/log/event-log.js";
import { createHttpServer, type ReloadResult } from "../src/adapters/http/static-server.js";
import { buildRuntime, teardownRuntime, type Runtime } from "../src/runtime.js";

// Corre el escenario normativo de docs/implementacion/observabilidad.md
// ("blower-fail-and-reset") contra el runtime real completo, exactamente
// como lo dispararia un operador desde la UI, y verifica que la asercion
// asociada ("hv-drop-on-interlock") resuelve PASS.
const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const DB_PATH = `${DATA_DIR}/emulator-smoke-scenario.sqlite`;
const HTTP_PORT = 18097;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WsMsg {
  type: string;
  kind?: string;
  payload?: Record<string, unknown>;
  scenario?: { running: boolean; id: string | null };
}

class MessageQueue {
  private readonly buffer: WsMsg[] = [];
  constructor(ws: WebSocket) {
    ws.on("message", (raw: Buffer) => this.buffer.push(JSON.parse(raw.toString())));
  }
  waitFor(predicate: (m: WsMsg) => boolean, timeoutMs = 4000): Promise<WsMsg> {
    return new Promise((resolve, reject) => {
      const tryConsume = () => {
        const idx = this.buffer.findIndex(predicate);
        if (idx === -1) return false;
        const [msg] = this.buffer.splice(idx, 1);
        resolve(msg!);
        return true;
      };
      if (tryConsume()) return;
      const poll = setInterval(() => {
        if (tryConsume()) clearInterval(poll);
      }, 20);
      setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`timeout esperando mensaje (buffer: ${JSON.stringify(this.buffer)})`));
      }, timeoutMs);
    });
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });

  const eventLog = new EventLog(DB_PATH);
  // let, no const: mismo motivo que scripts/smoke-ui.ts.
  // eslint-disable-next-line prefer-const
  let runtime: Runtime;
  const reload = async (): Promise<ReloadResult> => ({ ok: false, error: "no usado en este smoke" });
  const httpServer = createHttpServer(
    new URL("../public", import.meta.url).pathname,
    eventLog,
    () => ({ config: runtime.config, configHash: runtime.configHash }),
    reload,
  );
  runtime = buildRuntime(CONFIG_PATH, httpServer, eventLog);
  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, resolve));

  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`);
  const queue = new MessageQueue(ws);

  try {
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await queue.waitFor((m) => m.type === "session");

    // Precondicion realista: un operador deja las 5 condiciones de interlock
    // restantes en true (todas menos cb_blower_ok_status, que es la que
    // maneja el propio escenario) para que forzarla a false en el paso 0
    // produzca una caida real de tx.interlocks_ok.
    for (const id of [
      "tx.interlock_ok_status",
      "tx.wg_pressure_ok_status",
      "tx.magnetron_blower_ok_status",
      "tx.pha_seq_ok_status",
      "tx.duty_cycle_ok_status",
      "tx.cb_blower_ok_status",
    ]) {
      ws.send(JSON.stringify({ type: "force", actor: "operador-banco", signal: id, value: true }));
    }
    await sleep(300); // dejar que el grafo (50ms) propague tx.interlocks_ok = true

    ws.send(JSON.stringify({ type: "scenario", actor: "op-smoke", action: "start", id: "blower-fail-and-reset" }));

    const step0 = await queue.waitFor((m) => m.type === "event" && m.kind === "scenario_step");
    console.log("scenario_step #0 (force cb_blower_ok_status=false):", JSON.stringify(step0.payload));

    const assertResult = await queue.waitFor((m) => m.type === "event" && m.kind === "assertion_result");
    const payload = assertResult.payload as { assertionId: string; outcome: string; marginMs: number | null };
    assert(payload.assertionId === "hv-drop-on-interlock", `asercion inesperada: ${payload.assertionId}`);
    assert(payload.outcome === "pass", `hv-drop-on-interlock deberia pasar (radiating_status nunca estuvo true), fue "${payload.outcome}"`);
    console.log("assertion_result hv-drop-on-interlock: PASS, margen", payload.marginMs, "ms OK");

    const checkpoint = await queue.waitFor((m) => m.type === "event" && m.kind === "scenario_assert");
    const checkpointPayload = checkpoint.payload as { assertion_id: string; result: { outcome: string } | null };
    assert(checkpointPayload.result !== null, "el checkpoint del escenario deberia encontrar un resultado ya resuelto");
    assert(checkpointPayload.result!.outcome === "pass", "el checkpoint deberia reflejar el mismo resultado (pass)");
    console.log("scenario_step 'assert' (checkpoint) referencia el resultado real: OK");

    const metricsRunning = await queue.waitFor((m) => m.type === "metrics" && m.scenario?.running === true);
    assert(metricsRunning.scenario?.id === "blower-fail-and-reset", "metrics deberia reportar el escenario en curso");
    console.log("metrics reporta el escenario en curso: OK");

    const releaseStep = await queue.waitFor(
      (m) =>
        m.type === "event" &&
        m.kind === "scenario_step" &&
        (m.payload as { step?: { action?: string } })?.step?.action === "release",
      6000,
    );
    console.log("scenario_step 'release' (a los 5000ms): OK", JSON.stringify(releaseStep.payload));

    const pulseStep = await queue.waitFor(
      (m) =>
        m.type === "event" &&
        m.kind === "scenario_step" &&
        (m.payload as { step?: { action?: string } })?.step?.action === "pulse",
      1000,
    );
    console.log("scenario_step 'pulse' (a los 5300ms): OK", JSON.stringify(pulseStep.payload));

    await queue.waitFor((m) => m.type === "event" && m.kind === "scenario_finished", 1000);
    console.log("scenario_finished: OK");

    const metricsIdle = await queue.waitFor((m) => m.type === "metrics" && m.scenario?.running === false);
    assert(metricsIdle.scenario?.id === null, "metrics deberia reportar sin escenario en curso tras terminar");
    console.log("metrics vuelve a reportar sin escenario en curso: OK");

    console.log("\nEscenario E2E (blower-fail-and-reset, runtime real): fin sin errores no esperados.");
  } finally {
    ws.close();
    await teardownRuntime(runtime);
    eventLog.close();
    httpServer.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
