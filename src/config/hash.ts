import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Identificador de sesion: hash del JSON aplicado, no de un objeto ya
// parseado (evita que el orden de claves tras JSON.parse/stringify cambie el
// hash). docs/configuracion/esquema.md#meta.
export function hashConfigFile(path: string): string {
  const raw = readFileSync(path);
  return createHash("sha256").update(raw).digest("hex");
}
