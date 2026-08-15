import type { SignalStore } from "./signal-store.js";

// El tick nunca bloquea (AGENTS.md): store.tick() es sincrono, sin I/O.
export function startTickLoop(store: SignalStore, tickMs: number): () => void {
  const handle = setInterval(() => store.tick(), tickMs);
  return () => clearInterval(handle);
}
