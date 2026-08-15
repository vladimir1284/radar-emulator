# Biblioteca de bloques

!!! danger "Esta página describe los bloques reales de la semilla, no una lista aspiracional"
    Una versión anterior enumeraba `delay_on`, `delay_off`, `ramp`, `first_order`, `integrator`,
    `noise`, `threshold` — ninguno usado por ningún bloque real. Se decidió que manda la semilla
    ([D-18](../alcance/decisiones.md#d-18-los-bloques-reales-de-la-semilla-no-son-los-de-bloquesmd-y-eso-manda)):
    esta página documenta los cinco `type` que `config/rd100s.seed.json` usa de verdad, con sus
    parámetros exactos. Implementados en `src/core/graph.ts` (los cuatro que corren en el grafo
    de 50 ms) y `src/core/axis.ts` (el que corre en el lazo de 10 ms).

## Qué es un bloque

Una unidad de comportamiento reutilizable, instanciada desde la configuración con parámetros y
enlazada a señales de entrada y salida. Los bloques son **el único sitio donde vive estado
temporal** del modelo; las expresiones puras (`type: "expression"`) no tienen estado.

Un bloque no conoce el radar: `i2t` no sabe que protege un motor de azimut. Esa es la condición
para que un usuario pueda armar un radar distinto sin tocar código.

## Expresiones (`when`, `expr`, `set`, `reset`, `enable`, `reference`, `inhibit_up`/`inhibit_down`)

Todos los campos de condición de los cinco tipos comparten el mismo lenguaje, implementado en
`src/core/expr.ts` — deliberadamente **sin `eval()`**, la configuración es entrada externa al
proceso aunque se escriba a mano:

```
or  := and ('or' and)*
and := not ('and' not)*
not := 'not' not | cmp
cmp := atom (('>'|'>='|'<'|'<='|'=='|'!=') atom)?
atom := numero | 'rising(' señal ')' | señal | '(' or ')'
```

`rising(señal)` es verdadero solo en el tick donde la señal pasa de falsa a verdadera. El valor
"anterior" se siembra con `initial` en la carga ([D-19](../alcance/decisiones.md#d-19-rising-en-el-primer-tick-se-resuelve-solo-sin-politica-especial)):
el primer tick no es un caso especial.

Un identificador solo (`ant.speed_reference_driver_az`, sin operadores) es una expresión válida:
simplemente lee esa señal. Es lo que usan `axis.reference`, `axis.inhibit_up` e
`axis.inhibit_down`.

## `type: "expression"`

Combinacional puro, sin estado. Se reevalúa entero cada tick.

```json
{
  "id": "tx.interlocks",
  "type": "expression",
  "params": {
    "output": "tx.interlocks_ok",
    "expr": "tx.interlock_ok_status and tx.wg_pressure_ok_status and ..."
  }
}
```

## `type: "latch"`

Enclavamiento con `set`/`reset`. **Reset-dominante** ([D-21](../alcance/decisiones.md#d-21-latch-es-reset-dominante)):
si ambos son verdaderos en el mismo tick, gana `reset`.

```json
{
  "id": "tx.magnetron_oc_latch",
  "type": "latch",
  "params": {
    "output": "tx.magnetron_peak_over_current_status",
    "set": "tx.magnetron_peak_current_sample > 55.0",
    "reset": "rising(tx.reset_faults_command)"
  }
}
```

## `type: "i2t"`

Protección térmica simplificada: acumulador en segundos que crece cuando la corriente supera el
umbral (más rápido cuanto más lo supera) y decae linealmente cuando no
([D-22](../alcance/decisiones.md#d-22-modelo-de-i2t-acumulador-con-calentamiento-cuadratico-y-enfriamiento-lineal)):

```
si corriente > threshold_a:  acc += dt_s * ((corriente/threshold_a)^2 - 1)
si no:                        acc = max(0, acc - dt_s)
output = true cuando acc >= time_s
```

```json
{
  "id": "ant.az_i2t",
  "type": "i2t",
  "params": {
    "current": "ant.az_motor_current_sample",
    "output": "ant.i2t_drive_az_status",
    "threshold_a": 30.0,
    "time_s": 5.0,
    "reset": "rising(ant.turn_on_off_au_conmand)"
  }
}
```

## `type: "state_machine"`

Máquina de estados finitos evaluada cada tick de 50 ms.

```json
{
  "id": "tx.fsm",
  "type": "state_machine",
  "params": {
    "initial": "OFF",
    "states": ["OFF", "STARTING", "WARMUP", "READY", "HV_ON", "RADIATING", "FAULT"],
    "transitions": [
      { "from": "OFF", "to": "STARTING", "when": "rising(tx.turn_on_tx_command) and not tx.turn_off_tx_command" },
      { "from": "STARTING", "to": "WARMUP", "after_ms": 1500 },
      { "from": "*", "to": "OFF", "when": "tx.turn_off_tx_command", "priority": 100 },
      { "from": ["HV_ON", "RADIATING"], "to": "READY", "when": "not tx.interlocks_ok", "priority": 90 }
    ],
    "outputs": {
      "OFF": { "tx.tx_on_status": false, "tx.ready_status": false },
      "STARTING": { "tx.tx_on_status": true }
    }
  }
}
```

- **`from`**: nombre de estado, array de nombres, o `"*"` (cualquier estado). `"*"` es válido
  solo para transiciones genuinamente globales (apagar desde cualquier estado); una transición de
  "protección" que solo tiene sentido desde ciertos estados debe acotar `from` a esos estados
  ([D-24](../alcance/decisiones.md#d-24-bug-real-en-txfsm-la-transicion-de-caida-de-interlock-no-puede-ser--literal),
  encontrado como bug real en la semilla).
- **`when`** o **`after_ms`**: condición de disparo. `after_ms` mide milisegundos reales desde
  que se entró al estado (reloj monótono, no ticks) — congruente con que el lazo de tick corre a
  intervalos reales de 50 ms, no un contador virtual.
- **`priority`**: si varias transiciones aplican al estado actual en el mismo tick, gana la de
  mayor prioridad (por defecto 0). Empate: la primera declarada.
- **`outputs`**: por cada tick que la máquina esté en ese estado, fija esas señales a esos
  valores constantes. Una señal no mencionada en el estado actual conserva lo que ya tenía.

## `type: "axis"`

El único bloque con lazo propio de 10 ms ([D-10](../alcance/decisiones.md#d-10-tick-de-50-ms-integrador-de-ejes-a-10-ms)).
Integrador de posición con aceleración limitada
([D-23](../alcance/decisiones.md#d-23-modelo-del-bloque-axis-aceleracion-limitada-corriente-estatica-mas-proporcional)):

```json
{
  "id": "ant.az_axis",
  "type": "axis",
  "rate_group": "fast",
  "params": {
    "reference": "ant.speed_reference_driver_az",
    "enable": "ant.enable_drive_az_conmand and ant.au_on_status",
    "gain_deg_s_per_volt": 3.6,
    "accel_deg_s2": 12.0,
    "wrap": true,
    "position_signal": "ant.az_position",
    "rate_signal": "ant.az_rate",
    "speed_sample": "ant.az_motor_speed_sample",
    "current_sample": "ant.az_motor_current_sample",
    "current_static_a": 4.0,
    "current_per_accel_a": 1.8
  }
}
```

El eje de elevación agrega `limits_deg: [min, max]` en vez de `wrap: true`, e
`inhibit_up`/`inhibit_down`: señales de fin de carrera que, si están activas, detienen el
movimiento en esa dirección — leídas como **valor de señal** (respeta forzado, D-09), no como
posición real: si un operador fuerza el fin de carrera, el eje se detiene aunque la posición
física no esté en el tope.

`speed_sample` convierte de grados/s a la unidad que declare esa señal en `signals[]`: si es
`"rpm"` divide por 6, si es `"deg/s"` no convierte. `current_sample` es
`current_static_a + current_per_accel_a * |aceleración aplicada|`.

## Cuestiones que ya no están abiertas

Las tres preguntas originales de esta página tenían respuesta una vez que se supo cuáles son los
bloques reales:

- **Primer tick**: resuelto por D-19 (no es un caso especial).
- **Recarga de configuración**: reinicializa todo el estado de los bloques, sin excepciones
  ([D-20](../alcance/decisiones.md#d-20-una-recarga-de-configuracion-reinicializa-todo-el-estado-de-los-bloques)).
- **Determinismo de `noise`**: no aplica — ningún bloque de la semilla usa un generador
  pseudoaleatorio. Si se agrega un bloque así en el futuro, su semilla de PRNG debe ir en la
  configuración y quedar en el registro de sesión.
