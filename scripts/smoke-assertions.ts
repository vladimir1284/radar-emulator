import { SignalStore } from "../src/core/signal-store.js";
import { AssertionEngine, type AssertionResult } from "../src/core/assertions.js";
import { nowMonotonicUs } from "../src/core/clock.js";
import type { RadarConfig, SignalDef } from "../src/config/types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Funcion aparte (no comparacion inline) para que TS no se confunda y
// angoste "results.length" a un literal que despues no invalida al mutar
// el array dentro del callback de engine.evaluate().
function countOf(arr: unknown[]): number {
  return arr.length;
}

function makeSignal(id: string, initial: boolean | number): SignalDef {
  return {
    id,
    label: id,
    subsystem: "test",
    kind: "VIRT",
    type: typeof initial === "boolean" ? "bool" : "float",
    direction: "internal",
    initial,
    mode: "auto",
    modbus: null,
    enabled: true,
  };
}

function makeConfig(): RadarConfig {
  return {
    schema_version: 1,
    name: "test",
    description: "",
    tick_ms: 50,
    rate_groups: { main: 50 },
    subsystems: [{ id: "test", label: "Test" }],
    transports: {
      modbus_tcp: { enabled: false, bind: "127.0.0.1", port: 15503, units: [] },
      encoder_udp: {
        enabled: false,
        spec: "x",
        dest_host: "127.0.0.1",
        dest_port: 1,
        src_port: 0,
        rate_hz: 1,
        azimuth_signal: "test.trigger",
        elevation_signal: "test.trigger",
        az_rate_signal: "test.trigger",
        el_rate_signal: "test.trigger",
      },
    },
    signals: [
      makeSignal("test.trigger", false),
      makeSignal("test.expect", false),
      makeSignal("test.forbidden", false),
    ],
    blocks: [],
    assertions: [],
    scenarios: [],
  };
}

async function main() {
  // --- within_ms: pasa si expect llega a tiempo, falla si no llega ---
  {
    const config = makeConfig();
    const store = new SignalStore(config);
    const engine = new AssertionEngine([
      {
        id: "a-within",
        description: "expect debe llegar antes de 150ms",
        when: "rising(test.trigger)",
        expect: "test.expect",
        within_ms: 150,
      },
    ]);
    const results: AssertionResult[] = [];
    engine.on("result", (r) => results.push(r));
    store.force("test.trigger", true, "smoke"); // rising en el siguiente evaluate()
    engine.evaluate(store, nowMonotonicUs());
    await sleep(50);
    store.force("test.expect", true, "smoke");
    engine.evaluate(store, nowMonotonicUs());
    assert(results.length === 1 && results[0]!.outcome === "pass", `within_ms deberia pasar, resultados: ${JSON.stringify(results)}`);
    assert(results[0]!.marginMs! > 0, "margen deberia ser positivo (llego con holgura)");
    console.log("within_ms PASS con margen positivo:", results[0]!.marginMs, "ms OK");
  }
  {
    const config = makeConfig();
    const store = new SignalStore(config);
    const engine = new AssertionEngine([
      { id: "a-within-fail", description: "x", when: "rising(test.trigger)", expect: "test.expect", within_ms: 60 },
    ]);
    const results: AssertionResult[] = [];
    engine.on("result", (r) => results.push(r));
    store.force("test.trigger", true, "smoke");
    engine.evaluate(store, nowMonotonicUs());
    for (let i = 0; i < 5; i++) {
      await sleep(20);
      engine.evaluate(store, nowMonotonicUs());
    }
    assert(results.length === 1 && results[0]!.outcome === "fail", `within_ms deberia fallar, resultados: ${JSON.stringify(results)}`);
    console.log("within_ms FAIL cuando expect no llega a tiempo, margen:", results[0]!.marginMs, "OK");
  }

  // --- not_before_ms: falla si llega antes de tiempo, pasa si llega despues ---
  {
    const config = makeConfig();
    const store = new SignalStore(config);
    const engine = new AssertionEngine([
      { id: "a-notbefore", description: "x", when: "rising(test.trigger)", expect: "test.expect", not_before_ms: 100 },
    ]);
    const results: AssertionResult[] = [];
    engine.on("result", (r) => results.push(r));
    store.force("test.trigger", true, "smoke");
    engine.evaluate(store, nowMonotonicUs());
    await sleep(20);
    store.force("test.expect", true, "smoke"); // demasiado pronto (deadline es 100ms)
    engine.evaluate(store, nowMonotonicUs());
    assert(results.length === 1 && results[0]!.outcome === "fail", `not_before_ms deberia fallar por adelantado: ${JSON.stringify(results)}`);
    console.log("not_before_ms FAIL si llega antes de tiempo: OK");
  }

  // --- stable_for_ms: falla si se rompe antes, pasa si se mantiene ---
  {
    const config = makeConfig();
    const store = new SignalStore(config);
    const engine = new AssertionEngine([
      { id: "a-stable", description: "x", when: "rising(test.trigger)", expect: "test.expect", stable_for_ms: 100 },
    ]);
    const results: AssertionResult[] = [];
    engine.on("result", (r) => results.push(r));
    store.force("test.expect", true, "smoke");
    store.force("test.trigger", true, "smoke");
    engine.evaluate(store, nowMonotonicUs());
    await sleep(30);
    store.force("test.expect", false, "smoke"); // se rompe antes de los 100ms
    engine.evaluate(store, nowMonotonicUs());
    assert(results.length === 1 && results[0]!.outcome === "fail", `stable_for_ms deberia fallar al romperse antes: ${JSON.stringify(results)}`);
    console.log("stable_for_ms FAIL si se rompe antes del plazo: OK");
  }

  // --- never: falla apenas la condicion prohibida se vuelve verdadera ---
  {
    const config = makeConfig();
    const store = new SignalStore(config);
    const engine = new AssertionEngine([
      { id: "a-never", description: "x", expect: "test.forbidden" },
    ]);
    const results: AssertionResult[] = [];
    engine.on("result", (r) => results.push(r));
    engine.evaluate(store, nowMonotonicUs());
    assert(countOf(results) === 0, "never no deberia disparar mientras la condicion prohibida es falsa");
    store.force("test.forbidden", true, "smoke");
    engine.evaluate(store, nowMonotonicUs());
    assert(countOf(results) === 1 && results[0]!.outcome === "fail", `never deberia fallar apenas se vuelve verdadera: ${JSON.stringify(results)}`);
    console.log("never FAIL apenas la condicion prohibida ocurre: OK");
  }

  console.log("\nAssertionEngine: fin sin errores no esperados.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
