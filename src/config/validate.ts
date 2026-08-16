import type { RadarConfig, SignalDef } from "./types.js";
import { Graph, AXIS_BLOCK_TYPE } from "../core/graph.js";
import { AxisBlock } from "../core/axis.js";
import { compileExpr, collectIdentifiers } from "../core/expr.js";

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
  const encoderUdp = config.transports.encoder_udp;
  const encoderRefs: Array<[string, string | undefined]> = [
    ["azimuth_signal", encoderUdp.azimuth_signal],
    ["elevation_signal", encoderUdp.elevation_signal],
    ["az_rate_signal", encoderUdp.az_rate_signal],
    ["el_rate_signal", encoderUdp.el_rate_signal],
    ["az_fault_signal", encoderUdp.az_fault_signal],
    ["el_fault_signal", encoderUdp.el_fault_signal],
  ];
  for (const [field, signalId] of encoderRefs) {
    if (signalId !== undefined && !signalIds.has(signalId)) {
      issues.push(`/transports/encoder_udp/${field}: "${signalId}" no existe en signals[]`);
    }
  }

  // Bloques: toda señal que un bloque lee o produce debe existir en
  // signals[]. Sin esto, una referencia mal escrita no se detecta al cargar
  // sino que revienta el proceso el primer tick que evalue ese bloque (bug
  // real encontrado en fase 3, ver D-26).
  const blockIds = new Set<string>();
  config.blocks.forEach((block, i) => {
    const path = `/blocks/${i}`;
    if (blockIds.has(block.id)) {
      issues.push(`${path}/id: "${block.id}" duplicado`);
    }
    blockIds.add(block.id);

    try {
      const axis = block.type === AXIS_BLOCK_TYPE ? new AxisBlock(block, config) : null;
      const reads = axis ? axis.readsSignals() : Graph.readsFor(block);
      const produces = axis ? axis.producedSignals() : Graph.producesFor(block);
      for (const signal of reads) {
        if (!signalIds.has(signal)) {
          issues.push(`${path}: lee "${signal}", que no existe en signals[]`);
        }
      }
      for (const signal of produces) {
        if (!signalIds.has(signal)) {
          issues.push(`${path}: produce "${signal}", que no existe en signals[]`);
        }
      }
    } catch (e) {
      issues.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Aserciones (fase 3): a lo sumo un campo de tiempo; "when" obligatorio
  // salvo tipo "never" (ningun campo de tiempo); expresiones validas y sus
  // señales existen.
  const assertionIds = new Set<string>();
  config.assertions.forEach((a, i) => {
    const path = `/assertions/${i}`;
    if (assertionIds.has(a.id)) {
      issues.push(`${path}/id: "${a.id}" duplicado`);
    }
    assertionIds.add(a.id);

    const timingFields = [a.within_ms, a.not_before_ms, a.stable_for_ms].filter((v) => v !== undefined);
    if (timingFields.length > 1) {
      issues.push(
        `${path}: solo puede tener uno de within_ms/not_before_ms/stable_for_ms, tiene ${timingFields.length}`,
      );
    }
    if (timingFields.length > 0 && !a.when) {
      issues.push(`${path}/when: requerido cuando hay within_ms/not_before_ms/stable_for_ms`);
    }

    try {
      const sources: string[] = [a.expect];
      if (a.when) sources.push(a.when);
      for (const src of sources) {
        const ast = compileExpr(src);
        for (const id of collectIdentifiers(ast)) {
          if (!signalIds.has(id)) {
            issues.push(`${path}: referencia "${id}", que no existe en signals[]`);
          }
        }
      }
    } catch (e) {
      issues.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Escenarios (fase 3): cada paso referencia una señal existente y trae
  // los campos que exige su "action"; los pasos "assert" referencian una
  // asercion declarada.
  const scenarioIds = new Set<string>();
  config.scenarios.forEach((sc, i) => {
    const scPath = `/scenarios/${i}`;
    if (scenarioIds.has(sc.id)) {
      issues.push(`${scPath}/id: "${sc.id}" duplicado`);
    }
    scenarioIds.add(sc.id);

    sc.steps.forEach((step, j) => {
      const path = `${scPath}/steps/${j}`;
      if (step.signal && !signalIds.has(step.signal)) {
        issues.push(`${path}/signal: "${step.signal}" no existe en signals[]`);
      }
      switch (step.action) {
        case "force":
          if (!step.signal) issues.push(`${path}: action "force" requiere "signal"`);
          if (step.value === undefined) issues.push(`${path}: action "force" requiere "value"`);
          break;
        case "release":
          if (!step.signal) issues.push(`${path}: action "release" requiere "signal"`);
          break;
        case "pulse":
          if (!step.signal) issues.push(`${path}: action "pulse" requiere "signal"`);
          if (step.ms === undefined) issues.push(`${path}: action "pulse" requiere "ms"`);
          break;
        case "assert":
          if (!step.id) issues.push(`${path}: action "assert" requiere "id"`);
          else if (!assertionIds.has(step.id)) {
            issues.push(`${path}/id: "${step.id}" no existe en assertions[]`);
          }
          break;
      }
    });
  });

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}
