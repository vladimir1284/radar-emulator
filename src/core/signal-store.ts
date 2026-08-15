import { EventEmitter } from "node:events";
import type { RadarConfig, SignalDef } from "../config/types.js";

export type SignalQuality = "ok" | "uninit" | "range";
export type SignalMode = "auto" | "forced";
export type SignalValue = boolean | number;

export interface SignalReading {
  value: SignalValue;
  quality: SignalQuality;
  mode: SignalMode;
}

interface SignalRuntime {
  def: SignalDef;
  // Lo que produciria el automatismo: en fase 1, sin bloques, es simplemente
  // el ultimo valor escrito por el controlador (DO/AO) o el valor inicial
  // (DI/AI/VIRT, sin productor todavia). Sigue corriendo aunque este forzada
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

// Mapa de señales del nucleo. Fase 1: sin grafo de bloques/expresiones (ver
// fases.md#fase-1), asi que "auto" para DI/AI/VIRT solo puede sostener el
// valor inicial hasta que un operador fuerce, y para DO/AO lo produce el
// propio flanco del controlador.
export class SignalStore extends EventEmitter {
  private readonly signals = new Map<string, SignalRuntime>();
  private readonly pendingWrites = new Map<string, SignalValue>();
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
    return { value, quality, mode: s.mode };
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

  // Lazo de tick: drena las escrituras del controlador hacia "shadow". Sin
  // evaluacion de grafo (fase 1, fases.md#fase-1-mapeo-verificable-de-extremo-a-extremo).
  tick(): void {
    this.tickCount += 1;
    for (const [id, value] of this.pendingWrites) {
      const s = this.require(id);
      s.shadow = value;
      // Se registra al aplicar, no al recibir el datagrama (observabilidad.md#registro-de-eventos).
      this.emit("applied-write", { id, value, tick: this.tickCount });
    }
    this.pendingWrites.clear();
    this.emit("tick", this.tickCount);
  }
}
