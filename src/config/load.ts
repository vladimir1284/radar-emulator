import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject } from "ajv";
import { configSchema } from "./schema.js";
import { validateConfig, ConfigValidationError } from "./validate.js";
import type { RadarConfig } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateSchema = ajv.compile(configSchema);

function formatAjvErrors(errors: ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath || "/"}: ${e.message}`);
}

// Carga todo-o-nada: un solo error de esquema o de validacion cruzada aborta
// la carga entera (docs/configuracion/esquema.md#validacion).
export function loadConfig(path: string): RadarConfig {
  const raw = readFileSync(path, "utf-8");
  const json: unknown = JSON.parse(raw);

  if (!validateSchema(json)) {
    throw new ConfigValidationError(formatAjvErrors(validateSchema.errors ?? []));
  }

  const config = json as RadarConfig;
  validateConfig(config);
  return config;
}
