import { loadConfig } from "./config/load.js";
import { SignalStore } from "./core/signal-store.js";
import { startTickLoop } from "./core/tick-loop.js";
import { startModbusServer } from "./adapters/modbus/server.js";

const CONFIG_PATH = process.env.RD100S_CONFIG ?? "config/rd100s.seed.json";

const config = loadConfig(CONFIG_PATH);
const store = new SignalStore(config);
startTickLoop(store, config.tick_ms);

store.on("forced", (e) => console.log("forced", e));
store.on("released", (e) => console.log("released", e));

const modbusServer = startModbusServer(config, store);
modbusServer.on("initialized", () => {
  console.log(
    `rd100s-emu: Modbus TCP en ${config.transports.modbus_tcp.bind}:${config.transports.modbus_tcp.port}, ` +
      `${config.signals.length} señales, ${config.transports.modbus_tcp.units.length} unit IDs`,
  );
});
modbusServer.on("serverError", (err) => console.error("modbus serverError", err));
modbusServer.on("socketError", (err) => console.error("modbus socketError", err));
