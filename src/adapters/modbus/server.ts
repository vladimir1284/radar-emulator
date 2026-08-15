import { ServerTCP, type IServiceVector } from "modbus-serial";
import type { RadarConfig, SignalDef, ModbusSpace } from "../../config/types.js";
import type { SignalStore } from "../../core/signal-store.js";
import { ModbusMap } from "./map.js";
import { rawWordToEngineering, engineeringToRawWord } from "./raw-conversion.js";

const ILLEGAL_FUNCTION = 0x01;
const ILLEGAL_DATA_ADDRESS = 0x02;

// Ver interfaces/modbus.md#hallazgos-del-apendice-g: una escritura sobre una
// coil/registro de solo lectura responde excepcion, nunca se acepta en
// silencio. modbus-serial lee "modbusErrorCode" de lo que se lanza (fase 0,
// D-17).
class ModbusException extends Error {
  constructor(
    public readonly modbusErrorCode: number,
    message: string,
  ) {
    super(message);
  }
}

// Enrutado por unit ID resuelto a mano (fase 0 / D-17): modbus-serial no lo
// hace por nosotros. El `unitID` que pasa a cada callback del vector es la
// unica fuente de verdad de a que modulo pertenece el pedido.
export function createModbusVector(config: RadarConfig, store: SignalStore): IServiceVector {
  const map = new ModbusMap(config);

  function findOrThrow(unitId: number, space: ModbusSpace, address: number): SignalDef {
    const signal = map.find(unitId, space, address);
    if (!signal) {
      throw new ModbusException(
        ILLEGAL_DATA_ADDRESS,
        `sin señal mapeada en unit ${unitId} ${space} ${address}`,
      );
    }
    return signal;
  }

  function requireWritable(signal: SignalDef): void {
    if (signal.modbus?.access !== "rw") {
      throw new ModbusException(ILLEGAL_FUNCTION, `"${signal.id}" es de solo lectura`);
    }
  }

  return {
    getCoil: (address: number, unitId: number) => {
      const signal = findOrThrow(unitId, "coil", address);
      return Boolean(store.read(signal.id).value);
    },
    setCoil: (address: number, value: boolean, unitId: number) => {
      const signal = findOrThrow(unitId, "coil", address);
      requireWritable(signal);
      store.writeFromController(signal.id, value);
    },
    getHoldingRegister: (address: number, unitId: number) => {
      const signal = findOrThrow(unitId, "holding", address);
      const reading = store.read(signal.id);
      return engineeringToRawWord(signal, reading.value as number);
    },
    setRegister: (address: number, word: number, unitId: number) => {
      const signal = findOrThrow(unitId, "holding", address);
      requireWritable(signal);
      store.writeFromController(signal.id, rawWordToEngineering(signal, word));
    },
  };
}

export function startModbusServer(config: RadarConfig, store: SignalStore): ServerTCP {
  const vector = createModbusVector(config, store);
  const { bind, port } = config.transports.modbus_tcp;
  // options.unitID sin fijar: por defecto modbus-serial escucha las 255
  // direcciones y deja el filtrado en manos del vector (D-17).
  return new ServerTCP(vector, { host: bind, port });
}
