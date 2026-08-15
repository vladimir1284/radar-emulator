import type { SignalStore } from "./signal-store.js";
import type { AxisBlock } from "./axis.js";
import type { TickLoopHandle } from "./tick-loop.js";

// Lazo de ejes, aislado del lazo principal (D-10): el integrador de
// posicion necesita mas resolucion que el resto del modelo.
export function startAxisLoop(store: SignalStore, axisBlocks: AxisBlock[], intervalMs: number): TickLoopHandle {
  const dtS = intervalMs / 1000;
  let lastAt = process.hrtime.bigint();
  let deviationMs = 0;

  const handle = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - lastAt) / 1_000_000;
    deviationMs = elapsedMs - intervalMs;
    lastAt = now;
    for (const axis of axisBlocks) axis.step(store, dtS);
  }, intervalMs);

  return {
    stop: () => clearInterval(handle),
    lastDeviationMs: () => deviationMs,
  };
}
