# Contexto y alcance

## Qué es este sistema

Un emulador de la **planta** del radar meteorológico RD100S. Presenta al controlador del radar
las mismas interfaces que encontraría conectado al equipo real, y permite forzar cualquier
señal a voluntad, incluida a valores físicamente imposibles.

El objetivo no es simular un radar. Es **poder provocar, de forma repetible y con marca de
tiempo, situaciones que con hardware real serían caras, lentas o imposibles de reproducir**.

## Qué no es

!!! warning "El controlador no forma parte de este proyecto"
    El controlador del radar es software de otro equipo. Aparece en esta documentación
    únicamente como consumidor de las interfaces aquí especificadas. El emulador nunca asume
    nada sobre su implementación interna, y ninguna decisión de este proyecto puede depender de
    un cambio en el controlador.

Tampoco se emula la cadena de señal —vídeo crudo, momentos, productos meteorológicos—. El
emulador cubre el **dominio de control**, no el de datos radar.

No es un gemelo digital ni una herramienta de ingeniería del radar. La fidelidad física del
modelo se busca solo hasta donde sirva para que el controlador se comporte como lo haría en
campo. Un modelo más fiel del que exige esa prueba es esfuerzo desperdiciado.

## El sistema no es específico del RD100S

Aunque el RD100S es el caso que motiva el proyecto, el emulador se diseña **configurable**. Las
señales, su mapeo Modbus, los bloques de comportamiento y las expresiones que los enlazan viven
en un JSON, no en el código.

El RD100S entra como **semilla por defecto**: un fichero de configuración que permite empezar a
probar sin partir de cero. Un usuario puede escribir su propio radar sin tocar el código fuente.

Esto tiene una consecuencia de diseño que atraviesa todo el proyecto: **nada específico del
RD100S puede quedar cableado**. Ni los subsistemas, ni los módulos ADAM, ni los nombres de las
señales, ni la cadena de interlock. Los subsistemas son espacios de nombres, no tipos.

## Los dos usos del sistema

**Banco de pruebas.** Un operador remoto ejecuta sesiones contra el controlador real, fuerza
señales, observa reacciones y descarga la traza para análisis.

**Demostración.** El mismo stack, accesible desde internet, permite a un visitante ver el
emulador y el controlador funcionando conectados entre sí.

!!! note "La demo comparte estado"
    Ambos usos corren sobre la misma instancia. El simulador mantiene un estado único, así que
    varios visitantes simultáneos comparten el mismo radar: si uno fuerza el interlock, todos
    ven caer el HV. La interfaz debe mostrar cuántos operadores hay conectados y atribuir cada
    forzado en el registro. Aislar sesiones exigiría una instancia por visitante, lo que rompe
    el modelo de estado único y el contenedor único del controlador.

## Las tres capacidades que definen el valor

- **Forzado en caliente de cualquier señal**, incluyendo estados físicamente imposibles, para
  verificar que el controlador se protege en vez de confiar en la planta.
- **Coherencia física opcional.** El modelo propaga causas —abrir el radomo abre el interlock,
  que retira el HV— y esa propagación puede desactivarse señal a señal para inyectar
  incoherencias deliberadas.
- **Evidencia auditable.** El emulador es el único punto donde se puede registrar la
  conversación completa con marca de tiempo fiable, porque el controlador pertenece a otro
  equipo. Ese registro es la evidencia con la que se discutirá cualquier fallo de temporización.

## Interfaces con el exterior

| Interfaz | Dirección | Papel del emulador | Documento |
|---|---|---|---|
| Modbus TCP | controlador → emulador | servidor | [Modbus TCP](../interfaces/modbus.md) |
| UDP de encoder | emulador → controlador | emisor | [RD100S-ENC-UDP](../interfaces/udp-encoder.md) |
| WebSocket | emulador ↔ navegador | servidor | [WebSocket](../interfaces/websocket.md) |

La posición de antena **no viaja por Modbus**. En el sistema real llega al controlador por
encoder/resolver directo, y el emulador replica ese canal con un stream UDP propio. Esto se
descubrió a mitad del diseño y obligó a meter una interfaz entera en el alcance que inicialmente
no estaba.

## Estado

!!! danger "Documento de diseño previo a implementación"
    Buena parte de las magnitudes físicas y de los campos de protocolo están **inventados como
    marcador de posición**, por decisión explícita, para desbloquear la implementación. Están
    todos inventariados en [Pendientes](pendientes.md) con identificador estable. Ninguno debe
    llegar a una prueba formal sin confirmarse.
