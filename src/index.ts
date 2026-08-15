import { mkdirSync } from "node:fs";
import { ConfigValidationError } from "./config/validate.js";
import { EventLog } from "./log/event-log.js";
import { createHttpServer, type ReloadResult } from "./adapters/http/static-server.js";
import { buildRuntime, teardownRuntime, type Runtime } from "./runtime.js";

const DEFAULT_CONFIG_PATH = process.env.RD100S_CONFIG ?? "config/rd100s.seed.json";
const HTTP_PORT = Number(process.env.RD100S_HTTP_PORT ?? 8080);
const DATA_DIR = process.env.RD100S_DATA_DIR ?? "data";

mkdirSync(DATA_DIR, { recursive: true });

async function main() {
  const eventLog = new EventLog(`${DATA_DIR}/emulator.sqlite`);

  let runtime: Runtime;

  async function reload(configPath?: string): Promise<ReloadResult> {
    const path = configPath ?? runtime.configPath;
    let next: Runtime;
    try {
      next = buildRuntime(path, httpServer, eventLog);
    } catch (e) {
      const message = e instanceof ConfigValidationError ? e.message : String(e);
      console.error("rd100s-emu: recarga rechazada:", message);
      return { ok: false, error: message };
    }
    await teardownRuntime(runtime);
    runtime = next;
    console.log(`rd100s-emu: recarga aplicada, sesion nueva ${eventLog.sessionInfo.id}`);
    return { ok: true };
  }

  const httpServer = createHttpServer(
    "public",
    eventLog,
    () => ({ config: runtime.config, configHash: runtime.configHash }),
    reload,
  );

  runtime = buildRuntime(DEFAULT_CONFIG_PATH, httpServer, eventLog);

  httpServer.listen(HTTP_PORT, () => {
    console.log(`rd100s-emu: panel de operacion en http://0.0.0.0:${HTTP_PORT}`);
    console.log(
      `rd100s-emu: sesion ${eventLog.sessionInfo.id} (config hash ${runtime.configHash.slice(0, 12)}...)`,
    );
  });

  process.on("SIGTERM", async () => {
    await teardownRuntime(runtime);
    eventLog.close();
    httpServer.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("rd100s-emu: fallo al arrancar", e);
  process.exit(1);
});
