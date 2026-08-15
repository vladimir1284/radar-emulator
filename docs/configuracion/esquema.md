# Esquema JSON

La configuración define **qué radar existe**. Nada de lo que hay aquí está cableado en el
código: cambiar de radar es cambiar de fichero
([D-07](../alcance/decisiones.md#d-07-los-subsistemas-son-espacios-de-nombres-no-tipos)).

!!! danger "Esta página describe la forma real de `rd100s.seed.json`, no un diseño aparte"
    Una versión anterior de esta página describía un esquema distinto (`signals` como
    diccionario, `meta`/`modbus`/`expressions` en la raíz) que **nunca coincidió** con la
    semilla real de 116 señales ya escrita. Se decidió que manda la semilla
    ([PEND-23](../alcance/pendientes.md#pend-23-esquemamd-describia-una-forma-que-no-es-la-de-la-semilla)):
    esta página documenta la forma en la que carga y valida el código, no una aspiración.

!!! note "Se escribe a mano"
    El JSON se escribe y se edita a mano. Eso obliga a que el esquema sea verboso y explícito, y
    a que la **validación produzca errores legibles** con la ruta exacta del nodo culpable. Un
    editor gráfico es un proyecto en sí mismo y no entra en la fase 1
    ([Editor de configuración](../ui/editor.md)).

## Estructura de primer nivel

```json
{
  "schema_version": 1,
  "name": "RD100S",
  "description": "...",
  "tick_ms": 50,
  "rate_groups": { "main": 50, "fast": 10 },
  "subsystems": [ { "id": "tx", "label": "Transmitter" } ],
  "transports": {
    "modbus_tcp": { "...": "unit IDs y parametros del servidor" },
    "encoder_udp": { "...": "stream de posicion" }
  },
  "signals": [ { "...": "una entrada por señal, no un diccionario" } ],
  "blocks": [ { "...": "instancias de la biblioteca de comportamiento" } ]
}
```

!!! important "`blocks` puede estar vacío, `signals` y `transports` no"
    Una configuración con `signals` y `transports.modbus_tcp` completos y **`blocks: []`** debe
    cargar y servir. Ese es el objetivo de la fase 1: conectar el controlador y verificar el
    mapeo antes de que exista modelo físico alguno.

    No hay clave `expressions` separada: el enlace declarativo entre señales es un `type` más
    dentro de `blocks` (`"type": "expression"`), no una sección propia
    ([PEND-24](../alcance/pendientes.md#pend-24-blocks-absorbe-expressions-d-06-describe-una-particion-que-no-existe)).
    Ninguno de los dos (`blocks` ni el `type: "expression"` que contiene) se evalúa en fase 1.

## `signals`

Array, no diccionario. Cada entrada lleva su propio `id` con el subsistema como prefijo; el
prefijo no tiene semántica en el código.

### Campos comunes

| Campo | Obligatorio | Notas |
|---|---|---|
| `id` | sí | `"tx.hv_voltage"`, único en todo el array |
| `label` | sí | Texto mostrado en la interfaz |
| `subsystem` | sí | Debe existir en `subsystems[].id` |
| `kind` | sí | `DI`, `DO`, `AI`, `AO`, `VIRT` |
| `type` | sí | `bool`, `int`, `float` |
| `direction` | sí | `to_controller`, `from_controller`, `internal` |
| `initial` | sí | Valor al cargar |
| `mode` | sí | `auto` o `forced` de fábrica |
| `modbus` | sí | `null` solo para `kind: "VIRT"`; obligatorio en el resto |
| `units`, `range` | analógicas y `VIRT` numéricas | Unidades de ingeniería, `[min, max]` |
| `raw` | `AI`/`AO` | Codificación de borde |
| `source_module`, `source_channel` | no | Trazabilidad contra el Apéndice G, no la usa el código |
| `enabled` | sí | |

`kind` fija `modbus.space` (`DI`/`DO` → `coil`, `AI`/`AO` → `holding`) y `modbus.access`
(`DI`/`AI` → `r`, `DO`/`AO` → `rw`); el validador rechaza la carga si no coinciden.

### Señal digital de entrada (`DI`, solo lectura)

```json
{
  "id": "tx.tx_on_status",
  "label": "Tx On Status",
  "subsystem": "tx",
  "kind": "DI",
  "type": "bool",
  "direction": "to_controller",
  "initial": false,
  "mode": "auto",
  "modbus": { "unit_id": 1, "space": "coil", "address": 0, "conventional": "000001", "access": "r" },
  "source_module": "ADAM 4051",
  "source_channel": "DI0",
  "enabled": true
}
```

### Señal digital de salida (`DO`, comando del controlador)

```json
{
  "id": "tx.turn_on_tx_command",
  "kind": "DO",
  "direction": "from_controller",
  "modbus": { "unit_id": 3, "space": "coil", "address": 16, "conventional": "000017", "access": "rw" }
}
```

Los comandos que aparecen en pares mutuamente excluyentes (`turn_on_tx_command` /
`turn_off_tx_command`) no llevan metadato de "par" en el JSON: son dos señales `DO`
independientes y el par se interpreta con `rising(...)` dentro de un bloque `state_machine`
(fase 2), no en el esquema
([D-15](../alcance/decisiones.md#d-15-los-comandos-se-detectan-por-flanco-no-por-nivel)). En
fase 1, sin bloques, el adaptador Modbus solo encola la escritura para el siguiente tick; no
interpreta el par.

### Señal analógica (`AI`/`AO`)

```json
{
  "id": "tx.mps_output_voltage_sample",
  "kind": "AI",
  "type": "float",
  "units": "kV",
  "range": [0.0, 30.0],
  "raw": { "encoding": "int16", "raw_range": [0, 65535], "note": "PEND-06" },
  "modbus": { "unit_id": 4, "space": "holding", "address": 0, "conventional": "400001", "access": "r" }
}
```

**El núcleo trabaja siempre en unidades de ingeniería.** `raw` lo consume únicamente el
adaptador Modbus, en el borde
([D-16](../alcance/decisiones.md#d-16-el-nucleo-trabaja-en-unidades-de-ingenieria)). El
escalado es lineal entre `range` y `raw_range`; `raw_range` puede ser unipolar (`[0, 65535]`) o
bipolar (`[-32768, 32767]`), y el borde Modbus convierte a la palabra sin signo de 16 bits que
exige la trama en ambos casos.

### Señal virtual (`VIRT`, sin mapeo Modbus)

```json
{
  "id": "ant.az_position",
  "kind": "VIRT",
  "direction": "internal",
  "units": "deg",
  "range": [0.0, 360.0],
  "modbus": null
}
```

Producida por un bloque (fase 2, p.ej. `axis`), consumida por el emisor UDP de encoder u otros
bloques. Sin bloques (fase 1) se sostiene en su `initial` hasta que un operador la fuerce.

!!! warning "Direccionamiento convencional contra de cable"
    `address` es **base 0**, la que viaja en la trama. `conventional` es la de cinco o seis
    dígitos del manual de Advantech, base 1: `conventional == address + 1` en `coil`,
    `conventional == 400000 + address + 1` en `holding`. El validador comprueba esta relación
    para las 116 señales y rechaza la carga si no cuadra.

## `blocks`

Instancias de la biblioteca de comportamiento. Detalle en
[Biblioteca de bloques](bloques.md). **No se evalúan en fase 1.**

```json
{
  "id": "tx.fsm",
  "type": "state_machine",
  "rate_group": "main",
  "params": { "initial": "OFF", "states": ["OFF", "STARTING", "..."], "transitions": ["..."] }
}
```

`rate_group` referencia una clave de `rate_groups` (fase 2, para el lazo de ejes a 10 ms vs el
resto a 50 ms — [D-10](../alcance/decisiones.md#d-10-tick-de-50-ms-integrador-de-ejes-a-10-ms));
no todos los bloques de la semilla lo declaran hoy. `params` es específico de cada `type` y no
se valida en fase 1 más allá de que sea un objeto.

## `transports.modbus_tcp`

```json
{
  "enabled": true,
  "bind": "0.0.0.0",
  "port": 502,
  "units": [ { "unit_id": 1, "label": "tx/ADAM 4051" } ]
}
```

Cada `unit_id` referenciado desde `signals[].modbus.unit_id` debe existir en esta lista. Ver
[Mapa Modbus](../interfaces/modbus.md) para el porqué de diez unit IDs y la colisión de
direcciones entre módulos.

## `transports.encoder_udp`

```json
{
  "enabled": true,
  "spec": "RD100S-ENC-UDP v1",
  "dest_host": "controller",
  "dest_port": 5100,
  "src_port": 0,
  "rate_hz": 100,
  "azimuth_signal": "ant.az_position",
  "elevation_signal": "ant.el_position",
  "az_rate_signal": "ant.az_rate",
  "el_rate_signal": "ant.el_rate",
  "az_fault_signal": "ant.i2t_drive_az_status",
  "el_fault_signal": "ant.i2t_drive_el_status"
}
```

Los seis `*_signal` deben referenciar señales existentes en `signals[]`; `az_fault_signal` y
`el_fault_signal` son opcionales (fase 2, no están en la especificación normativa original —
determinan los bits `AZ_FAULT`/`EL_FAULT` del paquete UDP sin cablear en código qué señal
concreta del RD100S los produce, ver [AGENTS.md](../../AGENTS.md)). La semilla solo declara
`az_fault_signal`: no hay bloque `i2t` de elevación todavía, así que `EL_FAULT` queda siempre en
cero. Definido en la
[especificación normativa](../interfaces/udp-encoder.md#8-configuracion-en-el-emulador).

## Validación

La carga es **todo o nada**. Una configuración con un solo error no se aplica parcialmente
(`src/config/load.ts`).

1. Conformidad con el esquema estructural (Ajv, `src/config/schema.ts`).
2. Por señal: `subsystem` existe, `modbus` presente si y solo si `kind != "VIRT"`,
   `modbus.unit_id` existe en `transports.modbus_tcp.units[]`, `access`/`space` coinciden con
   `kind`, `raw` presente en analógicas.
3. Colisiones de dirección: mismo `unit_id` + `space` + `address` en dos señales.
4. Consistencia entre `address` y `conventional`.
5. Referencias de `transports.encoder_udp.*_signal` contra `signals[]`.

Los mensajes llevan **ruta del nodo culpable** (`/signals/12/modbus/address`, etc). Con un
fichero escrito a mano y del tamaño de la semilla del RD100S, un error sin ubicación cuesta más
que el propio error.

!!! note "Lo que no se valida todavía"
    Sin `expressions` como sección propia, no hay grafo de dependencias que revisar en fase 1
    (no aplica el paso "ausencia de ciclos" de versiones anteriores de esta página). Tampoco se
    valida la coherencia de pares de comandos por flanco (`turn_on_x`/`turn_off_x`): no hay
    metadato de "par" en el esquema real, así que no hay nada que comprobar hasta que exista el
    bloque `state_machine` que los interpreta (fase 2).
