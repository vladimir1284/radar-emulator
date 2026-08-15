# Registro, aserciones y escenarios

Lo que separa un banco de pruebas de una maqueta bonita. Se construye desde la fase 1.

!!! important "El simulador es el único observador posible"
    El controlador pertenece a otro equipo. El simulador es el **único punto** donde se puede
    registrar la conversación completa con marca de tiempo. Ese registro es la evidencia con la
    que se discutirá cualquier fallo de temporización.

## Reloj

Todo lo que se registre o se emita usa el **reloj monótono del proceso**, en microsegundos desde
el arranque. Nunca la hora de pared.

Un ajuste NTP en el nodo Swarm haría saltar los timestamps hacia atrás en mitad de una prueba y
corrompería la traza. La hora de pared se guarda una sola vez, en el evento de arranque de
sesión, para poder situar la sesión en el calendario.

## Registro de eventos

SQLite en modo WAL. Numeración monótona por sesión. Persistido **antes** de enviar por
WebSocket.

```sql
CREATE TABLE events (
  n         INTEGER PRIMARY KEY,
  t_us      INTEGER NOT NULL,   -- monotono desde arranque
  kind      TEXT    NOT NULL,
  signal    TEXT,
  actor     TEXT,
  payload   TEXT                -- JSON
);
CREATE INDEX idx_events_t   ON events(t_us);
CREATE INDEX idx_events_sig ON events(signal, t_us);
```

Todo evento Modbus registra unit ID, código de función, dirección, valores y el instante en que
el simulador **aplicó** el cambio, no el de recepción del datagrama.

!!! warning "Escrituras fuera del tick"
    `better-sqlite3` es síncrono. Las escrituras se acumulan en un buffer en memoria y se
    vuelcan en lote desde el camino desacoplado. Escribir dentro del lazo de tick introduce
    jitter en la medida que el banco existe para tomar.

### Sesiones

Una sesión abarca desde la carga de configuración hasta la siguiente. Se identifica por hash del
JSON aplicado, lo que permite saber después con qué radar exacto se corrió cada prueba.

Descargable como fichero para adjuntar a un ticket.

## Aserciones

Evaluadas en el simulador contra su reloj monótono
([D-14](../alcance/decisiones.md#d-14-las-aserciones-se-evaluan-en-el-simulador)).

```json
{
  "id": "hv-drop-on-interlock",
  "description": "El HV debe caer en menos de 200 ms tras perder el interlock",
  "when": "falling(tx.interlocks_ok)",
  "expect": "not tx.radiating_status",
  "within_ms": 200
}
```

El instante `t=0` es aquel en que el simulador **aplica** la condición de disparo. El momento
del clic del operador no es medible y no se usa.

El resultado registra el margen medido, no solo aprobado o fallado: saber que el controlador
tardó 190 ms sobre un límite de 200 es información distinta de saber que tardó 20 ms.

Tipos útiles:

| Tipo | Qué comprueba |
|---|---|
| `within_ms` | La condición se cumple antes del plazo |
| `not_before_ms` | La condición **no** se cumple antes del plazo, para verificar retardos deliberados |
| `stable_for_ms` | La condición se mantiene durante el plazo |
| `never` | La condición no se cumple en toda la sesión |

## Escenarios

Secuencias temporizadas en JSON. Existen porque las pruebas de temporización repetibles no se
pueden hacer a mano: el retardo del túnel hace que el clic no sea un instante.

```json
{
  "id": "blower-fail-and-reset",
  "steps": [
    { "at_ms": 0,    "action": "force",   "signal": "tx.cb_blower_ok_status", "value": false },
    { "at_ms": 300,  "action": "assert",  "id": "hv-drop-on-interlock" },
    { "at_ms": 5000, "action": "release", "signal": "tx.cb_blower_ok_status" },
    { "at_ms": 5300, "action": "pulse",   "signal": "tx.reset_faults_command", "ms": 100 }
  ]
}
```

Los tiempos se miden contra el reloj monótono, así que la ejecución es reproducible dentro de la
resolución del tick.

!!! note "El forzado manual sigue siendo el modo principal de trabajo"
    Los escenarios son para pruebas repetibles y regresión. El trabajo exploratorio del operador
    es manual y en caliente, que es como se descubren los comportamientos que luego merece la
    pena convertir en escenario.

## Métricas de calidad de enlace

El simulador contabiliza y expone, para cada sesión: transacciones Modbus por segundo, latencia
entre petición y respuesta, paquetes UDP emitidos y descartados por degradación, y desviación
real de la cadencia respecto a la nominal.

Sirven para responder la pregunta que aparece siempre al analizar un fallo: si el problema fue
del controlador o del banco.
