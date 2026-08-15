# Esquema JSON

La configuración define **qué radar existe**. Nada de lo que hay aquí está cableado en el
código: cambiar de radar es cambiar de fichero
([D-07](../alcance/decisiones.md#d-07-los-subsistemas-son-espacios-de-nombres-no-tipos)).

!!! note "Se escribe a mano"
    En la versión actual el JSON se escribe y se edita a mano. Eso obliga a que el esquema sea
    verboso y explícito, y a que la **validación produzca errores legibles** con la ruta exacta
    del nodo culpable. Un editor gráfico es un proyecto en sí mismo y no entra en la fase 1
    ([Editor de configuración](../ui/editor.md)).

## Estructura de primer nivel

```json
{
  "meta":        { "...": "identidad y versión de la configuración" },
  "signals":     { "...": "qué señales existen y cómo se mapean al exterior" },
  "blocks":      { "...": "instancias de la biblioteca de comportamiento" },
  "expressions": { "...": "enlaces entre señales y bloques" },
  "modbus":      { "...": "unit IDs y parámetros del servidor" },
  "encoder_udp": { "...": "stream de posición" }
}
```

!!! important "`blocks` y `expressions` pueden estar vacíos"
    Una configuración con `signals` y `modbus` completos y **cero bloques** debe cargar y
    servir. Ese es exactamente el objetivo de la fase 1: conectar el controlador y verificar el
    mapeo antes de que exista modelo físico alguno. Es la razón de que la configuración esté
    partida en tres ([D-06](../alcance/decisiones.md#d-06-la-configuracion-es-json-en-tres-partes)).

## `meta`

```json
{
  "meta": {
    "id": "rd100s",
    "name": "Radar meteorológico RD100S",
    "version": "0.1.0",
    "spec_udp": "RD100S-ENC-UDP v1"
  }
}
```

La sesión de registro se identifica por **hash del JSON aplicado**, lo que permite saber
después con qué radar exacto se corrió cada prueba. `version` es informativa; el hash es lo
vinculante.

## `signals`

Clave por nombre completo, con el subsistema como prefijo. El prefijo no tiene semántica en el
código.

### Señal digital

```json
{
  "tx.radome_closed_status": {
    "type": "bool",
    "label": "Radome Closed Status",
    "io": "di",
    "modbus": { "unit": 1, "space": "0X", "address": 3, "conventional": "00004" },
    "initial": true
  }
}
```

### Señal analógica

```json
{
  "tx.hv_voltage": {
    "type": "float",
    "label": "HV Voltage",
    "io": "ai",
    "units": "kV",
    "range": [0.0, 30.0],
    "modbus": { "unit": 4, "space": "4X", "address": 0, "conventional": "40001" },
    "raw": {
      "encoding": "int16",
      "raw_range": [0, 65535],
      "note": "PEND-06: confirmar Type Code y rango crudo del modulo real"
    },
    "initial": 0.0
  }
}
```

**El núcleo trabaja siempre en unidades de ingeniería.** El bloque `raw` lo consume únicamente
el adaptador Modbus, en el borde
([D-16](../alcance/decisiones.md#d-16-el-nucleo-trabaja-en-unidades-de-ingenieria)).

### Comando por flanco

```json
{
  "tx.turn_on_tx_command": {
    "type": "bool",
    "label": "Turn On Tx Command",
    "io": "do",
    "edge": { "pair": "tx.turn_off_tx_command", "precedence": "off" },
    "modbus": { "unit": 3, "space": "0X", "address": 16, "conventional": "00017" }
  }
}
```

`precedence: "off"` hace explícita la regla de estado seguro
([D-15](../alcance/decisiones.md#d-15-los-comandos-se-detectan-por-flanco-no-por-nivel)). No
está implícita en el código.

### Campos comunes

| Campo | Obligatorio | Notas |
|---|---|---|
| `type` | sí | `bool`, `int`, `float` |
| `label` | sí | Texto mostrado en la interfaz |
| `io` | sí | `di`, `do`, `ai`, `ao`, o `internal` |
| `modbus` | no | Ausente en señales `internal`, que no salen al exterior |
| `units`, `range` | analógicas | Unidades de ingeniería |
| `raw` | analógicas con `modbus` | Codificación de borde |
| `initial` | sí | Valor al cargar; sin él la señal arranca en calidad `uninit` |
| `edge` | comandos | Par mutuamente excluyente y precedencia |

!!! warning "Direccionamiento convencional contra de cable"
    `address` es **base 0**, la que viaja en la trama. `conventional` es la de cinco dígitos del
    manual de Advantech, base 1, y existe para poder cotejar con la documentación durante la
    puesta a punto. El validador debe comprobar que ambas son consistentes y rechazar la carga
    si no lo son: es un error de transcripción muy fácil de cometer y muy caro de diagnosticar.

## `blocks`

Instancias de la biblioteca de comportamiento. Detalle en
[Biblioteca de bloques](bloques.md).

```json
{
  "blocks": {
    "tx.heater_timer": {
      "kind": "delay_on",
      "params": { "ms": 180000, "note": "PEND-10" },
      "input": "tx.filament_on",
      "output": "tx.heater_ready"
    }
  }
}
```

La señal nombrada en `output` es la que el bloque produce. Es lo que va a `shadow` cuando esa
señal está forzada
([Modos de señal](../arquitectura/senales-modos.md#el-bloque-productor-sigue-corriendo)).

## `expressions`

Enlaces declarativos entre señales. Sin efectos laterales y sin estado.

```json
{
  "expressions": {
    "tx.interlock_ok_status": {
      "expr": "tx.radome_closed_status and tx.waveguide_pressure_ok and tx.cabinet_blower_ok and tx.magnetron_blower_ok",
      "note": "PEND-12, PEND-13: lista real de condiciones sin confirmar"
    }
  }
}
```

Las expresiones definen el grafo de dependencias. **Un ciclo es un error de carga**, con el
ciclo concreto en el mensaje ([Núcleo](../arquitectura/nucleo.md#orden-de-evaluacion)).

## `modbus`

```json
{
  "modbus": {
    "port": 502,
    "units": [1, 2, 3, 4, 11, 12, 13, 14, 21, 31],
    "read_only_write_response": "exception"
  }
}
```

`read_only_write_response` fija qué ocurre si el controlador escribe sobre una coil de entrada:
responder excepción, nunca aceptar en silencio. Ver [Modbus TCP](../interfaces/modbus.md).

## `encoder_udp`

Definido en la [especificación normativa](../interfaces/udp-encoder.md#8-configuracion-en-el-emulador).
Las señales de origen son configurables, lo que permite alimentar el stream desde una señal
forzada manualmente sin tocar código.

## Validación

La carga es **todo o nada**. Una configuración con un solo error no se aplica parcialmente.

El validador comprueba, en este orden, parando en el primer grupo con errores:

1. Conformidad con el esquema estructural.
2. Referencias: toda señal nombrada en `blocks`, `expressions` y `encoder_udp` existe.
3. Colisiones de dirección Modbus dentro de un mismo `unit`.
4. Consistencia entre `address` y `conventional`.
5. Coherencia de `edge`: el par existe y se declara mutuamente.
6. Ausencia de ciclos en el grafo de expresiones.

Los mensajes llevan **ruta JSON del nodo culpable**. Con un fichero escrito a mano y del tamaño
de la semilla del RD100S, un error sin ubicación cuesta más que el propio error.
