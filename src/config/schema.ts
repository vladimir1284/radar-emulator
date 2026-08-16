// Esquema estructural. Las comprobaciones que cruzan varias señales (colisiones
// de dirección, address vs conventional, referencias) viven en validate.ts:
// Ajv no expresa bien restricciones entre elementos de un array.
export const configSchema = {
  $id: "rd100s-emu-config",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "name",
    "tick_ms",
    "rate_groups",
    "subsystems",
    "transports",
    "signals",
    "blocks",
    "assertions",
    "scenarios",
  ],
  properties: {
    schema_version: { type: "integer", minimum: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    tick_ms: { type: "integer", minimum: 1 },
    rate_groups: {
      type: "object",
      additionalProperties: { type: "integer", minimum: 1 },
    },
    subsystems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
        },
      },
    },
    transports: {
      type: "object",
      additionalProperties: false,
      required: ["modbus_tcp", "encoder_udp"],
      properties: {
        modbus_tcp: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "bind", "port", "units"],
          properties: {
            enabled: { type: "boolean" },
            bind: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            units: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["unit_id", "label"],
                properties: {
                  unit_id: { type: "integer", minimum: 0, maximum: 255 },
                  label: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        encoder_udp: {
          type: "object",
          additionalProperties: false,
          required: [
            "enabled",
            "spec",
            "dest_host",
            "dest_port",
            "src_port",
            "rate_hz",
            "azimuth_signal",
            "elevation_signal",
            "az_rate_signal",
            "el_rate_signal",
          ],
          properties: {
            enabled: { type: "boolean" },
            spec: { type: "string", minLength: 1 },
            dest_host: { type: "string", minLength: 1 },
            dest_port: { type: "integer", minimum: 0, maximum: 65535 },
            src_port: { type: "integer", minimum: 0, maximum: 65535 },
            rate_hz: { type: "number", exclusiveMinimum: 0 },
            azimuth_signal: { type: "string", minLength: 1 },
            elevation_signal: { type: "string", minLength: 1 },
            az_rate_signal: { type: "string", minLength: 1 },
            el_rate_signal: { type: "string", minLength: 1 },
            az_fault_signal: { type: "string", minLength: 1 },
            el_fault_signal: { type: "string", minLength: 1 },
          },
        },
      },
    },
    signals: {
      type: "array",
      items: { $ref: "#/$defs/signal" },
    },
    blocks: {
      // No evaluados en fase 1 (fuera de alcance, ver fases.md). Esquema
      // deliberadamente laxo: solo forma minima, sin validar "params" por tipo.
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "params"],
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          rate_group: { type: "string", minLength: 1 },
          params: { type: "object" },
        },
      },
    },
    assertions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "expect"],
        properties: {
          id: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          when: { type: "string", minLength: 1 },
          expect: { type: "string", minLength: 1 },
          within_ms: { type: "integer", exclusiveMinimum: 0 },
          not_before_ms: { type: "integer", exclusiveMinimum: 0 },
          stable_for_ms: { type: "integer", exclusiveMinimum: 0 },
        },
      },
    },
    scenarios: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "steps"],
        properties: {
          id: { type: "string", minLength: 1 },
          description: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["at_ms", "action"],
              properties: {
                at_ms: { type: "integer", minimum: 0 },
                action: { enum: ["force", "release", "pulse", "assert"] },
                signal: { type: "string", minLength: 1 },
                value: { type: ["boolean", "number"] },
                ms: { type: "integer", exclusiveMinimum: 0 },
                id: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    },
  },
  $defs: {
    signal: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "label",
        "subsystem",
        "kind",
        "type",
        "direction",
        "initial",
        "mode",
        "modbus",
        "enabled",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 },
        subsystem: { type: "string", minLength: 1 },
        kind: { enum: ["DI", "DO", "AI", "AO", "VIRT"] },
        type: { enum: ["bool", "int", "float"] },
        direction: { enum: ["to_controller", "from_controller", "internal"] },
        initial: { type: ["boolean", "number"] },
        mode: { enum: ["auto", "forced"] },
        units: { type: "string" },
        range: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
        raw: {
          type: "object",
          additionalProperties: false,
          required: ["encoding", "raw_range"],
          properties: {
            encoding: { enum: ["int16"] },
            raw_range: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
            },
            note: { type: "string" },
          },
        },
        modbus: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["unit_id", "space", "address", "conventional", "access"],
              properties: {
                unit_id: { type: "integer", minimum: 0, maximum: 255 },
                space: { enum: ["coil", "holding"] },
                address: { type: "integer", minimum: 0 },
                conventional: { type: "string", pattern: "^[0-9]{5,6}$" },
                access: { enum: ["r", "rw"] },
              },
            },
          ],
        },
        source_module: { type: "string" },
        source_channel: { type: "string" },
        enabled: { type: "boolean" },
      },
    },
  },
} as const;
