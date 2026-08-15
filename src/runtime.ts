import type { ServerTCP } from "modbus-serial";
import type { WebSocketServer } from "ws";
import { loadConfig } from "./config/load.js";
import { hashConfigFile } from "./config/hash.js";
import { SignalStore } from "./core/signal-store.js";
import { startTickLoop, type TickLoopHandle } from "./core/tick-loop.js";
import { startModbusServer } from "./adapters/modbus/server.js";
import { ModbusTransactionCounter } from "./adapters/modbus/metrics.js";
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
  modbusMetrics: ModbusTransactionCounter;
  modbusServer: ServerTCP;
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
// configuracion: store, tick, servidor Modbus, WebSocket. El httpServer y el
// EventLog sobreviven a una recarga; todo lo demas se tira y se rehace.
// Valida antes de tocar nada (loadConfig puede lanzar ConfigValidationError):
// si esto tira, el runtime anterior sigue intacto.
export function buildRuntime(
  configPath: string,
  httpServer: ReturnType<typeof createHttpServer>,
  eventLog: EventLog,
): Runtime {
  const config = loadConfig(configPath);
  const configHash = hashConfigFile(configPath);

  eventLog.beginSession(configHash, config.tick_ms);

  const store = new SignalStore(config);
  const tickLoop = startTickLoop(store, config.tick_ms);
  const modbusMetrics = new ModbusTransactionCounter();
  const modbusServer = startModbusServer(config, store, modbusMetrics);
  attachModbusLogging(modbusServer, config);
  const wss = startWsServer(httpServer, config, store, eventLog, tickLoop, modbusMetrics);

  return { configPath, config, configHash, store, tickLoop, modbusMetrics, modbusServer, wss };
}

export async function teardownRuntime(runtime: Runtime): Promise<void> {
  runtime.tickLoop.stop();
  runtime.wss.close();
  await closeModbusServer(runtime.modbusServer);
}
