import type { RadarConfig } from "../config/types.js";
import { Graph, AXIS_BLOCK_TYPE } from "./graph.js";
import { AxisBlock } from "./axis.js";

export interface CompiledModel {
  graph: Graph;
  axisBlocks: AxisBlock[];
}

// Punto unico de compilacion del modelo fisico (fase 2): separa los axis
// (lazo de 10ms, D-10) del resto de bloques (grafo de 50ms, graph.ts).
export function compileModel(config: RadarConfig): CompiledModel {
  const axisBlocks = config.blocks
    .filter((b) => b.type === AXIS_BLOCK_TYPE)
    .map((b) => new AxisBlock(b, config));
  const axisProducedSignals = new Set(axisBlocks.flatMap((a) => a.producedSignals()));
  const graph = Graph.build(config.blocks, axisProducedSignals, config.tick_ms);
  return { graph, axisBlocks };
}
