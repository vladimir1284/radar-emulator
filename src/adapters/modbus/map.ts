import type { RadarConfig, SignalDef, ModbusSpace } from "../../config/types.js";

export class ModbusMap {
  private readonly byAddress = new Map<string, SignalDef>();

  constructor(config: RadarConfig) {
    for (const signal of config.signals) {
      if (!signal.modbus) continue;
      const key = ModbusMap.key(signal.modbus.unit_id, signal.modbus.space, signal.modbus.address);
      this.byAddress.set(key, signal);
    }
  }

  private static key(unitId: number, space: ModbusSpace, address: number): string {
    return `${unitId}:${space}:${address}`;
  }

  find(unitId: number, space: ModbusSpace, address: number): SignalDef | undefined {
    return this.byAddress.get(ModbusMap.key(unitId, space, address));
  }
}
