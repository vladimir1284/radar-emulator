import { mkdirSync } from "node:fs";
import { loadConfig } from "./config/load.js";
import { hashConfigFile } from "./config/hash.js";
import { SignalStore } from "./core/signal-store.js";
import { startTickLoop } from "./core/tick-loop.js";
import { startModbusServer } from "./adapters/modbus/server.js";
import { ModbusTransactionCounter } from "./adapters/modbus/metrics.js";
import { EventLog } from "./log/event-log.js";
import { createHttpServer } from "./adapters/http/static-server.js";
import { startWsServer } from "./adapters/ws/server.js";

const CONFIG_PATH = process.env.RD100S_CONFIG ?? "config/rd100s.seed.json";
const HTTP_PORT = Number(process.env.RD100S_HTTP_PORT ?? 8080);
const DATA_DIR = process.env.RD100S_DATA_DIR ?? "data";

const config = loadConfig(CONFIG_PATH);
const configHash = hashConfigFile(CONFIG_PATH);

mkdirSync(DATA_DIR, { recursive: true });
const eventLog = new EventLog(`${DATA_DIR}/emulator.sqlite`, configHash, config.tick_ms);

const store = new SignalStore(config);
const tickLoop = startTickLoop(store, config.tick_ms);

const modbusMetrics = new ModbusTransactionCounter();
const modbusServer = startModbusServer(config, store, modbusMetrics);
modbusServer.on("initialized", () => {
  console.log(
    `rd100s-emu: Modbus TCP en ${config.transports.modbus_tcp.bind}:${config.transports.modbus_tcp.port}, ` +
      `${config.signals.length} señales, ${config.transports.modbus_tcp.units.length} unit IDs`,
  );
});
modbusServer.on("serverError", (err) => console.error("modbus serverError", err));
modbusServer.on("socketError", (err) => console.error("modbus socketError", err));

const httpServer = createHttpServer("public", eventLog, config, configHash);
startWsServer(httpServer, config, store, eventLog, tickLoop, modbusMetrics);
httpServer.listen(HTTP_PORT, () => {
  console.log(`rd100s-emu: panel de operacion en http://0.0.0.0:${HTTP_PORT}`);
  console.log(`rd100s-emu: sesion ${eventLog.sessionInfo.id} (config hash ${configHash.slice(0, 12)}...)`);
});

process.on("SIGTERM", () => {
  tickLoop.stop();
  eventLog.close();
  process.exit(0);
});
