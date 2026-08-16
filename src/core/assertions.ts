import { EventEmitter } from "node:events";
import { compileExpr, evaluateExpr, type ExprNode } from "./expr.js";
import type { AssertionDef } from "../config/types.js";
import type { SignalStore } from "./signal-store.js";

export type AssertionKind = "within_ms" | "not_before_ms" | "stable_for_ms" | "never";
export type AssertionOutcome = "pass" | "fail";

export interface AssertionResult {
  assertionId: string;
  description: string;
  kind: AssertionKind;
  outcome: AssertionOutcome;
  // Margen medido, no solo pasa/falla (D-14, observabilidad.md#aserciones).
  // Positivo = holgura; negativo/pasado el limite segun el tipo. null para
  // "never", donde "margen" no tiene una unidad de tiempo natural.
  marginMs: number | null;
  triggeredAtUs: number;
  resolvedAtUs: number;
}

interface CompiledAssertion {
  def: AssertionDef;
  kind: AssertionKind;
  durationMs: number | null;
  whenAst: ExprNode | null;
  expectAst: ExprNode;
}

interface ActiveInstance {
  triggeredAtUs: number;
}

function truthy(v: boolean | number): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

function compile(def: AssertionDef): CompiledAssertion {
  let kind: AssertionKind = "never";
  let durationMs: number | null = null;
  if (def.within_ms !== undefined) {
    kind = "within_ms";
    durationMs = def.within_ms;
  } else if (def.not_before_ms !== undefined) {
    kind = "not_before_ms";
    durationMs = def.not_before_ms;
  } else if (def.stable_for_ms !== undefined) {
    kind = "stable_for_ms";
    durationMs = def.stable_for_ms;
  }
  return {
    def,
    kind,
    durationMs,
    whenAst: def.when ? compileExpr(def.when) : null,
    expectAst: compileExpr(def.expect),
  };
}

// Motor de aserciones (fase 3, D-26): evaluado en el simulador contra su
// reloj monotono (D-14), no en la interfaz. Un "when" que dispara mientras
// ya hay una instancia en curso para esa misma asercion se ignora: como
// mucho una instancia activa por asercion a la vez (simplificacion
// deliberada, documentada en D-26).
export class AssertionEngine extends EventEmitter {
  private readonly compiled: CompiledAssertion[];
  private readonly active = new Map<string, ActiveInstance>();
  private readonly prevExpect = new Map<string, boolean>();

  constructor(defs: AssertionDef[]) {
    super();
    this.compiled = defs.map(compile);
  }

  // Llamado desde el tick principal (D-14: se evalua en el simulador, no en
  // la interfaz). Emite "result" con cada AssertionResult resuelto.
  evaluate(store: SignalStore, nowUs: number): void {
    const ctx = store.exprContext();

    for (const a of this.compiled) {
      const expectVal = truthy(evaluateExpr(a.expectAst, ctx));

      if (a.kind === "never") {
        const prev = this.prevExpect.get(a.def.id) ?? false;
        if (!prev && expectVal) {
          this.emit("result", {
            assertionId: a.def.id,
            description: a.def.description,
            kind: "never",
            outcome: "fail",
            marginMs: null,
            triggeredAtUs: nowUs,
            resolvedAtUs: nowUs,
          } satisfies AssertionResult);
        }
        this.prevExpect.set(a.def.id, expectVal);
        continue;
      }

      const whenVal = truthy(evaluateExpr(a.whenAst!, ctx));
      const instance = this.active.get(a.def.id);

      if (!instance) {
        if (!whenVal) continue;
        if (a.kind === "stable_for_ms" && !expectVal) {
          // Nunca llego a estar en el estado esperado: falla en el instante del disparo.
          this.emit("result", {
            assertionId: a.def.id,
            description: a.def.description,
            kind: a.kind,
            outcome: "fail",
            marginMs: 0,
            triggeredAtUs: nowUs,
            resolvedAtUs: nowUs,
          } satisfies AssertionResult);
          continue;
        }
        this.active.set(a.def.id, { triggeredAtUs: nowUs });
        continue;
      }

      const elapsedMs = Number(nowUs - instance.triggeredAtUs) / 1000;
      const durationMs = a.durationMs!;

      switch (a.kind) {
        case "within_ms":
          if (expectVal) {
            this.emit("result", this.resolve(a, instance, nowUs, "pass", durationMs - elapsedMs));
            this.active.delete(a.def.id);
          } else if (elapsedMs >= durationMs) {
            this.emit("result", this.resolve(a, instance, nowUs, "fail", elapsedMs - durationMs));
            this.active.delete(a.def.id);
          }
          break;
        case "not_before_ms":
          if (expectVal) {
            const early = elapsedMs < durationMs;
            const margin = early ? durationMs - elapsedMs : elapsedMs - durationMs;
            this.emit("result", this.resolve(a, instance, nowUs, early ? "fail" : "pass", margin));
            this.active.delete(a.def.id);
          }
          break;
        case "stable_for_ms":
          if (!expectVal) {
            this.emit("result", this.resolve(a, instance, nowUs, "fail", durationMs - elapsedMs));
            this.active.delete(a.def.id);
          } else if (elapsedMs >= durationMs) {
            this.emit("result", this.resolve(a, instance, nowUs, "pass", elapsedMs - durationMs));
            this.active.delete(a.def.id);
          }
          break;
      }
    }
  }

  private resolve(
    a: CompiledAssertion,
    instance: ActiveInstance,
    nowUs: number,
    outcome: AssertionOutcome,
    marginMs: number,
  ): AssertionResult {
    return {
      assertionId: a.def.id,
      description: a.def.description,
      kind: a.kind,
      outcome,
      marginMs: Number(marginMs.toFixed(2)),
      triggeredAtUs: instance.triggeredAtUs,
      resolvedAtUs: nowUs,
    };
  }
}
