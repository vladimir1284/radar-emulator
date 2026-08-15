# Panel de operación

La interfaz desde la que se ejecuta una sesión de pruebas. **Entra completa en la fase 1**: sin
ella el emulador no sirve para nada, porque el forzado manual es el modo principal de trabajo.

## Principio rector

!!! important "La interfaz supervisa, no concluye"
    Todo lo que el operador ve llega con el retardo variable del túnel. La interfaz **nunca**
    calcula tiempos, nunca decide si una aserción se cumplió y nunca usa la hora del navegador
    para nada que vaya a un informe. Esos cálculos viven en el simulador
    ([D-14](../alcance/decisiones.md#d-14-las-aserciones-se-evaluan-en-el-simulador)).
    
    La consecuencia práctica: si algo en la interfaz muestra una duración, esa duración vino
    calculada del servidor.

## Vista de señales

Lista completa, agrupada por subsistema, con filtro por nombre y por tipo. Cada fila muestra:

| Elemento | Notas |
|---|---|
| Etiqueta y nombre completo | El nombre completo es lo que se cita en un ticket |
| Valor | En unidades de ingeniería, siempre ([D-16](../alcance/decisiones.md#d-16-el-nucleo-trabaja-en-unidades-de-ingenieria)) |
| Modo | `auto` o `forced`, visualmente inequívoco |
| Actor | Quién la forzó, si está forzada |
| Calidad | Solo visible cuando no es `ok` |
| Dirección Modbus | Unit, espacio y dirección convencional, como dato de diagnóstico |

El valor crudo del registro se muestra **solo bajo demanda**, junto a la dirección. Es dato de
puesta a punto, no de operación.

### Estados que deben saltar a la vista

Tres condiciones tienen que ser visibles de un vistazo, sin buscarlas:

- **Señales forzadas.** Es el estado que explica cualquier comportamiento raro del controlador.
- **Propagación cortada.** Un banco en estado incoherente sin que se note produce diagnósticos
  equivocados sobre el controlador
  ([Modos de señal](../arquitectura/senales-modos.md#cortar-la-propagacion-es-una-capacidad-no-un-fallo)).
- **Calidad distinta de `ok`.**

Debe existir un contador siempre visible del tipo «7 señales forzadas, 2 sin propagación», con
acceso directo a la lista, y una acción de **liberar todo**.

## Forzado

Un control por señal, adecuado a su tipo: conmutador para booleanas, campo numérico con el rango
de ingeniería para analógicas.

- La liberación es **instantánea y con salto discontinuo**. La interfaz no debe sugerir lo
  contrario con ninguna animación de transición.
- Forzar fuera del rango declarado **está permitido** y marca la calidad como `range`. La
  interfaz avisa, no impide. Prohibirlo eliminaría una de las pruebas más útiles del banco.
- Cada acción produce un evento con actor.

## Registro de eventos en vivo

Cronología con filtro por tipo, señal y actor. Cada entrada lleva su número de secuencia y su
marca de tiempo monótona.

La sesión completa es **descargable como fichero** para adjuntar a un ticket. Es el entregable
del banco: la conversación con marca de tiempo que el equipo del controlador no puede producir
por su cuenta.

!!! note "Los tiempos son del servidor"
    Las marcas mostradas son `t_us` del simulador, no del navegador. Un reloj de navegador en un
    informe de temporización es una fuente de discusiones inútiles.

## Operadores concurrentes

La demo comparte estado ([Contexto](../alcance/contexto.md#los-dos-usos-del-sistema)). El panel
debe mostrar **cuántos operadores hay conectados** de forma permanente, y atribuir cada forzado
a su autor en la lista de señales y en el registro.

Sin eso, un visitante que fuerza el interlock deja al resto viendo caer el HV sin explicación, y
el fallo se atribuye al controlador.

## Control del stream UDP

Las degradaciones del stream de posición se manejan desde aquí: pérdida, ráfaga, duplicación,
reordenamiento, jitter, congelación, encoder inválido, salto de secuencia y silencio total. La
tabla completa está en la
[especificación UDP](../interfaces/udp-encoder.md#6-comportamiento-del-emisor-simulado).

!!! warning "Congelación y silencio son pruebas distintas"
    En la congelación los paquetes siguen llegando con `seq` creciente y posición constante. En
    el silencio no llega nada. La interfaz debe presentarlas como controles separados y no
    inducir a confundirlas.

Cada activación y desactivación se registra como evento, igual que un forzado.

## Alcance por fase

| Elemento | Fase |
|---|---|
| Lista de señales, forzado, liberación | 1 |
| Registro en vivo y descarga de sesión | 1 |
| Contadores de estado anómalo y liberar todo | 1 |
| Operadores conectados y atribución | 1 |
| Control de degradaciones UDP | 2 |
| Corte de propagación por señal | 2 |
| Panel de aserciones y escenarios | 3 |
