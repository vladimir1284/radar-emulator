# Biblioteca de bloques

!!! danger "Página incompleta · fase 2"
    Esta página es un **esqueleto**. La biblioteca de bloques no entra en la fase 1
    ([Fases](../implementacion/fases.md)), y su contenido detallado —parámetros exactos,
    semántica de reinicio, comportamiento en el primer tick— se redactará al abordarla.
    Lo que sigue fija el marco, no la especificación.

## Qué es un bloque

Una unidad de comportamiento reutilizable, instanciada desde la configuración con parámetros y
enlazada a señales de entrada y salida. Los bloques son **el único sitio donde vive estado
temporal** del modelo; las expresiones son puras.

Un bloque no conoce el radar. `delay_on` no sabe que está temporizando un caldeo de magnetrón.
Esa es la condición para que un usuario pueda armar un radar distinto sin tocar código.

## Bloques previstos

Lista de trabajo, no cerrada.

| `kind` | Qué hace | Estado interno |
|---|---|---|
| `delay_on` | Salida a verdadero tras N ms de entrada verdadera | temporizador |
| `delay_off` | Retiene la salida N ms tras caer la entrada | temporizador |
| `latch` | Enclavamiento con set y reset, precedencia declarada | booleano |
| `ramp` | Persigue una consigna a pendiente limitada | valor actual |
| `first_order` | Retardo de primer orden con constante de tiempo | valor actual |
| `integrator` | Integra la entrada, con límites y anti-windup | acumulador |
| `axis` | Integrador de posición con velocidad, aceleración y finales de carrera | posición, velocidad |
| `noise` | Ruido aditivo sobre una señal analógica | semilla del generador |
| `threshold` | Comparación con histéresis | último estado |

## Cuestiones abiertas

Deben resolverse **antes** de escribir el primer bloque, porque afectan a todos.

**Comportamiento en el primer tick.** Un `delay_on` cargado con la entrada ya en verdadero,
¿arranca su temporizador o considera la condición cumplida? Ambas son defendibles y hay que
elegir una y aplicarla a toda la biblioteca.

**Semántica de recarga de configuración.** Al aplicar una configuración nueva, ¿los bloques
cuyo `kind` y parámetros no cambiaron conservan su estado interno, o se reinicializan? Conservar
permite ajustar el modelo sin perder una sesión larga; reinicializar es más predecible.

**Determinismo.** `noise` introduce un generador pseudoaleatorio. Su semilla debe formar parte
de la configuración y quedar en el registro de sesión, o las trazas dejan de ser reproducibles.

**Relación con `axis`.** El bloque de ejes es el único que corre en el lazo de 10 ms
([D-10](../alcance/decisiones.md#d-10-tick-de-50-ms-integrador-de-ejes-a-10-ms)), lo que lo
convierte en un caso especial dentro de la biblioteca. Queda por decidir si se modela como
bloque con marca de cadencia o como subsistema aparte.

## Parámetros de la semilla RD100S

Todos los coeficientes que la semilla asigna a estos bloques son **invención plausible**:
tiempo de caldeo ([PEND-10](../alcance/pendientes.md#pend-10-tiempo-de-caldeo-del-magnetron)),
retardos de arranque ([PEND-11](../alcance/pendientes.md#pend-11-retardos-de-arranque-de-mps-y-fps)),
ganancias y aceleraciones de los ejes
([PEND-15](../alcance/pendientes.md#pend-15-ganancias-aceleraciones-y-modelo-de-corriente-de-los-ejes)),
recorrido de elevación ([PEND-16](../alcance/pendientes.md#pend-16-recorrido-y-finales-de-carrera-de-elevacion)).
