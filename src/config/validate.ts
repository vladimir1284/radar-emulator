import type { RadarConfig, SignalDef } from "./types.js";

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuracion invalida (${issues.length} error(es)):\n${issues.join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

function conventionalMatches(signal: SignalDef): boolean {
  const m = signal.modbus;
  if (!m) return true;
  const conv = Number.parseInt(m.conventional, 10);
  if (m.space === "coil") return conv === m.address + 1;
  if (m.space === "holding") return conv === 400_000 + m.address + 1;
  return false;
}

// Validacion todo-o-nada, en el orden que fija docs/configuracion/esquema.md,
// adaptado a la forma real de la semilla (ver D-17bis / nota de esquema.md):
// referencias -> colisiones de direccion -> address vs conventional.
// El esquema real no tiene "expressions" ni campo "edge" por señal, asi que
// esos dos pasos del orden original no aplican aqui.
export function validateConfig(config: RadarConfig): void {
  const issues: string[] = [];

  const subsystemIds = new Set(config.subsystems.map((s) => s.id));
  const unitIds = new Set(config.transports.modbus_tcp.units.map((u) => u.unit_id));
  const signalIds = new Set<string>();

  config.signals.forEach((signal, i) => {
    const path = `/signals/${i}`;

    if (signalIds.has(signal.id)) {
      issues.push(`${path}/id: "${signal.id}" duplicado`);
    }
    signalIds.add(signal.id);

    if (!subsystemIds.has(signal.subsystem)) {
      issues.push(`${path}/subsystem: "${signal.subsystem}" no esta en subsystems[]`);
    }

    const wantsModbus = signal.kind !== "VIRT";
    if (wantsModbus && !signal.modbus) {
      issues.push(`${path}/modbus: señal de kind "${signal.kind}" debe tener mapeo Modbus`);
    }
    if (!wantsModbus && signal.modbus) {
      issues.push(`${path}/modbus: señal VIRT no debe tener mapeo Modbus (debe ser null)`);
    }

    if (signal.modbus) {
      if (!unitIds.has(signal.modbus.unit_id)) {
        issues.push(
          `${path}/modbus/unit_id: ${signal.modbus.unit_id} no esta declarado en transports.modbus_tcp.units[]`,
        );
      }

      const expectedAccess = signal.kind === "DI" || signal.kind === "AI" ? "r" : "rw";
      if (signal.modbus.access !== expectedAccess) {
        issues.push(
          `${path}/modbus/access: "${signal.modbus.access}" no coincide con lo esperado para kind "${signal.kind}" ("${expectedAccess}")`,
        );
      }

      const expectedSpace = signal.kind === "DI" || signal.kind === "DO" ? "coil" : "holding";
      if (signal.modbus.space !== expectedSpace) {
        issues.push(
          `${path}/modbus/space: "${signal.modbus.space}" no coincide con lo esperado para kind "${signal.kind}" ("${expectedSpace}")`,
        );
      }

      if (!conventionalMatches(signal)) {
        issues.push(
          `${path}/modbus/conventional: "${signal.modbus.conventional}" no corresponde a address ${signal.modbus.address} en el espacio "${signal.modbus.space}"`,
        );
      }
    }

    if ((signal.kind === "AI" || signal.kind === "AO") && !signal.raw) {
      issues.push(`${path}/raw: señal analogica con mapeo Modbus requiere "raw"`);
    }
  });

  // Colisiones de direccion dentro de un mismo unit_id.
  const addressOwners = new Map<string, string>();
  config.signals.forEach((signal, i) => {
    if (!signal.modbus) return;
    const key = `${signal.modbus.unit_id}:${signal.modbus.space}:${signal.modbus.address}`;
    const existing = addressOwners.get(key);
    if (existing) {
      issues.push(
        `/signals/${i}/modbus: unit ${signal.modbus.unit_id} espacio ${signal.modbus.space} direccion ${signal.modbus.address} colisiona con "${existing}"`,
      );
    } else {
      addressOwners.set(key, signal.id);
    }
  });

  // Referencias del stream UDP de encoder.
  const encoderRefs: Array<[string, string]> = [
    ["azimuth_signal", config.transports.encoder_udp.azimuth_signal],
    ["elevation_signal", config.transports.encoder_udp.elevation_signal],
    ["az_rate_signal", config.transports.encoder_udp.az_rate_signal],
    ["el_rate_signal", config.transports.encoder_udp.el_rate_signal],
  ];
  for (const [field, signalId] of encoderRefs) {
    if (!signalIds.has(signalId)) {
      issues.push(
        `/transports/encoder_udp/${field}: "${signalId}" no existe en signals[]`,
      );
    }
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}
