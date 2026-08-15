import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { EventLog } from "../src/log/event-log.js";
import { createHttpServer, type ReloadResult } from "../src/adapters/http/static-server.js";
import { buildRuntime, teardownRuntime, type Runtime } from "../src/runtime.js";

// Smoke test visual real (navegador headless), no solo backend. Requiere
// `pnpm exec playwright install chromium` una vez por maquina.
const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;
const DATA_DIR = new URL("../data", import.meta.url).pathname;
const DB_PATH = `${DATA_DIR}/emulator-smoke-ui.sqlite`;
const HTTP_PORT = 18091;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });

  const eventLog = new EventLog(DB_PATH);
  // let, no const: createHttpServer necesita el getState de abajo antes de
  // que buildRuntime pueda asignar runtime (createHttpServer a su vez debe
  // existir antes de buildRuntime, que le cuelga el WebSocketServer).
  // eslint-disable-next-line prefer-const
  let runtime: Runtime;
  const reload = async (): Promise<ReloadResult> => ({ ok: false, error: "no usado en este smoke" });
  const httpServer = createHttpServer(
    PUBLIC_DIR,
    eventLog,
    () => ({ config: runtime.config, configHash: runtime.configHash }),
    reload,
  );
  runtime = buildRuntime(CONFIG_PATH, httpServer, eventLog);
  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, resolve));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("dialog", (dialog) => dialog.accept());

    await page.goto(`http://127.0.0.1:${HTTP_PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500); // primer "state" por WS

    const sessionText = await page.locator("#session-info").innerText();
    assert(sessionText.includes("sesion"), `session-info no muestra sesion: "${sessionText}"`);
    console.log("session-info OK:", sessionText);

    const rowCount = await page.locator(".signal-row").count();
    assert(rowCount === runtime.config.signals.length, `esperaba ${runtime.config.signals.length} filas, hay ${rowCount}`);
    console.log("filas de señales OK:", rowCount);

    await page.fill("#actor-input", "smoke-ui");
    const firstRow = page.locator(".signal-row").first();
    await firstRow.locator("button", { hasText: "alternar" }).click();
    await page.waitForTimeout(300);

    const forcedClass = await firstRow.getAttribute("class");
    assert(forcedClass?.includes("forced"), `fila no quedo marcada "forced": ${forcedClass}`);

    const forceBtn = firstRow.locator("button", { hasText: "alternar" });
    const releaseBtn = firstRow.locator("button", { hasText: "liberar" });
    const forceBox = await forceBtn.boundingBox();
    const releaseBox = await releaseBtn.boundingBox();
    assert(forceBox && releaseBox, "no se pudo medir los botones");
    assert(
      releaseBox!.x >= forceBox!.x + forceBox!.width - 1,
      `boton "liberar" se solapa con "alternar": force=${JSON.stringify(forceBox)} release=${JSON.stringify(releaseBox)}`,
    );
    console.log("botones forzar/liberar no se solapan: OK");

    const eventLogText = await page.locator("#event-log").innerText();
    assert(eventLogText.includes("force"), `event-log no muestra el evento de forzado: "${eventLogText}"`);
    console.log("event-log refleja el forzado: OK");

    await page.click("#release-all-btn");
    await page.waitForTimeout(300);
    const countersAfter = await page.locator("#counters").innerText();
    assert(countersAfter.startsWith("0 señal"), `liberar todas no dejo el contador en 0: "${countersAfter}"`);
    console.log("liberar todas: OK");

    assert(consoleErrors.length === 0, `errores de consola/pagina: ${consoleErrors.join(" | ")}`);
    console.log("sin errores de consola: OK");

    console.log("\nUI smoke (Playwright): fin sin errores no esperados.");
  } finally {
    await browser.close();
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
