# Interfaz WebSocket

Canal entre el simulador y los navegadores conectados. Transporta telemetría de estado, registro
de eventos y las órdenes del operador.

!!! note "No es un contrato con otro equipo"
    A diferencia de [RD100S-ENC-UDP](udp-encoder.md), las dos partes de este canal son de este
    proyecto. Puede evolucionar sin ceremonia de versionado, siempre que servidor e interfaz se
    desplieguen juntos.

## Dos flujos con políticas opuestas

Es la decisión de fondo de esta interfaz
([D-13](../alcance/decisiones.md#d-13-estado-y-eventos-van-por-canales-con-politicas-opuestas)).

| | Telemetría de estado | Registro de eventos |
|---|---|---|
| Cadencia | 10 Hz, snapshot completo | según ocurran |
| Pérdida | tolerada | inaceptable |
| Recuperación | ninguna, el siguiente snapshot corrige | por número de secuencia |
| Orden | irrelevante | estricto |
| Persistencia | ninguna | en disco **antes** de enviar |

Mezclarlos bajo una sola política obliga a sacrificar uno: o se retiene telemetría caduca
esperando confirmación, o se pierden eventos que son la evidencia con la que se discutirá un
fallo con el equipo del controlador.

## Mensajes del servidor

### `state`

Snapshot completo a 10 Hz. Se descarta si el cliente no drena
([D-12](../alcance/decisiones.md#d-12-la-telemetria-nunca-bloquea-el-tick)).

```json
{
  "type": "state",
  "t_us": 128394821,
  "signals": {
    "tx.hv_voltage":  { "v": 24.8, "m": "auto",   "q": "ok" },
    "tx.interlock_ok_status": { "v": false, "m": "forced", "q": "ok", "by": "op-2" }
  }
}
```

Snapshot **completo**, no delta. Un delta exigiría garantía de entrega, que es justo lo que este
canal no da. El coste de reenviar todas las señales a 10 Hz es asumible para el orden de
magnitud de un radar.

### `event`

Numerado y estrictamente ordenado.

```json
{
  "type": "event",
  "n": 4471,
  "t_us": 128394503,
  "kind": "force",
  "signal": "tx.interlock_ok_status",
  "actor": "op-2",
  "payload": { "value": false, "shadow": true }
}
```

### `session`

Enviado al conectar y en cada recarga de configuración: identificador de sesión, hash del JSON
aplicado, hora de pared del arranque, número de operadores conectados.

### `metrics`

Métricas de calidad de enlace, 1 Hz. Implementado hoy: transacciones Modbus por segundo y
desviación real del tick respecto a la nominal. También lleva el estado real de las
degradaciones UDP y del escenario en curso (si hay uno), para que el panel de operación no
tenga que adivinar lo que otro operador ya activó:

```json
{
  "type": "metrics",
  "t_us": 128394821,
  "modbus_tx_per_s": 12,
  "tick_deviation_ms": 0.4,
  "degradation": {
    "loss_probability": 0, "burst_active": false, "duplicate_probability": 0,
    "reorder_window_ms": 0, "jitter_max_ms": 0, "frozen": false,
    "encoder_invalid": false, "silent": false
  },
  "scenario": { "running": true, "id": "blower-fail-and-reset" }
}
```

Latencia de petición a respuesta y paquetes UDP descartados **no están implementados todavía**
(quedan para cuando haya un caso de uso concreto que los necesite).

## Mensajes del cliente

| `type` | Efecto |
|---|---|
| `force` | Pone una señal en modo forzado con el valor dado |
| `release` | Devuelve la señal a automático, con salto instantáneo |
| `propagation` | Corta o restituye la propagación aguas abajo de una señal (`{signal, cut: bool}`) |
| `degrade` | Activa una degradación del stream UDP (`{kind, value}` o `{kind, active}` según el tipo, ver [UDP](udp-encoder.md#9-notas-de-implementacion-fase-2-srcadaptersudpencoderts)) |
| `scenario` | `{action: "start", id}` o `{action: "abort"}` |
| `resume_from` | Pide los eventos posteriores a un número de secuencia |

Todo mensaje del cliente lleva **actor**. No es opcional: con la demo compartiendo estado, un
forzado anónimo hace el registro inservible como evidencia.

### Kinds de `event` por área

No hay una lista cerrada de `kind` (es el nombre del evento, texto libre), pero estos son los
que emite hoy el servidor: `force`, `release`, `controller_write`, `propagation_cut`,
`propagation_restored`, `degrade_loss`, `degrade_burst`, `degrade_duplicate`, `degrade_reorder`,
`degrade_jitter`, `degrade_freeze`, `degrade_encoder_invalid`, `degrade_seq_jump`,
`degrade_silence`, `assertion_result` (payload: `AssertionResult`, ver
[observabilidad.md](../implementacion/observabilidad.md#aserciones)), `scenario_step`,
`scenario_assert` (checkpoint contra el último `assertion_result` conocido),
`scenario_finished`, `scenario_aborted`, `scenario_rejected`.

!!! warning "El cliente pide, no decide"
    Un `force` es una petición. El instante que cuenta es aquel en que el simulador **aplica** el
    cambio, y ese es el que va al evento. El momento del clic no es medible por el retardo
    variable del túnel, y por eso las aserciones se evalúan en el simulador
    ([D-14](../alcance/decisiones.md#d-14-las-aserciones-se-evaluan-en-el-simulador)).

## Reconexión

Al reconectar, el cliente envía `resume_from` con el último `n` recibido y el servidor reenvía
los eventos que falten desde SQLite. La telemetría no se recupera: el primer `state` posterior
ya es correcto por construcción.

Si el hueco es mayor que lo retenido, el servidor responde con un evento de discontinuidad
explícito. **Un hueco silencioso en el registro es peor que un hueco declarado**, porque
invalida la traza entera sin avisar.

## Autenticación

Cloudflare Access está delante ([Despliegue](../arquitectura/despliegue.md#acceso-desde-fuera)).
El identificador de actor se deriva de la identidad que Access propaga; el simulador no
implementa autenticación propia y no debe hacerlo.
