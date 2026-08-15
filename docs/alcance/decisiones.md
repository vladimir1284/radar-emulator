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
