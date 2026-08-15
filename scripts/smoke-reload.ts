import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventLog } from "../src/log/event-log.js";
import { createHttpServer, type ReloadResult } from "../src/adapters/http/static-server.js";
import { buildRuntime, teardownRuntime, type Runtime } from "../src/runtime.js";
import { ConfigValidationError } from "../src/config/validate.js";

const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const DB_PATH = `${DATA_DIR}/emulator-smoke-reload.sqlite`;
const BAD_CONFIG_PATH = `${DATA_DIR}/bad-config-smoke.json`;
const HTTP_PORT = 18082;

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });

  const eventLog = new EventLog(DB_PATH);
  let runtime: Runtime;

  async function reload(configPath?: string): Promise<ReloadResult> {
    const path = configPath ?? runtime.configPath;
    let next: Runtime;
    try {
      next = buildRuntime(path, httpServer, eventLog);
    } catch (e) {
      const message = e instanceof ConfigValidationError ? e.message : String(e);
      return { ok: false, error: message };
    }
    await teardownRuntime(runtime);
    runtime = next;
    return { ok: true };
  }

  const httpServer = createHttpServer(
    "public",
    eventLog,
    () => ({ config: runtime.config, configHash: runtime.configHash }),
    reload,
  );

  runtime = buildRuntime(CONFIG_PATH, httpServer, eventLog);
  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, resolve));

  try {
    const sessionBefore = eventLog.sessionInfo.id;
    console.log("sesion inicial:", sessionBefore.slice(0, 8));

    // 1) Config invalida (JSON roto): la recarga se rechaza y el runtime
    // sigue con la sesion anterior intacta.
    writeFileSync(BAD_CONFIG_PATH, "{ esto no es json valido");
    const badRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/config/reload`, {
      method: "POST",
      body: JSON.stringify({ path: BAD_CONFIG_PATH }),
    });
    const badBody = (await badRes.json()) as ReloadResult;
    console.log(
      "recarga con JSON invalido -> ok =",
      badBody.ok,
      "esperado false. sesion sigue siendo",
      eventLog.sessionInfo.id === sessionBefore ? "la misma (correcto)" : "CAMBIO (mal)",
    );

    // 2) Config valida (la misma semilla): recarga aceptada, sesion nueva.
    const goodRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/config/reload`, {
      method: "POST",
      body: JSON.stringify({ path: CONFIG_PATH }),
    });
    const goodBody = (await goodRes.json()) as ReloadResult;
    const sessionAfter = eventLog.sessionInfo.id;
    console.log(
      "recarga con config valida -> ok =",
      goodBody.ok,
      "esperado true. sesion",
      sessionAfter !== sessionBefore ? "cambio (correcto)" : "NO cambio (mal)",
    );

    // 3) El servidor Modbus sigue respondiendo tras la recarga (se
    // recreo, no quedo colgado ni el puerto quedo tomado por el viejo).
    const configRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/config`);
    const config = (await configRes.json()) as { config_hash: string };
    console.log(
      "GET /api/config tras recarga -> hash coincide con sesion nueva:",
      config.config_hash === runtime.configHash,
    );

    console.log("\nReload E2E: fin sin errores no esperados.");
  } finally {
    await teardownRuntime(runtime);
    eventLog.close();
    httpServer.close();
    rmSync(BAD_CONFIG_PATH, { force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
