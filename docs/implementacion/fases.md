# Fases

Plan de trabajo para el agente de desarrollo. Cada fase termina en algo **conectable y
demostrable**, no en una capa terminada.

!!! important "Regla de orden"
    Las fases no se solapan. Cada una existe porque la siguiente sería más cara sin ella, y el
    orden está elegido para que los descubrimientos caros aparezcan pronto. En particular, el
    mapeo Modbus contra el controlador real es donde suelen aparecer las sorpresas, y por eso va
    primero, antes que cualquier modelo físico.

---

## Fase 0 · Prueba de concepto del servidor Modbus

**Antes que cualquier otra cosa.** Días, no semanas.

Verificar que existe una librería que sirva
([PEND-21](../alcance/pendientes.md#pend-21-verificacion-de-la-libreria-servidor-modbus)):

1. Levantar un servidor Modbus TCP con `jsmodbus`, y si falla con `modbus-serial`.
2. Atender **al menos tres unit IDs distintos sobre una sola conexión TCP**, con mapas de
   direcciones que colisionen entre sí. Es el requisito duro.
3. Responder **excepción** ante `FC05` sobre una coil declarada de solo lectura.
4. Comprobar que se puede obtener el instante de recepción de cada trama con resolución de
   microsegundos.
5. Conectar un cliente Modbus cualquiera y verificar los cuatro puntos.

**Criterio de salida:** una librería elegida con los cuatro puntos verificados, o la decisión
razonada de implementar el servidor sobre `node:net`.

!!! danger "No continuar sin esto"
    Si ninguna librería sirve y hay que escribir el servidor a mano, la estimación de la fase 1
    cambia sustancialmente. Descubrirlo en la semana cuatro en vez de en la uno es la diferencia
    entre un ajuste y un replanteo.

---

## Fase 1 · Mapeo verificable de extremo a extremo

El objetivo es **conectar el controlador y comprobar que lee y escribe lo que espera**. Sin
dinámica, sin máquinas de estado, sin modelo físico.

### Alcance

| Componente | Qué entra |
|---|---|
| Configuración | Carga y validación de `signals` y `modbus`. `blocks` y `expressions` vacíos deben ser válidos |
| Núcleo | Mapa de señales, modos `auto`/`forced`, `read`/`write`/`force`/`release`, lazo de tick a 50 ms sin evaluación de grafo |
| Modbus | Servidor con los seis códigos de función, multi-unit, conversión de crudo en el borde, detección de flanco |
| WebSocket | Telemetría `state` a 10 Hz y flujo `event` numerado |
| Registro | SQLite en WAL, sesiones por hash de configuración, volcado en lote fuera del tick, descarga de sesión |
| Interfaz | Lista de señales, forzado y liberación, registro en vivo, contadores de estado anómalo, operadores conectados |
| Despliegue | `stack.yml` con los tres servicios, overlay, sin publicar 502 |

### Fuera de alcance

Bloques, expresiones, lazo de ejes, stream UDP, degradaciones, aserciones, escenarios, editor
de configuración.

### Criterio de salida

El controlador real se conecta por overlay, interroga los diez unit IDs, y un operador puede
forzar cualquier señal desde el navegador y ver la reacción del controlador. La sesión se
descarga como fichero con todas las transacciones Modbus marcadas en tiempo.

!!! note "Aquí es donde aparecen las sorpresas"
    Direcciones mal transcritas, unit IDs que no coinciden, escalados invertidos, comandos que
    el controlador manda como nivel y no como pulso. Todo eso sale en esta fase, y sale barato
    porque no hay modelo físico que revisar en paralelo.

---

## Fase 2 · Modelo de comportamiento y stream de posición

### Alcance

| Componente | Qué entra |
|---|---|
| Grafo | Evaluación de `expressions`, orden topológico, detección de ciclos en carga |
| Bloques | Biblioteca inicial: `delay_on`, `delay_off`, `latch`, `ramp`, `threshold` |
| Sombra | Bloque productor corriendo durante el forzado, liberación con salto discontinuo |
| Propagación | Corte y restitución por señal, visible en la interfaz |
| Transmisor | Cadena de interlock, secuencia de encendido, temporizador de caldeo |
| Ejes | Bloque `axis` y lazo de 10 ms |
| UDP | Emisor `RD100S-ENC-UDP v1` y tabla completa de degradaciones |

!!! warning "Resolver antes de escribir el primer bloque"
    Las [cuestiones abiertas de la biblioteca](../configuracion/bloques.md#cuestiones-abiertas)
    —comportamiento en el primer tick, semántica de recarga, determinismo del generador
    pseudoaleatorio— afectan a todos los bloques. Decidirlas después obliga a reescribirlos
    todos.

### Criterio de salida

Encender el transmisor desde el controlador produce una secuencia temporal completa y coherente,
y el controlador cierra el lazo de posición contra el stream UDP. Las degradaciones del stream
se activan desde la interfaz y el controlador reacciona.

---

## Fase 3 · Aserciones y escenarios

### Alcance

Motor de aserciones evaluado en el simulador contra su reloj monótono, con los cuatro tipos
—`within_ms`, `not_before_ms`, `stable_for_ms`, `never`— registrando **margen medido**, no solo
aprobado o fallado. Motor de escenarios en JSON con `force`, `release`, `pulse` y `assert`
temporizados. Panel de supervisión en la interfaz.

### Por qué al final

El trabajo exploratorio del operador es manual y en caliente: **así es como se descubren los
comportamientos que luego merece la pena convertir en escenario**. Escribir escenarios antes de
haber explorado produce pruebas de lo que se imaginaba, no de lo que ocurre.

### Criterio de salida

Un escenario de regresión corre sin intervención y produce un informe con márgenes medidos,
reproducible dentro de la resolución del tick.

---

## Trabajo transversal

Estas tareas no pertenecen a una fase; se hacen cuando llega el dato.

| Tarea | Bloqueada por |
|---|---|
| Regenerar la semilla RD100S y su página | Documento fuente del mapa de E/S, perdido |
| Cerrar PEND-01 a PEND-05 | Reunión con equipos de FPGA y controlador |
| Cerrar PEND-06 a PEND-08 | Type Codes reales y direcciones RS-485 |
| Cerrar PEND-20 | Ciclo de interrogación del controlador |
| Congelar `RD100S-ENC-UDP v1` | PEND-01 a PEND-05 |

!!! danger "PEND-20 puede tocar la fase 2"
    El ciclo de interrogación y el timeout del controlador son el único dato capaz de obligar a
    bajar el tick por debajo de 50 ms
    ([D-10](../alcance/decisiones.md#d-10-tick-de-50-ms-integrador-de-ejes-a-10-ms)). Conviene
    conseguirlo durante la fase 1, cuando ya hay un controlador conectado del que medirlo.

## Lo primero que debe hacer el agente

1. Leer [Decisiones de diseño](../alcance/decisiones.md) entera. Ninguna se revierte sin
   discutirlo.
2. Leer [Pendientes](../alcance/pendientes.md). Ningún valor de la documentación es de fiar sin
   comprobar si está ahí.
3. Ejecutar la **fase 0** y reportar el resultado antes de escribir código de producción.
