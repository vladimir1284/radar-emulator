# Pendientes

!!! danger "Leer antes de tomar cualquier valor como bueno"
    Buena parte de las magnitudes físicas y de los campos de protocolo de esta documentación
    están **inventados como marcador de posición**, por decisión explícita, para desbloquear la
    implementación. Están todos aquí. Ninguno debe llegar a una prueba formal sin confirmarse.

Cada pendiente lleva identificador estable para poder referenciarlo desde el código y desde
los tickets. La convención en el código fuente es un comentario `// PEND-nn` en el punto donde
el valor provisional se usa.

## Bloqueantes para pruebas formales

Estos afectan a contratos con software ajeno al proyecto. Un error aquí no se detecta como
fallo del emulador, sino como fallo aparente del controlador.

### PEND-01 · Escala de azimut y elevación

Se ha fijado **milésimas de grado** (`i32`, 1 unidad = 0,001°). Azimut en `0..359999` con
envolvente, elevación en `-90000..+90000`.

Verificar contra la resolución real del encoder. Si el encoder es de 14 bits, su resolución
nativa es de unos 0,022°, y una escala en milésimas sobredimensiona sin aportar; si es de
19 bits o superior, se queda corta. Lo correcto es alinear la escala con la resolución del
dispositivo, no con un número redondo en decimal.

### PEND-02 · Unidad y origen de la marca de tiempo

Se ha fijado `u64` en **microsegundos desde el arranque del emisor**, reloj monótono.

Verificar que el contador de hardware de la FPGA puede producir esa magnitud sin coste
excesivo, y que el controlador calcula sus deltas en la misma unidad. Si el contador nativo de
la FPGA tiene otra frecuencia, es preferible declarar esa frecuencia en la especificación
antes que obligar a la FPGA a convertir en cada paquete.

!!! warning "Nunca hora de pared"
    En el emulador la marca de tiempo debe salir del reloj monótono del proceso, jamás de la
    hora del sistema. Un ajuste NTP en el nodo Swarm haría saltar los timestamps hacia atrás en
    mitad de una prueba y corrompería la traza.

### PEND-03 · Cadencia nominal del stream

Se han fijado **100 Hz** (10 ms) con tolerancia de jitter de ±2 ms.

Verificar contra la frecuencia del lazo de posición del controlador. Si el lazo corre a 20 Hz,
100 Hz es desperdicio; si necesita 200 Hz, hay que revisar D-10 y el coste en la FPGA.

### PEND-04 · Palabra de estado del paquete

Los ocho bits definidos en la [especificación UDP](../interfaces/udp-encoder.md) son una
propuesta razonada, no un requisito recogido del sistema real. Falta confirmar con el equipo
de FPGA qué condiciones de error puede realmente detectar y señalar el hardware, y con el
equipo de controlador qué bits va a consumir. Los bits que nadie produce ni consume deben
eliminarse antes de congelar la versión 1.

### PEND-05 · CRC en el paquete

Decidido **no incluir CRC**, delegando en el checksum de UDP. Confirmar que el equipo de FPGA
no requiere verificación adicional por política de integridad. Añadirlo después obliga a
versionar el protocolo.

### PEND-06 · Codificación y escalado de las señales analógicas

El Apéndice G del manual ADAM-4000 lista los registros de valor pero **no especifica la
conversión a unidades de ingeniería**, que depende del *Type Code* configurado en cada canal
(registros `40201` y siguientes). Sin ese dato no se sabe si un canal entrega entero sin signo
en `0..65535`, entero con signo, o complemento a dos escalado sobre el rango del tipo.

La semilla asume `int16` con rango crudo `0..65535` para señales unipolares y `-32768..32767`
para bipolares, y rangos de ingeniería inventados. **Todos los rangos de ingeniería de la
semilla son invención.** Se necesita, para cada canal analógico, el Type Code real y el rango
físico que representa.

### PEND-07 · Mapa Modbus de los módulos 4069, 4117 y 4150

El Apéndice G aportado **no cubre estos tres módulos**. Sus direcciones en la semilla se han
inferido por analogía con módulos de la misma familia y función. Detalle en
[Mapa Modbus](../interfaces/modbus.md#modulos-no-cubiertos-por-el-apendice-g).

### PEND-08 · Unit IDs reales del gateway

La asignación de un unit ID por módulo físico es correcta como modelo, pero los **números
concretos** de la semilla son arbitrarios. Deben coincidir con las direcciones RS-485
configuradas en los módulos reales, o con el mapeo que aplique el gateway.

## Parámetros del modelo físico

Menos críticos que los anteriores porque son configurables por el usuario desde la interfaz y
un error solo produce un radar poco realista, no un fallo de comunicación.

### PEND-10 · Tiempo de caldeo del magnetrón

Fijado en **180 s**. Es un orden de magnitud típico en magnetrones de radar meteorológico,
pero es inferencia y hay que contrastarlo con la hoja de datos del tubo del RD100S.

### PEND-11 · Retardos de arranque de MPS y FPS

Fijado en **1500 ms** desde el comando hasta que ambas fuentes reportan encendido. Sin
respaldo documental.

### PEND-12 · Condiciones exactas que bloquean el HV

La semilla incluye en la cadena de interlock: interlock físico, presión de guía de onda,
soplador de la cabina, soplador del magnetrón, secuencia de fases y ciclo de trabajo. Falta
confirmar la lista real y si alguna condición es de bloqueo o solo de aviso.

### PEND-13 · El radomo en la cadena de interlock

La semilla hace que `Radome Closed Status` participe en `tx.interlock_ok_status`. Es una
suposición sobre el diseño del RD100S que puede ser falsa.

### PEND-14 · Umbral de sobrecorriente pico de magnetrón

Fijado en **55 A** sobre un fondo de escala inventado de 60 A. Sin respaldo.

### PEND-15 · Ganancias, aceleraciones y modelo de corriente de los ejes

Todos los coeficientes de `ant.az_axis` y `ant.el_axis` —ganancia voltios a grados por segundo,
aceleración máxima, corriente estática y corriente por unidad de aceleración— son invención
plausible. Requieren los datos de los variadores y motores reales.

### PEND-16 · Recorrido y finales de carrera de elevación

Fijado un recorrido de `-2°` a `+92°` con conmutación de finales de carrera a `-1,5°` y
`+91,5°`. Sin respaldo.

## Cuestiones abiertas de diseño

### PEND-20 · Ciclo de interrogación y timeout del controlador

Desconocido. Es el único dato que podría obligar a bajar el tick por debajo de 50 ms. Con
ciclos de 200 ms o más, todo el diseño va holgado. Se ha decidido **no bajar de 50 ms** salvo
que este dato lo imponga.

### PEND-21 · Verificación de la librería servidor Modbus — RESUELTO en fase 0

`jsmodbus` **no soporta** multi-unit ID sobre una sola conexión (buffers compartidos entre unit
IDs, verificado). `modbus-serial` **sí**, enrutando a mano por `unitID` dentro del `vector` de
callbacks. También cumple excepción ante `FC05` sobre coil de solo lectura y timestamp de
recepción con resolución de microsegundos. Detalle y prueba de concepto en
[D-17](decisiones.md#d-17-servidor-modbus-tcp-sobre-modbus-serial-no-jsmodbus).

### PEND-22 · Anomalía documental en el ADAM-4051

El Apéndice G asigna al 4051 —módulo de 16 entradas digitales— cuatro registros `4X` en
`40001..40004` etiquetados *Current Output Value R/W*. Un módulo exclusivamente de entrada
digital no tiene salidas analógicas. Con alta probabilidad es un error de copia en el manual,
heredado de la tabla del 4024. La semilla **ignora esos registros**. Confirmar contra el
hardware real antes de darlo por cerrado.

### PEND-23 · `esquema.md` describía una forma que no es la de la semilla — RESUELTO

Antes de que existiera código, `esquema.md` describía `signals` como diccionario clave-por-nombre
y `meta`/`modbus`/`expressions` en la raíz. La semilla real (`config/rd100s.seed.json`, 116
señales, existente desde antes de la reconstrucción de la documentación) usa `signals` como
array de objetos con `id`, `kind` en vez de `io`, `modbus.unit_id` en vez de `unit`, y
`transports.modbus_tcp`/`transports.encoder_udp` en vez de raíz. Se decidió que manda la
semilla: `esquema.md` se reescribió para documentar la forma real, y `src/config/` valida
contra ella. No hay migración pendiente de los datos.

### PEND-24 · `blocks` absorbe `expressions`, D-06 describe una partición que no existe

[D-06](decisiones.md#d-06-la-configuracion-es-json-en-tres-partes) describe `signals`, `blocks`
y `expressions` como tres secciones separadas. La semilla real no tiene sección `expressions`:
el enlace declarativo entre señales es un `type: "expression"` más dentro de `blocks`, junto a
`state_machine`, `axis`, `latch`, `i2t`. D-06 no se ha revertido —AGENTS.md pide discutir antes
de tocar una decisión— pero su premisa de partición en tres no describe el JSON real. Pendiente
de decidir con el equipo: ¿se ajusta D-06 para reflejar que `expressions` es un `type` de
`blocks`, o se migra la semilla para separar `expressions` como sección propia antes de fase 2
(cuando el grafo de dependencias sí se evalúa)?

### PEND-25 · El cuarto subsistema es `sys`, D-07 dice `env`

[D-07](decisiones.md#d-07-los-subsistemas-son-espacios-de-nombres-no-tipos) enumera `tx`, `ant`,
`rx` y `env` como los cuatro prefijos de subsistema. La semilla real usa `sys` (`subsystems: [
{"id":"tx"}, {"id":"ant"}, {"id":"rx"}, {"id":"sys"} ]`, etiqueta "On/Off/Climate"), no `env`. No
afecta al código —el validador comprueba que `signal.subsystem` exista en `subsystems[]`, sea
cual sea el nombre— pero la documentación y el código deben usar el mismo nombre. Confirmar cuál
es el correcto y corregir el otro lado.

### PEND-26 · Semántica del motor de aserciones sin confirmar

[D-26](decisiones.md#d-26-semantica-del-motor-de-aserciones-invencion-mas-especulativa-que-d-18-a-d-24)
implementa `within_ms`/`not_before_ms`/`stable_for_ms`/`never` sin un ejemplo real previo en la
semilla que fijara el comportamiento exacto (a diferencia de los bloques de fase 2, donde la
semilla ya traía casos reales). En particular: una instancia activa por asercion a la vez
(un segundo disparo de `when` mientras la primera espera se ignora), `not_before_ms` sin límite
superior si `expect` nunca llega, y el signo del margen reportado. Revisar con el equipo antes
de una prueba formal que dependa del valor exacto del margen o de disparos repetidos del mismo
`when` en una ventana corta.
