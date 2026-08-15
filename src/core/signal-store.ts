import { EventEmitter } from "node:events";
import type { RadarConfig, SignalDef } from "../config/types.js";
import type { ExprContext } from "./expr.js";

export type SignalQuality = "ok" | "uninit" | "range";
export type SignalMode = "auto" | "forced";
export type SignalValue = boolean | number;

export interface SignalReading {
  value: SignalValue;
  quality: SignalQuality;
  mode: SignalMode;
  cut: boolean;
}

interface SignalRuntime {
  def: SignalDef;
  // Lo que produciria el automatismo: escritura del controlador (DO/AO) o
  // salida de un bloque (fase 2). Sigue corriendo aunque este forzada
  // (docs/arquitectura/senales-modos.md#el-bloque-productor-sigue-corriendo).
  shadow: SignalValue;
  forcedValue: SignalValue | null;
  mode: SignalMode;
}

function inRange(def: SignalDef, value: SignalValue): boolean {
  if (!def.range) return true;
  const [min, max] = def.range;
  return typeof value === "number" && value >= min && value <= max;
}

// Mapa de señales del nucleo. tick() aplica escrituras del controlador y
// deja que quien orqueste el lazo (tick-loop) le pase un callback para
// evaluar el grafo de bloques (fase 2) entre medio.
export class SignalStore extends EventEmitter {
  private readonly signals = new Map<string, SignalRuntime>();
  private readonly pendingWrites = new Map<string, SignalValue>();
  // rising() compara contra esto; sembrado con "initial" (D-19): el primer
  // tick no es un caso especial.
  private readonly previousTickValues = new Map<string, SignalValue>();
  // Señal -> valor congelado en el instante del corte. Los CONSUMIDORES del
  // grafo ven este valor, no el real, mientras dure el corte
  // (docs/arquitectura/senales-modos.md#cortar-la-propagacion-es-una-capacidad-no-un-fallo).
  private readonly propagationCutValues = new Map<string, SignalValue>();
  private tickCount = 0;

  constructor(config: RadarConfig) {
    super();
    for (const def of config.signals) {
      this.signals.set(def.id, {
        def,
        shadow: def.initial,
        forcedValue: def.mode === "forced" ? def.initial : null,
        mode: def.mode,
      });
      this.previousTickValues.set(def.id, def.initial);
    }
  }

  private require(id: string): SignalRuntime {
    const s = this.signals.get(id);
    if (!s) throw new Error(`Señal desconocida: "${id}"`);
    return s;
  }

  has(id: string): boolean {
    return this.signals.has(id);
  }

  read(id: string): SignalReading {
    const s = this.require(id);
    const value = s.mode === "forced" ? (s.forcedValue as SignalValue) : s.shadow;
    const quality: SignalQuality = inRange(s.def, value) ? "ok" : "range";
    return { value, quality, mode: s.mode, cut: this.propagationCutValues.has(id) };
  }

  // Valor que ve un CONSUMIDOR dentro del grafo: el congelado si esta
  // cortada la propagacion, si no el real (que ya respeta forzado, D-09).
  readForPropagation(id: string): SignalValue {
    const cut = this.propagationCutValues.get(id);
    return cut !== undefined ? cut : this.read(id).value;
  }

  // Llamado por el adaptador Modbus (o cualquier otro transporte) al recibir
  // una escritura desde el controlador. No se aplica de inmediato: el flanco
  // se consume en el siguiente tick (D-15), para que un pulso mas corto que
  // el tick no se pierda por una segunda escritura en el mismo tick... salvo
  // que la segunda escritura llegue antes de que el tick drene la cola, en
  // cuyo caso gana la ultima (limitacion conocida, ver interfaces/modbus.md).
  writeFromController(id: string, value: SignalValue): void {
    const s = this.require(id);
    if (s.def.direction !== "from_controller") {
      throw new Error(
        `"${id}" no es from_controller (${s.def.direction}): el controlador no puede escribirla`,
      );
    }
    this.pendingWrites.set(id, value);
  }

  // Llamado por el evaluador de grafo (fase 2): la salida de un bloque
  // siempre actualiza "shadow", forzada o no la señal (D-08).
  setProduced(id: string, value: SignalValue): void {
    this.require(id).shadow = value;
  }

  force(id: string, value: SignalValue, actor: string): void {
    const s = this.require(id);
    s.mode = "forced";
    s.forcedValue = value;
    this.emit("forced", { id, value, actor, tick: this.tickCount });
  }

  // Liberacion instantanea: value salta a shadow en el mismo tick, sin rampa
  // (docs/arquitectura/senales-modos.md#la-liberacion-es-instantanea).
  release(id: string, actor: string): void {
    const s = this.require(id);
    s.mode = "auto";
    s.forcedValue = null;
    this.emit("released", { id, value: s.shadow, actor, tick: this.tickCount });
  }

  cutPropagation(id: string, actor: string): void {
    this.require(id); // valida que exista
    const frozen = this.read(id).value;
    this.propagationCutValues.set(id, frozen);
    this.emit("propagation-cut", { id, value: frozen, actor, tick: this.tickCount });
  }

  restorePropagation(id: string, actor: string): void {
    if (!this.propagationCutValues.has(id)) return;
    this.propagationCutValues.delete(id);
    this.emit("propagation-restored", { id, actor, tick: this.tickCount });
  }

  // Contexto de lectura para el evaluador de expresiones (src/core/expr.ts):
  // "current" respeta forzado y corte de propagacion; "previous" es el
  // valor efectivo al final del tick anterior (para rising()).
  exprContext(): ExprContext {
    return {
      current: (id) => this.readForPropagation(id),
      previous: (id) => this.previousTickValues.get(id) ?? this.require(id).def.initial,
    };
  }

  // Lazo de tick: aplica flancos pendientes, evalua el grafo de bloques (si
  // se pasa evaluador), y sella el snapshot que usara rising() en el
  // proximo tick. Sin evaluador (fase 1, blocks:[]) es identico al de antes.
  tick(evaluateBlocks?: (store: SignalStore) => void): void {
    this.tickCount += 1;
    for (const [id, value] of this.pendingWrites) {
      const s = this.require(id);
      s.shadow = value;
      // Se registra al aplicar, no al recibir el datagrama (observabilidad.md#registro-de-eventos).
      this.emit("applied-write", { id, value, tick: this.tickCount });
    }
    this.pendingWrites.clear();

    evaluateBlocks?.(this);

    for (const [id] of this.signals) {
      this.previousTickValues.set(id, this.read(id).value);
    }
    this.emit("tick", this.tickCount);
  }
}
