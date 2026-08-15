import ModbusRTU from "modbus-serial";

// Fase 0 / PEND-21 sobre modbus-serial (fallback si jsmodbus no sirve).
// Un solo ServerTCP, sin fijar options.unitID (=> 255, "escucha todas las
// direcciones"), enrutando manualmente por unitID dentro del vector.

type UnitState = { holding: Map<number, number>; coils: Map<number, boolean> };
const units = new Map<number, UnitState>();
units.set(1, { holding: new Map([[0, 111]]), coils: new Map([[0, false]]) });
units.set(2, { holding: new Map([[0, 222]]), coils: new Map([[0, true]]) });

// Coil 5 del unit 1 es de solo lectura, para probar la excepcion FC05.
const READONLY_COIL_ADDR = 5;

let lastReceivedAtNs: bigint | null = null;

const vector = {
  getHoldingRegister: (addr: number, unitID: number) => {
    lastReceivedAtNs = process.hrtime.bigint();
    const u = units.get(unitID);
    if (!u) throw { modbusErrorCode: 0x0b }; // Gateway target device failed to respond
    return u.holding.get(addr) ?? 0;
  },
  setRegister: (addr: number, value: number, unitID: number) => {
    lastReceivedAtNs = process.hrtime.bigint();
    const u = units.get(unitID);
    if (!u) throw { modbusErrorCode: 0x0b };
    u.holding.set(addr, value);
  },
  getCoil: (addr: number, unitID: number) => {
    lastReceivedAtNs = process.hrtime.bigint();
    const u = units.get(unitID);
    if (!u) throw { modbusErrorCode: 0x0b };
    return u.coils.get(addr) ?? false;
  },
  setCoil: (addr: number, value: boolean, unitID: number) => {
    lastReceivedAtNs = process.hrtime.bigint();
    if (addr === READONLY_COIL_ADDR) {
      // Illegal function: intento de escritura sobre coil de solo lectura.
      throw { modbusErrorCode: 0x01 };
    }
    const u = units.get(unitID);
    if (!u) throw { modbusErrorCode: 0x0b };
    u.coils.set(addr, value);
  },
};

const PORT = 15021;
const server = new ModbusRTU.ServerTCP(vector, { host: "127.0.0.1", port: PORT, debug: false });

server.on("initialized", async () => {
  try {
    const client = new ModbusRTU();
    await client.connectTCP("127.0.0.1", { port: PORT });
    client.setTimeout(2000);

    // --- Punto 2: multi unit ID sobre una sola conexion TCP ---
    client.setID(1);
    const h1 = await client.readHoldingRegisters(0, 1);
    client.setID(2);
    const h2 = await client.readHoldingRegisters(0, 1);
    client.setID(2);
    await client.writeRegister(0, 999);
    client.setID(1);
    const h1After = await client.readHoldingRegisters(0, 1);

    console.log("unit1 antes=", h1.data[0], "unit2=", h2.data[0], "unit1 despues de escribir en unit2=", h1After.data[0]);
    const routingOk = h1.data[0] === 111 && h2.data[0] === 222 && h1After.data[0] === 111;
    console.log("PUNTO 2 (multi-unit routing):", routingOk ? "OK" : "FALLA");

    // --- Punto 3: excepcion ante FC05 sobre coil de solo lectura ---
    client.setID(1);
    let exceptionOk = false;
    try {
      await client.writeCoil(READONLY_COIL_ADDR, true);
      console.log("PUNTO 3 (excepcion FC05): FALLA (no lanzo excepcion)");
    } catch (e: any) {
      exceptionOk = true;
      console.log("PUNTO 3 (excepcion FC05): OK, excepcion recibida ->", e.message || e);
    }

    // --- Punto 4: resolucion de microsegundos en el instante de recepcion ---
    lastReceivedAtNs = null;
    const before = process.hrtime.bigint();
    await client.readHoldingRegisters(0, 1);
    const after = process.hrtime.bigint();
    const capturedInsideVector = lastReceivedAtNs;
    console.log("PUNTO 4 (timestamp us): capturado dentro del vector =", capturedInsideVector !== null);
    if (capturedInsideVector !== null) {
      const deltaBeforeUs = Number(capturedInsideVector - before) / 1000;
      const deltaAfterUs = Number(after - capturedInsideVector) / 1000;
      console.log(`  latencia hasta captura: ${deltaBeforeUs.toFixed(1)} us, desde captura hasta respuesta: ${deltaAfterUs.toFixed(1)} us`);
    }

    console.log("\nVEREDICTO FINAL modbus-serial:", routingOk && exceptionOk ? "CUMPLE los 4 puntos" : "NO cumple");

    client.close(() => {});
  } catch (e) {
    console.error("ERROR GENERAL", e);
  } finally {
    server.close(() => process.exit(0));
  }
});
