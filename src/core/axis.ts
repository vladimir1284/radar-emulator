import { compileExpr, evaluateExpr, collectIdentifiers, type ExprNode } from "./expr.js";
import type { BlockDef, RadarConfig } from "../config/types.js";
import type { SignalStore } from "./signal-store.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Integrador de posicion con aceleracion limitada (D-23). Corre en su
// propio lazo de 10ms (D-10), separado del grafo de 50ms: por eso no
// implementa la misma interfaz que los bloques de graph.ts.
export class AxisBlock {
  readonly id: string;
  private readonly reference: string;
  private readonly enableExpr: ExprNode;
  private readonly gainDegSPerVolt: number;
  private readonly accelDegS2: number;
  private readonly wrap: boolean;
  private readonly limitsDeg?: [number, number];
  private readonly positionSignal: string;
  private readonly rateSignal: string;
  private readonly speedSample: string;
  private readonly currentSample: string;
  private readonly currentStaticA: number;
  private readonly currentPerAccelA: number;
  private readonly inhibitUp?: string;
  private readonly inhibitDown?: string;
  private readonly speedSampleIsRpm: boolean;

  private rateDegS = 0;
  private positionDeg: number;

  constructor(def: BlockDef, config: RadarConfig) {
    const p = def.params as Record<string, unknown>;
    this.id = def.id;
    this.reference = String(p.reference);
    this.enableExpr = compileExpr(String(p.enable));
    this.gainDegSPerVolt = Number(p.gain_deg_s_per_volt);
    this.accelDegS2 = Number(p.accel_deg_s2);
    this.wrap = Boolean(p.wrap);
    this.limitsDeg = p.limits_deg as [number, number] | undefined;
    this.positionSignal = String(p.position_signal);
    this.rateSignal = String(p.rate_signal);
    this.speedSample = String(p.speed_sample);
    this.currentSample = String(p.current_sample);
    this.currentStaticA = Number(p.current_static_a);
    this.currentPerAccelA = Number(p.current_per_accel_a);
    this.inhibitUp = p.inhibit_up as string | undefined;
    this.inhibitDown = p.inhibit_down as string | undefined;

    const speedSampleDef = config.signals.find((s) => s.id === this.speedSample);
    this.speedSampleIsRpm = speedSampleDef?.units === "rpm";

    const positionDef = config.signals.find((s) => s.id === this.positionSignal);
    this.positionDeg = Number(positionDef?.initial ?? 0);
  }

  producedSignals(): string[] {
    return [this.positionSignal, this.rateSignal, this.speedSample, this.currentSample];
  }

  readsSignals(): Set<string> {
    const ids = collectIdentifiers(this.enableExpr);
    ids.add(this.reference);
    if (this.inhibitUp) ids.add(this.inhibitUp);
    if (this.inhibitDown) ids.add(this.inhibitDown);
    return ids;
  }

  step(store: SignalStore, dtS: number): void {
    const ctx = store.exprContext();
    const enabled = Boolean(evaluateExpr(this.enableExpr, ctx));
    const inhibitUp = this.inhibitUp ? Boolean(ctx.current(this.inhibitUp)) : false;
    const inhibitDown = this.inhibitDown ? Boolean(ctx.current(this.inhibitDown)) : false;

    const referenceVolts = enabled ? Number(ctx.current(this.reference)) : 0;
    let targetRateDegS = referenceVolts * this.gainDegSPerVolt;
    if (inhibitUp && targetRateDegS > 0) targetRateDegS = 0;
    if (inhibitDown && targetRateDegS < 0) targetRateDegS = 0;

    const maxDelta = this.accelDegS2 * dtS;
    const delta = clamp(targetRateDegS - this.rateDegS, -maxDelta, maxDelta);
    this.rateDegS += delta;
    const appliedAccelDegS2 = delta / dtS;

    this.positionDeg += this.rateDegS * dtS;
    if (this.wrap) {
      this.positionDeg = ((this.positionDeg % 360) + 360) % 360;
    } else if (this.limitsDeg) {
      const [min, max] = this.limitsDeg;
      if (this.positionDeg > max) {
        this.positionDeg = max;
        this.rateDegS = 0;
      } else if (this.positionDeg < min) {
        this.positionDeg = min;
        this.rateDegS = 0;
      }
    }

    const currentA = this.currentStaticA + this.currentPerAccelA * Math.abs(appliedAccelDegS2);
    const speedSampleValue = this.speedSampleIsRpm ? this.rateDegS / 6 : this.rateDegS;

    store.setProduced(this.positionSignal, this.positionDeg);
    store.setProduced(this.rateSignal, this.rateDegS);
    store.setProduced(this.speedSample, speedSampleValue);
    store.setProduced(this.currentSample, currentA);
  }
}
