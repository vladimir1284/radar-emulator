export type SignalKind = "DI" | "DO" | "AI" | "AO" | "VIRT";
export type SignalDirection = "to_controller" | "from_controller" | "internal";
export type SignalValueType = "bool" | "int" | "float";
export type ModbusSpace = "coil" | "holding";
export type ModbusAccess = "r" | "rw";

export interface SignalModbusMap {
  unit_id: number;
  space: ModbusSpace;
  address: number;
  conventional: string;
  access: ModbusAccess;
}

export interface SignalRawEncoding {
  encoding: "int16";
  raw_range: [number, number];
  note?: string;
}

export interface SignalDef {
  id: string;
  label: string;
  subsystem: string;
  kind: SignalKind;
  type: SignalValueType;
  direction: SignalDirection;
  initial: boolean | number;
  mode: "auto" | "forced";
  units?: string;
  range?: [number, number];
  raw?: SignalRawEncoding;
  modbus: SignalModbusMap | null;
  source_module?: string;
  source_channel?: string;
  enabled: boolean;
}

export interface ModbusUnitDef {
  unit_id: number;
  label: string;
}

export interface TransportsDef {
  modbus_tcp: {
    enabled: boolean;
    bind: string;
    port: number;
    units: ModbusUnitDef[];
  };
  encoder_udp: {
    enabled: boolean;
    spec: string;
    dest_host: string;
    dest_port: number;
    src_port: number;
    rate_hz: number;
    azimuth_signal: string;
    elevation_signal: string;
    az_rate_signal: string;
    el_rate_signal: string;
    az_fault_signal?: string;
    el_fault_signal?: string;
  };
}

export interface BlockDef {
  id: string;
  type: string;
  rate_group: string;
  params: Record<string, unknown>;
}

// Exactamente uno de within_ms/not_before_ms/stable_for_ms, o ninguno (tipo
// "never", ver docs/implementacion/observabilidad.md#aserciones). El tipo
// se infiere de cual campo esta presente, no hay un campo "type" separado
// (asi es como lo escribe la doc normativa).
export interface AssertionDef {
  id: string;
  description: string;
  when?: string;
  expect: string;
  within_ms?: number;
  not_before_ms?: number;
  stable_for_ms?: number;
}

export type ScenarioStepAction = "force" | "release" | "pulse" | "assert";

export interface ScenarioStep {
  at_ms: number;
  action: ScenarioStepAction;
  signal?: string;
  value?: boolean | number;
  ms?: number;
  id?: string;
}

export interface ScenarioDef {
  id: string;
  description?: string;
  steps: ScenarioStep[];
}

export interface RadarConfig {
  schema_version: number;
  name: string;
  description: string;
  tick_ms: number;
  rate_groups: Record<string, number>;
  subsystems: Array<{ id: string; label: string }>;
  transports: TransportsDef;
  signals: SignalDef[];
  blocks: BlockDef[];
  assertions: AssertionDef[];
  scenarios: ScenarioDef[];
}
