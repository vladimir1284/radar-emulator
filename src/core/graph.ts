import { compileExpr, collectIdentifiers, evaluateExpr, type ExprNode } from "./expr.js";
import { nowMonotonicUs } from "./clock.js";
import type { BlockDef } from "../config/types.js";
import type { SignalStore, SignalValue } from "./signal-store.js";

export class GraphError extends Error {}

interface ExpressionBlock {
  kind: "expression";
  id: string;
  output: string;
  expr: ExprNode;
}
interface LatchBlock {
  kind: "latch";
  id: string;
  output: string;
  set: ExprNode;
  reset: ExprNode;
}
interface I2tBlock {
  kind: "i2t";
  id: string;
  output: string;
  currentSignal: string;
  thresholdA: number;
  timeS: number;
  reset: ExprNode;
  acc: number; // segundos acumulados, estado interno (D-22)
}
interface StateMachineTransition {
  from: string | string[]; // nombre de estado, lista de estados, o "*" (D-24)
  to: string;
  when?: ExprNode;
  afterMs?: number;
  priority: number;
}

function transitionMatchesState(from: string | string[], state: string): boolean {
  if (from === "*") return true;
  if (Array.isArray(from)) return from.includes(state);
  return from === state;
}
interface StateMachineBlock {
  kind: "state_machine";
  id: string;
  states: string[];
  transitions: StateMachineTransition[];
  outputs: Record<string, Record<string, SignalValue>>;
  produces: string[];
  currentState: string;
  enteredAtUs: number;
}

type CompiledGraphBlock = ExpressionBlock | LatchBlock | I2tBlock | StateMachineBlock;

// axis (fase 2) corre en su propio lazo de 10ms (D-10), no en este grafo de
// 50ms: sus señales producidas se registran solo para validar referencias,
// no participan del orden topologico.
export const AXIS_BLOCK_TYPE = "axis";

function producesOf(block: CompiledGraphBlock): string[] {
  switch (block.kind) {
    case "expression":
    case "latch":
    case "i2t":
      return [block.output];
    case "state_machine":
      return block.produces;
  }
}

function readsOf(block: CompiledGraphBlock): Set<string> {
  switch (block.kind) {
    case "expression":
      return collectIdentifiers(block.expr);
    case "latch":
      return collectIdentifiers(block.set, collectIdentifiers(block.reset));
    case "i2t": {
      const ids = collectIdentifiers(block.reset);
      ids.add(block.currentSignal);
      return ids;
    }
    case "state_machine": {
      const ids = new Set<string>();
      for (const t of block.transitions) {
        if (t.when) collectIdentifiers(t.when, ids);
      }
      return ids;
    }
  }
}

function compileBlock(def: BlockDef): CompiledGraphBlock {
  const p = def.params as Record<string, unknown>;
  switch (def.type) {
    case "expression":
      return {
        kind: "expression",
        id: def.id,
        output: String(p.output),
        expr: compileExpr(String(p.expr)),
      };
    case "latch":
      return {
        kind: "latch",
        id: def.id,
        output: String(p.output),
        set: compileExpr(String(p.set)),
        reset: compileExpr(String(p.reset)),
      };
    case "i2t":
      return {
        kind: "i2t",
        id: def.id,
        output: String(p.output),
        currentSignal: String(p.current),
        thresholdA: Number(p.threshold_a),
        timeS: Number(p.time_s),
        reset: compileExpr(String(p.reset)),
        acc: 0,
      };
    case "state_machine": {
      const rawTransitions = p.transitions as Array<{
        from: string | string[];
        to: string;
        when?: string;
        after_ms?: number;
        priority?: number;
      }>;
      const transitions: StateMachineTransition[] = rawTransitions.map((t) => ({
        from: t.from,
        to: t.to,
        when: t.when !== undefined ? compileExpr(t.when) : undefined,
        afterMs: t.after_ms,
        priority: t.priority ?? 0,
      }));
      const outputs = (p.outputs as Record<string, Record<string, SignalValue>>) ?? {};
      const produces = [...new Set(Object.values(outputs).flatMap((o) => Object.keys(o)))];
      return {
        kind: "state_machine",
        id: def.id,
        states: p.states as string[],
        transitions,
        outputs,
        produces,
        currentState: String(p.initial),
        enteredAtUs: nowMonotonicUs(),
      };
    }
    default:
      throw new GraphError(`bloque "${def.id}": type "${def.type}" desconocido para el grafo de 50ms`);
  }
}

// Orden topologico (Kahn) sobre las dependencias señal-productor. Un ciclo
// se rechaza con el ciclo concreto en el mensaje
// (docs/arquitectura/nucleo.md#orden-de-evaluacion).
function topoSort(blocks: CompiledGraphBlock[], producedBy: Map<string, string>): CompiledGraphBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b] as const));
  const deps = new Map<string, Set<string>>(); // blockId -> ids de los que depende
  for (const block of blocks) {
    const depIds = new Set<string>();
    for (const signal of readsOf(block)) {
      const producerId = producedBy.get(signal);
      if (producerId && producerId !== block.id) depIds.add(producerId);
    }
    deps.set(block.id, depIds);
  }

  const sorted: CompiledGraphBlock[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(id: string): void {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id];
      throw new GraphError(`ciclo en el grafo de bloques: ${cycle.join(" -> ")}`);
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const depId of deps.get(id) ?? []) visit(depId);
    stack.pop();
    state.set(id, "done");
    sorted.push(byId.get(id)!);
  }

  for (const block of blocks) visit(block.id);
  return sorted;
}

export class Graph {
  private constructor(
    private readonly blocksInOrder: CompiledGraphBlock[],
    private readonly tickS: number,
    readonly producedSignals: ReadonlySet<string>,
  ) {}

  // axisProducedSignals: señales que produce el lazo de ejes (10ms), para
  // que las referencias de otros bloques no se traten como colgantes ni se
  // metan en el orden topologico de este grafo (D-10). tickMs: periodo real
  // del tick (config.tick_ms), para el acumulador de i2t.
  static build(blockDefs: BlockDef[], axisProducedSignals: Set<string>, tickMs: number): Graph {
    const graphBlocks = blockDefs
      .filter((b) => b.type !== AXIS_BLOCK_TYPE)
      .map((b) => compileBlock(b));

    const producedBy = new Map<string, string>();
    for (const block of graphBlocks) {
      for (const signal of producesOf(block)) {
        const existing = producedBy.get(signal);
        if (existing) {
          throw new GraphError(`señal "${signal}" producida por dos bloques: "${existing}" y "${block.id}"`);
        }
        producedBy.set(signal, block.id);
      }
    }
    for (const signal of axisProducedSignals) {
      if (producedBy.has(signal)) {
        throw new GraphError(`señal "${signal}" producida por axis y por el bloque "${producedBy.get(signal)}"`);
      }
    }

    const sorted = topoSort(graphBlocks, producedBy);
    return new Graph(sorted, tickMs / 1000, new Set(producedBy.keys()));
  }

  // Todas las señales que este bloque lee, para validate.ts (paso 2:
  // referencias) y para reportar errores con ruta legible.
  static readsFor(def: BlockDef): Set<string> {
    return readsOf(compileBlock(def));
  }

  evaluate(store: SignalStore): void {
    const ctx = store.exprContext();
    const nowUs = nowMonotonicUs();

    for (const block of this.blocksInOrder) {
      switch (block.kind) {
        case "expression": {
          store.setProduced(block.output, evaluateExpr(block.expr, ctx));
          break;
        }
        case "latch": {
          const resetNow = Boolean(evaluateExpr(block.reset, ctx));
          const setNow = Boolean(evaluateExpr(block.set, ctx));
          // reset-dominante (D-21).
          const previous = Boolean(ctx.current(block.output));
          const next = resetNow ? false : setNow ? true : previous;
          store.setProduced(block.output, next);
          break;
        }
        case "i2t": {
          const current = Number(ctx.current(block.currentSignal));
          const dtS = this.tickS;
          if (evaluateExpr(block.reset, ctx)) {
            block.acc = 0;
          } else if (current > block.thresholdA) {
            block.acc += dtS * ((current / block.thresholdA) ** 2 - 1);
          } else {
            block.acc = Math.max(0, block.acc - dtS);
          }
          store.setProduced(block.output, block.acc >= block.timeS);
          break;
        }
        case "state_machine": {
          const candidates = block.transitions
            .filter((t) => transitionMatchesState(t.from, block.currentState))
            .sort((a, b) => b.priority - a.priority);
          for (const t of candidates) {
            const elapsedMs = (nowUs - block.enteredAtUs) / 1000;
            const fires =
              t.afterMs !== undefined ? elapsedMs >= t.afterMs : t.when ? Boolean(evaluateExpr(t.when, ctx)) : false;
            if (fires) {
              block.currentState = t.to;
              block.enteredAtUs = nowUs;
              break;
            }
          }
          const outputs = block.outputs[block.currentState];
          if (outputs) {
            for (const [signal, value] of Object.entries(outputs)) store.setProduced(signal, value);
          }
          break;
        }
      }
    }
  }
}
