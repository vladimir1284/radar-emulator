import { loadConfig } from "../src/config/load.js";
import { SignalStore } from "../src/core/signal-store.js";
import { compileModel } from "../src/core/model.js";

const CONFIG_PATH = new URL("../config/rd100s.seed.json", import.meta.url).pathname;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const { graph, axisBlocks } = compileModel(config);
  console.log(`grafo compilado sin ciclos: ${graph.producedSignals.size} señales producidas por bloques (no-axis)`);
  console.log(`bloques axis: ${axisBlocks.map((a) => a.id).join(", ")}`);

  const store = new SignalStore(config);
  const tick = () => store.tick((s) => graph.evaluate(s));

  // --- Cadena de interlock: expression + expression anidada ---
  tick();
  let interlocksOk = store.read("tx.interlocks_ok").value;
  assert(interlocksOk === false, `interlocks_ok deberia ser false al arrancar (todo false), fue ${interlocksOk}`);

  for (const id of [
    "tx.interlock_ok_status",
    "tx.wg_pressure_ok_status",
    "tx.cb_blower_ok_status",
    "tx.magnetron_blower_ok_status",
    "tx.pha_seq_ok_status",
    "tx.duty_cycle_ok_status",
  ]) {
    store.force(id, true, "smoke");
  }
  tick();
  interlocksOk = store.read("tx.interlocks_ok").value;
  assert(interlocksOk === true, `interlocks_ok deberia ser true tras forzar las 6 condiciones, fue ${interlocksOk}`);
  console.log("cadena de interlock (expression anidada): OK");

  // --- state_machine: OFF -> STARTING por flanco, STARTING -> WARMUP por tiempo ---
  assert(store.read("tx.tx_on_status").value === false, "tx_on_status deberia arrancar false");
  store.writeFromController("tx.turn_on_tx_command", true);
  tick(); // aplica el flanco y evalua: OFF -> STARTING
  assert(store.read("tx.tx_on_status").value === true, "tx_on_status deberia ser true en STARTING");
  assert(store.read("tx.mps_on_status").value === true, "mps_on_status deberia ser true en STARTING");
  console.log("state_machine OFF -> STARTING por rising(): OK");

  store.writeFromController("tx.turn_on_tx_command", false); // el comando es un pulso, se suelta
  tick();

  await sleep(1700); // pasar los 1500ms de STARTING -> WARMUP (tiempo real, D-10 no es virtual)
  tick();
  assert(store.read("tx.ready_status").value === false, "en WARMUP ready_status debe ser false");
  console.log("state_machine STARTING -> WARMUP tras 1500ms reales: OK");

  await sleep(500);
  tick();
  assert(store.read("tx.ready_status").value === false, "no debe haber llegado a READY (180s) en 2.2s reales");
  console.log("state_machine sigue en WARMUP a los ~2.2s (no llega a READY antes de 180s): OK");

  // --- latch reset-dominante ---
  store.force("tx.magnetron_peak_current_sample", 60.0, "smoke");
  tick();
  assert(
    store.read("tx.magnetron_peak_over_current_status").value === true,
    "latch deberia dispararse con corriente 60 > 55",
  );
  store.writeFromController("tx.reset_faults_command", false);
  tick();
  store.writeFromController("tx.reset_faults_command", true);
  tick(); // rising() true, reset gana aunque "set" (60>55) siga siendo verdadero
  assert(
    store.read("tx.magnetron_peak_over_current_status").value === false,
    "reset deberia ganar sobre set (D-21) aunque la corriente siga en 60A",
  );
  console.log("latch reset-dominante (D-21): OK");

  // --- i2t: acumula rapido con corriente muy por encima del umbral ---
  store.force("ant.az_motor_current_sample", 60.0, "smoke"); // umbral 30A, tiempo 5s
  let tripped = false;
  for (let i = 0; i < 2000 && !tripped; i++) {
    tick();
    tripped = store.read("ant.i2t_drive_az_status").value === true;
  }
  assert(tripped, "i2t deberia dispararse con 60A sostenidos contra umbral 30A/5s");
  console.log("i2t dispara con sobrecorriente sostenida: OK");

  store.writeFromController("ant.turn_on_off_au_conmand", false);
  tick();
  store.writeFromController("ant.turn_on_off_au_conmand", true);
  tick();
  assert(
    store.read("ant.i2t_drive_az_status").value === false,
    "i2t deberia resetear con rising(turn_on_off_au_conmand)",
  );
  console.log("i2t resetea con rising(): OK");

  // --- axis: mueve, respeta wrap, respeta inhibit ---
  store.force("ant.au_on_status", true, "smoke");
  store.force("ant.enable_drive_az_conmand", true, "smoke");
  store.writeFromController("ant.speed_reference_driver_az", 5.0); // 5V * 3.6 deg/s/V = 18 deg/s objetivo
  tick();
  const dtFastS = config.rate_groups.fast! / 1000;
  for (let i = 0; i < 500; i++) {
    for (const axis of axisBlocks) axis.step(store, dtFastS);
  }
  const azPosition = store.read("ant.az_position").value as number;
  const azRate = store.read("ant.az_rate").value as number;
  assert(azRate > 17 && azRate <= 18.01, `az_rate deberia converger cerca de 18 deg/s, fue ${azRate}`);
  assert(azPosition >= 0 && azPosition < 360, `az_position deberia estar envuelta en [0,360), fue ${azPosition}`);
  console.log(`axis az: rate=${azRate.toFixed(2)} deg/s, position=${azPosition.toFixed(2)} deg (wrap OK): OK`);

  // el_axis: forzar el limite superior de software y verificar que se detiene
  store.force("ant.au_on_status", true, "smoke");
  store.force("ant.enable_drive_el_conmand", true, "smoke");
  store.writeFromController("ant.speed_reference_driver_el", 10.0);
  tick();
  store.force("ant.el_upper_limit_status", true, "smoke"); // forzado, no por posicion real (nota de la semilla)
  for (let i = 0; i < 200; i++) {
    for (const axis of axisBlocks) axis.step(store, dtFastS);
  }
  const elRate = store.read("ant.el_rate").value as number;
  assert(elRate <= 0, `el_rate deberia detenerse (<=0) con el_upper_limit_status forzado, fue ${elRate}`);
  console.log("axis el: inhibit_up forzado detiene el movimiento (D-23): OK");

  console.log("\nBlocks/graph/axis E2E: fin sin errores no esperados.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR INESPERADO", e);
    process.exit(1);
  });
