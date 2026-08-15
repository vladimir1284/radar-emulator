import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import type { EventLog } from "../../log/event-log.js";
import type { RadarConfig } from "../../config/types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export interface RuntimeState {
  config: RadarConfig;
  configHash: string;
}

export type ReloadResult = { ok: true } | { ok: false; error: string };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

// SPA ligera servida por el mismo proceso (stack.md#eleccion). Sin
// framework: el alcance de fase 1 (una pagina, un puñado de endpoints) no
// lo justifica. getState() en vez de config fijo: una recarga reemplaza el
// runtime entero (docs/ui/editor.md#la-recarga-arranca-sesion-nueva).
export function createHttpServer(
  publicDir: string,
  eventLog: EventLog,
  getState: () => RuntimeState,
  reload: (configPath?: string) => Promise<ReloadResult>,
): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // "Ver la configuracion cargada" + "ver el hash del JSON aplicado"
    // (docs/ui/editor.md#lo-minimo-que-si-entra-en-la-fase-1).
    if (url.pathname === "/api/config" && req.method === "GET") {
      const { config, configHash } = getState();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...config, config_hash: configHash }));
      return;
    }

    // "Recargar configuracion desde fichero" (docs/ui/editor.md). Todo o
    // nada: si el fichero no valida, el runtime en marcha no se toca.
    if (url.pathname === "/api/config/reload" && req.method === "POST") {
      let configPath: string | undefined;
      try {
        const body = await readBody(req);
        if (body.trim()) configPath = (JSON.parse(body) as { path?: string }).path;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "cuerpo invalido" }));
        return;
      }
      const result = await reload(configPath);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname === "/api/session/export") {
      const body = JSON.stringify(
        { session: eventLog.sessionInfo, events: eventLog.exportSessionEvents() },
        null,
        2,
      );
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="session-${eventLog.sessionInfo.id}.json"`,
      });
      res.end(body);
      return;
    }

    const relPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(publicDir, relPath));
    if (!filePath.startsWith(normalize(publicDir))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const data = await readFile(filePath);
      const mime = MIME[extname(filePath)] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
    } catch {
      res.writeHead(500);
      res.end("Error interno");
    }
  });
}
