// Reloj monotono del proceso, en microsegundos. Nunca hora de pared
// (AGENTS.md, docs/implementacion/observabilidad.md#reloj).
export function nowMonotonicUs(): number {
  return Number(process.hrtime.bigint() / 1000n);
}
