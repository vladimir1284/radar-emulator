import type { SignalStore } from "./signal-store.js";

export interface TickLoopHandle {
  stop: () => void;
  // Desviacion (ms) del ultimo intervalo real contra el nominal, para la
  // metrica de calidad de enlace (observabilidad.md#metricas-de-calidad-de-enlace).
  lastDeviationMs: () => number;
}

// El tick nunca bloquea (AGENTS.md): store.tick() (y por lo tanto
// evaluateBlocks) es sincrono, sin I/O.
export function startTickLoop(
  store: SignalStore,
  tickMs: number,
  evaluateBlocks?: (store: SignalStore) => void,
): TickLoopHandle {
  let lastAt = process.hrtime.bigint();
  let deviationMs = 0;

  const handle = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - lastAt) / 1_000_000;
    deviationMs = elapsedMs - tickMs;
    lastAt = now;
    store.tick(evaluateBlocks);
  }, tickMs);

  return {
    stop: () => clearInterval(handle),
    lastDeviationMs: () => deviationMs,
  };
}
