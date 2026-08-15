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

// SPA ligera servida por el mismo proceso (stack.md#eleccion). Sin
// framework: el alcance de fase 1 (una pagina, un puñado de endpoints) no
// lo justifica.
export function createHttpServer(
  publicDir: string,
  eventLog: EventLog,
  config: RadarConfig,
  configHash: string,
): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // "Ver la configuracion cargada" + "ver el hash del JSON aplicado"
    // (docs/ui/editor.md#lo-minimo-que-si-entra-en-la-fase-1). La recarga en
    // caliente no esta implementada todavia.
    if (url.pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...config, config_hash: configHash }));
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
