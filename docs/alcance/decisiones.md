# Decisiones de diseño

Registro de las decisiones tomadas, con el razonamiento que las soporta y las alternativas
descartadas. El agente de desarrollo **no debe revertir ninguna sin discutirlo**, porque varias
tienen consecuencias que no son evidentes desde el punto donde se implementan.

!!! warning "Decisiones reconstruidas"
    D-04 a D-09 se perdieron con la sesión original y están **reconstruidas** a partir del
    razonamiento que las generó, no recuperadas literalmente. Su contenido es fiel al diseño
    pero su redacción y numeración pueden no coincidir con la versión original. D-01 a D-03 y
    D-10 a D-14 sí son literales. D-15 y D-16 son nuevas.

---

## D-01 · Núcleo y adaptador Modbus en el mismo proceso

**Decisión.** El núcleo de simulación, el servidor Modbus TCP y el emisor UDP viven en un
único proceso Node.

**Por qué.** El estado de la simulación es un objeto mutable único gobernado por un lazo de
tick. Si el adaptador Modbus viviera en otro contenedor, cada transacción del controlador
añadiría un salto de red más serialización, introduciendo jitter que no existe en el radar
real y que puede enmascarar o inventar problemas de temporización. El banco mide precisamente
eso, así que contaminar la medida con la propia arquitectura sería un fallo de diseño.

**Descartado.** Microservicios separados comunicándose por red interna.

---

## D-02 · El simulador es `replicas: 1`

**Decisión.** El servicio del simulador nunca se replica.

**Por qué.** Replicarlo parte el estado en dos realidades divergentes. El balanceo mandaría
lecturas a una instancia y escrituras a otra, produciendo comportamientos irreproducibles.

**Consecuencia.** No hay alta disponibilidad. Es aceptable: es un banco de pruebas, no
producción.

---

## D-03 · El puerto 502 no se publica

**Decisión.** Simulador y controlador se hablan por la red overlay de Swarm resolviendo por
nombre de servicio. El 502 no se publica al exterior.

**Por qué.** El controlador es un contenedor del mismo stack. Publicar el puerto añadiría
superficie de ataque —un endpoint Modbus sin autenticación— sin beneficio alguno.

---

## D-04 · El núcleo se escribe en TypeScript

**Decisión.** Núcleo, adaptadores y interfaz en TypeScript. Una sola implementación del modelo.

**Por qué.** El núcleo tiene que convivir con un servidor Modbus, un emisor UDP y un servidor
WebSocket en el mismo proceso ([D-01](#d-01-nucleo-y-adaptador-modbus-en-el-mismo-proceso)).
Escribir el modelo en un lenguaje y los adaptadores en otro obliga a un puente en el camino
caliente. Tipar el esquema de configuración y el estado de señales en el mismo lenguaje que los
consume elimina una clase entera de errores de mapeo.

**Descartado.** Python para el modelo con adaptadores en Node. Dos implementaciones divergen
en semanas.

---

## D-05 · Cloudflare queda como túnel y autenticación, no como runtime

**Decisión.** El núcleo corre exclusivamente en Docker Swarm. Cloudflare aporta el túnel
(`cloudflared`) y Access delante de las interfaces web. No hay una segunda implementación
corriendo en Workers o Durable Objects.

**Por qué.** Dos hechos independientes, cada uno suficiente por sí solo.

Primero, Workers y Durable Objects solo aceptan tráfico entrante HTTP y WebSocket. No existe
listener TCP crudo, así que **no se puede abrir el puerto 502**. Un servidor Modbus TCP nativo
en Cloudflare no es cuestión de configuración: es imposible.

Segundo, y más definitivo, **Workers no puede emitir UDP**. El stream de posición de encoder
([RD100S-ENC-UDP](../interfaces/udp-encoder.md)) es una interfaz nuclear del emulador, no un
extra. Un núcleo corriendo en un Durable Object sería un emulador incompleto por construcción,
incapaz de alimentar el lazo de posición del controlador.

**Consecuencia.** La demo pública no es un despliegue distinto: es el mismo stack de Swarm
expuesto por el túnel. Eso es lo que obliga a que la demo comparta estado.

**Descartado.** Un Durable Object corriendo el mismo núcleo como modo demo, y el bridge local
de Modbus sobre WebSocket que habría hecho falta para sostenerlo.

---

## D-06 · La configuración es JSON en tres partes

**Decisión.** El fichero de configuración se estructura en `signals`, `blocks` y `expressions`.
Las señales declaran qué existe y cómo se mapea al exterior; los bloques instancian
comportamiento de la biblioteca; las expresiones enlazan unos con otros.

**Por qué.** Separar declaración de comportamiento permite cargar una configuración con señales
y mapeo Modbus completos y **cero bloques**, que es exactamente lo que necesita la fase 1. Si el
comportamiento estuviera embebido en la declaración de cada señal, no habría forma de arrancar
sin el modelo físico terminado.

**Consecuencia.** El orden de evaluación no lo fija el orden del fichero, sino el grafo de
dependencias entre expresiones. Un ciclo es un error de carga, no un comportamiento oscilante.

---

## D-07 · Los subsistemas son espacios de nombres, no tipos

**Decisión.** `tx`, `ant`, `rx` y `env` son prefijos de nombre de señal sin semántica en el
código. No existe una clase `Transmitter`.

**Por qué.** El emulador debe permitir que un usuario arme un radar distinto
([Contexto](contexto.md#el-sistema-no-es-especifico-del-rd100s)). Si el subsistema fuera un tipo,
cada radar nuevo exigiría tocar el código. También desaparece cualquier dependencia de los
módulos ADAM como concepto: son solo un mapeo en la semilla.

---

## D-08 · Cada señal está en modo automático o forzado

**Decisión.** Toda señal tiene exactamente dos modos. En **automático** su valor lo produce el
bloque o expresión que la alimenta. En **forzado** lo fija el operador y el productor se ignora.

**Por qué.** Es el mecanismo central del banco. Un modelo puramente coherente no puede
representar los estados que hay que probar: un sensor mintiendo, un interlock que no se abre
cuando debería, una realimentación imposible.

**El bloque productor sigue corriendo en sombra** durante el forzado, y su salida se descarta.
Es necesario para bloques con memoria —un temporizador de caldeo debe seguir contando—, de modo
que al liberar no haya que reinicializarlo. La sombra **no se expone en la interfaz**: menos
superficie y menos que explicar.

**La liberación es instantánea**, con salto discontinuo al valor de sombra. Sin rampa, sin
transición. Una rampa sería una mentira más suave pero seguiría siendo una mentira, y ocultaría
el instante exacto en que el valor cambió, que es lo que se está midiendo.

Toda entrada y salida de forzado se registra como evento etiquetado con el actor.

---

## D-09 · El valor forzado se propaga aguas abajo

**Decisión.** Un valor forzado se propaga por el grafo como si fuera real. Las expresiones que
lo consumen ven el valor mentiroso, no el de sombra.

**Por qué.** Es la razón de ser del forzado. Forzar `tx.radome_closed_status` a falso y que el
interlock no reaccione convertiría el forzado en un adorno de interfaz.

**Consecuencia.** La coherencia física se puede desactivar por señal, cortando la propagación
en un punto concreto, para inyectar incoherencias deliberadas sin desmontar el modelo entero.

---

## D-10 · Tick de 50 ms, integrador de ejes a 10 ms

**Decisión.** El modelo general corre a 50 ms. El integrador de ejes corre en su propio lazo a
10 ms.

**Por qué.** Un radar meteorológico de vigilancia gira típicamente entre 2 y 6 RPM, o sea
entre 12 y 36 °/s (*inferencia, pendiente de confirmar contra la antena real*). A 50 ms eso
son entre 0,6° y 1,8° de movimiento entre muestras, del orden del espaciado de rayos y
demasiado grueso para cerrar un lazo de posición con suavidad. El integrador son dos
multiplicaciones y dos sumas: aislarlo es barato.

**Descartado.** Bajar el tick global por debajo de 50 ms, que encarece todo el modelo sin
necesidad. También descartada la extrapolación lineal desde la velocidad del último tick, que
sería honesta pero introduce un escalón cada 50 ms.

Ver [PEND-20](pendientes.md#pend-20-ciclo-de-interrogacion-y-timeout-del-controlador): es el
único dato que podría obligar a revisar esta decisión.

---

## D-11 · Posición por UDP unicast, emisión periódica libre

**Decisión.** Struct binario de tamaño fijo sobre UDP, emitido periódicamente a un destino
unicast configurado. Sin petición-respuesta, sin descubrimiento, sin suscripción.

**Por qué.** La restricción dominante no es el emulador sino la FPGA con FreeRTOS, donde se
quiere lwIP con UDP crudo, sin framework de serialización, sin parsing de longitud variable y
sin asignación dinámica. Además, la posición es un dato donde la muestra vieja no sirve de
nada: la pérdida es tolerable y la retransmisión contraproducente. TCP daría bloqueo de
cabecera de línea para entregar datos ya caducos.

**Descartado.** Protobuf, JSON, Modbus sobre el mismo canal, y multicast —este último porque
no es fiable sobre overlay de Swarm y porque no hay más consumidores que el controlador.

---

## D-12 · La telemetría nunca bloquea el tick

**Decisión.** El lazo de tick escribe estado y termina. Un emisor independiente muestrea a
10 Hz y publica por WebSocket, descartando lo que no llegue a tiempo.

**Por qué.** Observar la prueba no puede perturbarla. Si el envío se bloquea porque el túnel
está congestionado o el navegador no drena, el tick se retrasaría y contaminaría la medición.

---

## D-13 · Estado y eventos van por canales con políticas opuestas

**Decisión.** El estado continuo tolera pérdidas y se reenvía completo. El registro de eventos
va numerado, se persiste antes de enviar y se recupera por número de secuencia tras
reconexión.

**Por qué.** Son flujos con exigencias contrarias. El estado se autocorrige con el siguiente
snapshot. El registro de eventos es la evidencia con la que se discutirá un fallo de
temporización con el equipo del controlador y no puede perder ni una transacción. Mezclarlos
con una sola política obliga a sacrificar uno de los dos.

---

## D-14 · Las aserciones se evalúan en el simulador

**Decisión.** El motor de aserciones corre en el simulador contra su reloj monótono. La
interfaz supervisa, no concluye.

**Por qué.** Lo que el operador ve llega con el retardo del túnel, variable y no medible. El
instante `t=0` de cualquier aserción es el momento en que el simulador **aplica** el cambio,
no el momento del clic.

**Consecuencia.** Las pruebas de temporización repetibles no se pueden hacer a mano. De ahí el
motor de escenarios.

---

## D-15 · Los comandos se detectan por flanco, no por nivel

**Decisión.** Los comandos que aparecen como pares mutuamente excluyentes —`Turn On Tx` /
`Turn Off Tx` y equivalentes— se tratan como pulsos sobre una máquina de estados enclavada, no
como bits de nivel.

**Por qué.** Es lo que indica su propia estructura: si fueran de nivel, un solo bit bastaría.

**Consecuencias a implementar.** El adaptador Modbus marca el flanco al recibir la escritura y
el lazo lo consume en el siguiente tick, aunque la señal ya haya vuelto a cero; así un pulso más
corto que el tick no se pierde. Si ambos comandos del par están activos a la vez, **prevalece
apagar**, y la regla es explícita en la configuración, no implícita en el código.

---

## D-16 · El núcleo trabaja en unidades de ingeniería

**Decisión.** El estado interno de toda señal analógica está en unidades físicas. La conversión
a valor crudo de registro ocurre **solo en el adaptador Modbus**, en el borde.

**Por qué.** El escalado depende del *Type Code* configurado en cada canal del módulo ADAM y no
está documentado ([PEND-06](pendientes.md#pend-06-codificacion-y-escalado-de-las-senales-analogicas)).
Si el crudo se filtrara al núcleo, cada corrección de escalado obligaría a revisar el modelo
físico entero. Aislada en el borde, es un cambio de una línea de configuración.

**Consecuencia.** La interfaz muestra siempre unidades de ingeniería. El valor crudo se muestra
solo como dato de diagnóstico junto al registro.

---

## D-17 · Servidor Modbus TCP sobre `modbus-serial`, no `jsmodbus`

**Decisión.** El adaptador Modbus se implementa sobre `modbus-serial` (`ServerTCP`), con
`options.unitID` sin fijar (queda en 255, "escucha todas las direcciones") y el enrutado por
módulo resuelto a mano dentro del `vector` de callbacks, indexando por el `unitID` que
`modbus-serial` pasa como argumento a cada `get*`/`set*`.

**Por qué.** Resultado de la prueba de concepto de la fase 0
([PEND-21](pendientes.md#pend-21-verificacion-de-la-libreria-servidor-modbus)):

- `jsmodbus` (4.0.10) **no sirve**. Su `ModbusServer` mantiene un único juego de buffers
  (`coils`/`discrete`/`holding`/`input`) por instancia, y `ModbusServerResponseHandler` nunca lee
  `request.unitId` al construir la respuesta: todas las unit IDs comparten el mismo buffer.
  Verificado escribiendo por unit 2 y leyendo por unit 1 sobre la misma conexión: el valor
  escrito por unit 2 aparece leído desde unit 1. La única vía para que jsmodbus discrimine por
  unit ID es dejar los cuatro buffers de opciones sin definir y reconstruir a mano, por evento,
  toda la lógica de construcción de respuesta (incluida la de excepciones) usando clases internas
  no pensadas para consumo público. Eso es más trabajo que escribir el servidor sobre
  `node:net`, no menos.
- `modbus-serial` (8.0.25) **sí sirve**, y cumple los tres puntos adicionales del criterio de
  salida: excepción Modbus ante `FC05` sobre una coil de solo lectura (lanzando
  `{ modbusErrorCode: 0x01 }` desde `setCoil`), e instante de recepción con resolución de
  microsegundos vía `process.hrtime.bigint()` capturado dentro del `vector`.

**Consecuencia.** El `vector` de `modbus-serial` es el único lugar del adaptador donde vive el
mapeo unit ID → módulo → dirección. No hay biblioteca que lo resuelva por nosotros; el mapa
completo (`docs/interfaces/modbus.md`) se traduce a ese `vector` a mano.

!!! note "Latencia de captura, no falta de resolución"
    `modbus-serial` difiere el parseo de cada trama con `setTimeout(fn, 0)`, así que el instante
    capturado dentro del `vector` no es el instante exacto de llegada al socket, sino ese
    instante más el jitter del event loop (medido: ~0,6-2,2 ms en la prueba de concepto, sin
    carga). La resolución del reloj (`process.hrtime.bigint()`, nanosegundos) no es el problema;
    si algún día se necesita el instante exacto de llegada, hay que interceptar el evento `data`
    del `net.Server` interno de `modbus-serial`, no está expuesto hoy.

**Descartado.** `jsmodbus`, y también reimplementar el servidor a mano sobre `node:net` — sigue
siendo la alternativa de reserva si `modbus-serial` mostrara un problema no detectado en esta
prueba de concepto (deliberadamente acotada, ver el spike en `spike-fase0/`).

---

## D-18 · Los bloques reales de la semilla no son los de `bloques.md`, y eso manda

**Decisión.** La biblioteca de bloques de fase 2 se construye contra los cinco `type` que
`config/rd100s.seed.json` usa de verdad — `expression`, `latch`, `state_machine`, `i2t`,
`axis` — no contra la lista de `bloques.md` (`delay_on`, `delay_off`, `ramp`, `first_order`,
`integrator`, `noise`, `threshold`), que no aparece en ningún bloque real de la semilla.

**Por qué.** Mismo patrón que [PEND-23](pendientes.md#pend-23-esquemamd-describia-una-forma-que-no-es-la-de-la-semilla-resuelto):
`bloques.md` es explícitamente "un esqueleto... lista de trabajo, no cerrada" redactado sin
mirar qué bloques ya usaba la semilla. Construir contra una lista aspiracional dejaría sin
implementar los cinco tipos que la semilla realmente necesita para encender el transmisor.

**Consecuencia.** `bloques.md` se reescribe para documentar los cinco tipos reales con sus
parámetros exactos. Si en el futuro se necesita `delay_on`/`ramp`/`noise`/etc., se agregan
cuando un radar concreto los use, no antes.

---

## D-19 · `rising()` en el primer tick se resuelve solo, sin política especial

**Decisión.** El valor "anterior" que usa `rising(señal)` para detectar flanco de subida se
inicializa, para cada señal, en su `initial` de la configuración. El primer tick de evaluación
del grafo no es un caso especial: compara contra ese valor sembrado igual que cualquier tick
posterior compara contra el valor al final del tick anterior.

**Por qué.** La pregunta que plantea `bloques.md` ("¿arranca su temporizador o considera la
condición cumplida?") es sobre `delay_on`, que **no existe en ningún bloque de la semilla**
([D-18](#d-18-los-bloques-reales-de-la-semilla-no-son-los-de-bloquesmd-y-eso-manda)). Los cinco
tipos reales no tienen esa ambigüedad: `state_machine` declara su estado inicial explícito
(`initial: "OFF"`), `i2t` arranca su acumulador en cero sin importar la corriente de entrada, y
`latch`/`expression` solo dependen de `rising()` para el reset, que este esquema resuelve.

---

## D-20 · Una recarga de configuración reinicializa todo el estado de los bloques

**Decisión.** Los bloques (acumuladores de `i2t`, estado de `state_machine`, salida de `latch`,
posición/velocidad de `axis`) no sobreviven a una recarga. Una recarga tira el `SignalStore`
entero y arma uno nuevo desde `initial` (`src/runtime.ts`, función `buildRuntime`, agregada en
fase 1 para la recarga de configuración).

**Por qué.** Es la opción "más predecible" que ya proponía `bloques.md`, y además es la que sale
gratis de cómo ya está construida la recarga (fase 1): conservar estado exigiría serializar y
migrar cada tipo de bloque, con casos borde por cada `type` nuevo que se agregue. Reinicializar
es una sola regla, sin excepciones por tipo.

**Consecuencia.** Recargar configuración en medio de una prueba larga (p.ej. con el magnetrón ya
caldeado) pierde ese progreso. Es aceptable: la recarga ya implica sesión nueva
([docs/ui/editor.md](../ui/editor.md#la-recarga-arranca-sesion-nueva)).

---

## D-21 · `latch` es reset-dominante

**Decisión.** Cuando `set` y `reset` son ambos verdaderos en el mismo tick, `reset` gana: la
salida pasa (o se mantiene) en falso.

**Por qué.** `bloques.md` pedía "precedencia declarada" pero ningún `latch` de la semilla trae
un campo de precedencia. `tx.magnetron_oc_latch` es el único caso real: `set` es una condición
continua (`corriente > 55 A`) y `reset` es un pulso de operador (`rising(reset_faults_command)`).
Si `set` ganara, un operador nunca podría limpiar la falla mientras la sobrecorriente persistiera
ese mismo tick, que es precisamente cuando querría limpiarla. Mismo criterio que
[D-15](#d-15-los-comandos-se-detectan-por-flanco-no-por-nivel): ante ambigüedad, gana la acción
seguridad/operador, no la condición de campo.

**Descartado.** Set-dominante, y un campo `precedence` explícito en el esquema —se agrega si
aparece un `latch` real que necesite lo contrario.

---

## D-22 · Modelo de `i2t`: acumulador con calentamiento cuadrático y enfriamiento lineal

**Decisión.** `i2t` no está en `bloques.md` en absoluto —ni en la lista aspiracional. Se
implementa como acumulador `acc` en segundos:

```
si corriente > threshold_a:  acc += dt_s * ((corriente / threshold_a)^2 - 1)
si no:                        acc = max(0, acc - dt_s)
dispara (output = true) cuando acc >= time_s
```

**Por qué.** Aproxima el comportamiento real de una protección I²t —cuanto más se excede el
umbral, más rápido se acumula "calor"— con dos parámetros que la semilla ya declara
(`threshold_a`, `time_s`) y sin inventar un tercero. El enfriamiento lineal (no cuadrático) es
deliberadamente más simple: no hay dato para justificar una curva de enfriamiento distinta.

**Consecuencia.** Es una invención plausible, igual que los coeficientes que consume
([PEND-15](pendientes.md#pend-15-ganancias-aceleraciones-y-modelo-de-corriente-de-los-ejes)).
Marcado `// PEND-i2t-modelo` en el código. Confirmar contra la hoja de datos del relé de
protección real antes de una prueba formal.

---

## D-23 · Modelo del bloque `axis`: aceleración limitada + corriente estática más proporcional

**Decisión.** Cada tick del lazo de 10 ms: la velocidad objetivo es `reference * gain_deg_s_per_volt`
(con `reference` congelado en cero si `enable` es falso o si el inhibidor de esa dirección está
activo); la velocidad real persigue el objetivo limitada por `accel_deg_s2`; la posición integra
la velocidad real; `wrap` envuelve en `0..360`, o si no hay `wrap`, `limits_deg` fija el recorrido
y la velocidad se corta al llegar. La corriente reportada es
`current_static_a + current_per_accel_a * |aceleracion_aplicada|`.

**Por qué.** Es el modelo más simple que usa exactamente los parámetros que la semilla ya
declara, sin inventar ninguno adicional. `inhibit_up`/`inhibit_down` se leen del **valor de la
señal** (que ya respeta forzado, D-09), tal como pide la nota de la propia semilla: si el
operador fuerza el final de carrera, el eje se detiene aunque la posición real no esté en el
tope.

**Consecuencia.** Invención plausible sobre invención plausible
([PEND-15](pendientes.md#pend-15-ganancias-aceleraciones-y-modelo-de-corriente-de-los-ejes)).
Marcado `// PEND-axis-modelo`.

---

## D-24 · Bug real en `tx.fsm`: la transición de caída de interlock no puede ser `"*"` literal

**Decisión.** La transición `HV_ON/RADIATING -> READY when not tx.interlocks_ok` de
`tx.fsm` (semilla) se acota a `from: ["HV_ON", "RADIATING"]`. El motor de `state_machine`
(`src/core/graph.ts`) soporta `from` como string, array de strings, o `"*"` literal.

**Por qué.** Verificado con `scripts/smoke-blocks.ts`: con `from: "*"` literal —como estaba
escrito en la semilla— esta transición disparaba **en el primer tick**, antes de que el
transmisor arrancara. `tx.interlocks_ok` empieza en `false` (nada forzado todavía), así que
`not tx.interlocks_ok` es verdadero desde `t=0`, y con prioridad 90 gana sobre la transición
`OFF -> STARTING`: la máquina saltaba directo a `READY` sin pasar nunca por `STARTING`/`WARMUP`,
dejando la secuencia de encendido inalcanzable.

La propia nota de la semilla en esa transición —"caída de interlock **retira HV** pero no apaga
el Tx"— solo tiene sentido si el HV ya estaba presente, es decir, si el estado actual es
`HV_ON` o `RADIATING`. La transición `"*" -> OFF when turn_off_tx_command` (prioridad 100), en
cambio, sí es correctamente global: apagar debe funcionar desde cualquier estado, incluido
`OFF` como no-operación.

**Consecuencia.** `"*"` sigue siendo válido en el esquema para casos genuinamente globales
(como el apagado). Cualquier bloque `state_machine` nuevo que use una transición de
"protección"/"retirada" análoga a esta debe acotar `from` a los estados donde la condición
protegida existe, no usar `"*"` por comodidad.

---

## D-26 · Semántica del motor de aserciones — invención más especulativa que D-18 a D-24

**Decisión.** `docs/implementacion/observabilidad.md#aserciones` da un ejemplo por tipo, pero
ninguna asercion vivía todavía en `config/rd100s.seed.json` cuando se implementó (a diferencia
de los bloques, donde "la semilla manda" tenía datos reales que resolvían la ambigüedad). Aquí
no había datos previos: la semántica exacta es diseño nuevo, no lectura de un ejemplo real.
Reglas implementadas (`src/core/assertions.ts`):

- El tipo se infiere de cuál de `within_ms`/`not_before_ms`/`stable_for_ms` está presente; sin
  ninguno de los tres, es `never`.
- `within_ms`/`not_before_ms`/`stable_for_ms` necesitan `when` (dispara una instancia con
  `rising()`/`falling()`, igual que los bloques). **Como mucho una instancia activa por
  asercion**: un segundo disparo de `when` mientras la primera instancia sigue esperando se
  ignora. Esto es deliberado y simplifica el motor, pero significa que un `when` sin
  `rising()`/`falling()` (nivel puro) solo arma una instancia la primera vez que se vuelve
  verdadero, no en cada tick.
- `never` no tiene `when`: vigila `expect` (aquí, la condición **prohibida**, no la esperada —
  inversión de significado respecto a los otros tres tipos, que ya trae la propia tabla de la
  documentación) desde la carga, con flanco de subida propio del motor (no del store).
- `stable_for_ms`: si `expect` ya es falso en el instante del disparo, falla inmediatamente sin
  esperar el plazo — nunca llegó a estar en el estado que debía sostenerse.
- `not_before_ms`: si `expect` nunca se vuelve verdadero, la instancia queda pendiente
  indefinidamente (sin límite superior). No hay dato para justificar un timeout arbitrario.
- Signo del margen: positivo es "cómodo" (llegó con holgura en `within_ms`/`stable_for_ms`, o
  llegó tarde como se esperaba en `not_before_ms`); negativo o "quedó pendiente" es lo contrario.

**Consecuencia.** Esto es más una propuesta razonada que una decisión confirmada contra datos
reales. Revisar con el equipo antes de apoyarse en el signo exacto del margen para una prueba
formal ([PEND-26](../alcance/pendientes.md#pend-26-semantica-del-motor-de-aserciones-sin-confirmar)).

---

## D-27 · El motor de escenarios usa force/release reales, un escenario a la vez

**Decisión.** `pulse` se implementa como `force(signal, true, actor)` seguido de
`release(signal, actor)` tras `ms` milisegundos — literalmente lo que haría un operador
presionando un botón. Los pasos se programan con `setTimeout` contra el reloj real desde que
arranca el escenario (no contra el tick, aunque las mediciones de las aserciones sí usan el
reloj monótono del núcleo). Un paso `assert` no evalúa nada por sí mismo: es un checkpoint que
adjunta al registro el **último resultado conocido** de esa asercion (el motor de aserciones
corre siempre, no solo durante un escenario). Solo un escenario puede correr a la vez; arrancar
uno con otro en curso se rechaza.

**Por qué.** Igual que D-26, no había un escenario real en la semilla antes de esta
implementación — la referencia de `blower-fail-and-reset` en la documentación se agregó a
`config/rd100s.seed.json` durante esta misma fase, junto con su asercion asociada, precisamente
para tener un caso real contra el cual verificar el motor
(`scripts/smoke-scenario.ts`).

**Consecuencia.** Si en el futuro se necesita correr escenarios en paralelo (p.ej. uno por
subsistema), hay que rediseñar `ScenarioRunner` — hoy asume single-flight a propósito, porque
dos escenarios tocando la misma señal a la vez no tiene una semántica obvia de quién gana.
