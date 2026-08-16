import type { ServerTCP } from "modbus-serial";
import type { WebSocketServer } from "ws";
import { loadConfig } from "./config/load.js";
import { hashConfigFile } from "./config/hash.js";
import { SignalStore } from "./core/signal-store.js";
import { startTickLoop, type TickLoopHandle } from "./core/tick-loop.js";
import { startAxisLoop } from "./core/axis-loop.js";
import { compileModel } from "./core/model.js";
import { ScenarioRunner } from "./core/scenarios.js";
import { nowMonotonicUs } from "./core/clock.js";
import { startModbusServer } from "./adapters/modbus/server.js";
import { ModbusTransactionCounter } from "./adapters/modbus/metrics.js";
import { UdpEncoderEmitter } from "./adapters/udp/encoder.js";
import type { EventLog } from "./log/event-log.js";
import type { createHttpServer } from "./adapters/http/static-server.js";
import { startWsServer } from "./adapters/ws/server.js";
import type { RadarConfig } from "./config/types.js";

export interface Runtime {
  configPath: string;
  config: RadarConfig;
  configHash: string;
  store: SignalStore;
  tickLoop: TickLoopHandle;
  axisLoop: TickLoopHandle;
  modbusMetrics: ModbusTransactionCounter;
  modbusServer: ServerTCP;
  udpEmitter: UdpEncoderEmitter;
  scenarioRunner: ScenarioRunner;
  wss: WebSocketServer;
}

function closeModbusServer(server: ServerTCP): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function attachModbusLogging(server: ServerTCP, config: RadarConfig): void {
  server.on("initialized", () => {
    console.log(
      `rd100s-emu: Modbus TCP en ${config.transports.modbus_tcp.bind}:${config.transports.modbus_tcp.port}, ` +
        `${config.signals.length} señales, ${config.transports.modbus_tcp.units.length} unit IDs`,
    );
  });
  server.on("serverError", (err) => console.error("modbus serverError", err));
  server.on("socketError", (err) => console.error("modbus socketError", err));
}

// Arranca (o rearranca en una recarga) todo lo que depende de la
// configuracion: store, los dos lazos (tick 50ms + ejes 10ms, D-10),
// servidor Modbus, emisor UDP, motor de escenarios, WebSocket. El
// httpServer y el EventLog sobreviven a una recarga; todo lo demas se tira
// y se rehace. Valida antes de tocar nada (loadConfig/compileModel pueden
// lanzar ConfigValidationError/GraphError): si esto tira, el runtime
// anterior sigue intacto.
export function buildRuntime(
  configPath: string,
  httpServer: ReturnType<typeof createHttpServer>,
  eventLog: EventLog,
): Runtime {
  const config = loadConfig(configPath);
  const configHash = hashConfigFile(configPath);
  const { graph, axisBlocks, assertionEngine } = compileModel(config);

  eventLog.beginSession(configHash, config.tick_ms);

  const store = new SignalStore(config);
  const tickLoop = startTickLoop(store, config.tick_ms, (s) => {
    graph.evaluate(s);
    assertionEngine.evaluate(s, nowMonotonicUs());
  });
  const axisLoop = startAxisLoop(store, axisBlocks, config.rate_groups.fast ?? 10);

  const modbusMetrics = new ModbusTransactionCounter();
  const modbusServer = startModbusServer(config, store, modbusMetrics);
  attachModbusLogging(modbusServer, config);

  const udpEmitter = new UdpEncoderEmitter(config, store);
  udpEmitter.start();

  const scenarioRunner = new ScenarioRunner(store, config.scenarios);

  const wss = startWsServer(
    httpServer,
    config,
    store,
    eventLog,
    tickLoop,
    modbusMetrics,
    udpEmitter,
    assertionEngine,
    scenarioRunner,
  );

  return {
    configPath,
    config,
    configHash,
    store,
    tickLoop,
    axisLoop,
    modbusMetrics,
    modbusServer,
    udpEmitter,
    scenarioRunner,
    wss,
  };
}

export async function teardownRuntime(runtime: Runtime): Promise<void> {
  runtime.tickLoop.stop();
  runtime.axisLoop.stop();
  runtime.udpEmitter.stop();
  runtime.scenarioRunner.stopAll();
  runtime.wss.close();
  await closeModbusServer(runtime.modbusServer);
}
