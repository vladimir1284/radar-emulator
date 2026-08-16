import type { RadarConfig } from "../config/types.js";
import { Graph, AXIS_BLOCK_TYPE } from "./graph.js";
import { AxisBlock } from "./axis.js";
import { AssertionEngine } from "./assertions.js";

export interface CompiledModel {
  graph: Graph;
  axisBlocks: AxisBlock[];
  assertionEngine: AssertionEngine;
}

// Punto unico de compilacion del modelo fisico (fase 2/3): separa los axis
// (lazo de 10ms, D-10) del resto de bloques (grafo de 50ms, graph.ts), y
// arma el motor de aserciones (fase 3, evaluado en el mismo tick que el
// grafo, D-14).
export function compileModel(config: RadarConfig): CompiledModel {
  const axisBlocks = config.blocks
    .filter((b) => b.type === AXIS_BLOCK_TYPE)
    .map((b) => new AxisBlock(b, config));
  const axisProducedSignals = new Set(axisBlocks.flatMap((a) => a.producedSignals()));
  const graph = Graph.build(config.blocks, axisProducedSignals, config.tick_ms);
  const assertionEngine = new AssertionEngine(config.assertions);
  return { graph, axisBlocks, assertionEngine };
}
