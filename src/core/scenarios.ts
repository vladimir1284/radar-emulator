import { EventEmitter } from "node:events";
import type { ScenarioDef, ScenarioStep } from "../config/types.js";
import type { SignalStore } from "./signal-store.js";

export type StartResult = { ok: true } | { ok: false; error: string };

export interface ScenarioStepEvent {
  scenarioId: string;
  step: ScenarioStep;
  index: number;
  actor: string;
}

// Motor de escenarios (fase 3): pasos temporizados contra el reloj real via
// setTimeout, actuando directamente sobre el SignalStore (force/release,
// igual que haria un operador a mano). "El trabajo exploratorio del
// operador es manual... los escenarios son para pruebas repetibles"
// (observabilidad.md#escenarios): por eso "pulse" usa force+release, no un
// mecanismo aparte — es literalmente lo que un operador haria. Emite
// "step"/"finished"/"aborted", igual patron que SignalStore/AssertionEngine.
export class ScenarioRunner extends EventEmitter {
  private running: {
    def: ScenarioDef;
    actor: string;
    timers: ReturnType<typeof setTimeout>[];
  } | null = null;

  constructor(
    private readonly store: SignalStore,
    private readonly scenarios: ScenarioDef[],
  ) {
    super();
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  currentScenarioId(): string | null {
    return this.running?.def.id ?? null;
  }

  start(scenarioId: string, actor: string): StartResult {
    if (this.running) {
      return { ok: false, error: `ya hay un escenario en curso: "${this.running.def.id}"` };
    }
    const def = this.scenarios.find((s) => s.id === scenarioId);
    if (!def) {
      return { ok: false, error: `escenario "${scenarioId}" no existe` };
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    this.running = { def, actor, timers };

    for (const [index, step] of def.steps.entries()) {
      timers.push(setTimeout(() => this.runStep(def.id, step, index, actor), step.at_ms));
    }
    const lastAtMs = def.steps.reduce((max, s) => Math.max(max, s.at_ms), 0);
    timers.push(setTimeout(() => this.finish(def.id), lastAtMs + 20));

    return { ok: true };
  }

  abort(actor: string): StartResult {
    if (!this.running) {
      return { ok: false, error: "no hay escenario en curso" };
    }
    const id = this.running.def.id;
    for (const t of this.running.timers) clearTimeout(t);
    this.running = null;
    this.emit("aborted", { scenarioId: id, actor });
    return { ok: true };
  }

  stopAll(): void {
    if (this.running) {
      for (const t of this.running.timers) clearTimeout(t);
      this.running = null;
    }
  }

  private runStep(scenarioId: string, step: ScenarioStep, index: number, actor: string): void {
    if (this.running?.def.id !== scenarioId) return; // abortado antes de llegar aca
    switch (step.action) {
      case "force":
        this.store.force(step.signal!, step.value!, actor);
        break;
      case "release":
        this.store.release(step.signal!, actor);
        break;
      case "pulse": {
        this.store.force(step.signal!, true, actor);
        const releaseTimer = setTimeout(() => {
          if (this.running?.def.id === scenarioId) this.store.release(step.signal!, actor);
        }, step.ms!);
        this.running.timers.push(releaseTimer);
        break;
      }
      case "assert":
        break; // quien escucha "step" decide como registrar el checkpoint
    }
    this.emit("step", { scenarioId, step, index, actor } satisfies ScenarioStepEvent);
  }

  private finish(scenarioId: string): void {
    if (this.running?.def.id !== scenarioId) return;
    this.running = null;
    this.emit("finished", { scenarioId });
  }
}
