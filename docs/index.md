# Emulador de Radar Meteorológico RD100S

Banco de pruebas software para el controlador del radar RD100S. Emula la planta del radar
—transmisor, antena, receptor y subsistema de encendido/clima— exponiendo al controlador
las mismas interfaces que encontraría en el equipo real: un servidor **Modbus TCP** para el
control discreto y de potencia, y un **stream UDP de posición de encoder** equivalente al que
emite la FPGA.

!!! warning "El controlador no forma parte de este proyecto"
    El controlador del radar es software de otro equipo. Aparece en esta documentación
    únicamente como consumidor de las interfaces que aquí se especifican. El emulador nunca
    asume nada sobre su implementación interna.

## Qué resuelve

Probar el controlador contra hardware real es lento, caro y no permite provocar fallos a
voluntad. No se puede pedir a un magnetrón que entre en sobrecorriente a las 14:32:05 para
comprobar que el controlador retira la alta tensión en menos de 200 ms. El emulador sí puede,
de forma repetible y con marca de tiempo.

Tres capacidades definen el valor del sistema.

- **Forzado en caliente de cualquier señal** desde la interfaz web, incluyendo estados
  físicamente imposibles, para verificar que el controlador se protege.
- **Coherencia física opcional**: el modelo propaga causas (abrir el radomo abre el interlock,
  que retira el HV) y puede desactivarse para inyectar incoherencias deliberadas.
- **Evidencia auditable**: registro con marca de tiempo de cada transacción Modbus, cada
  cambio de estado y cada acción del operador, evaluable contra aserciones temporales.

## Cómo está organizado

| Sección | Contenido |
|---|---|
| [Alcance](alcance/contexto.md) | Contexto, decisiones tomadas y su porqué, y lista viva de pendientes |
| [Arquitectura](arquitectura/despliegue.md) | Despliegue en Swarm, núcleo de simulación, modelo de modos de señal |
| [Configuración](configuracion/esquema.md) | Esquema JSON, biblioteca de bloques, semilla RD100S |
| [Interfaces](interfaces/modbus.md) | Mapa Modbus y **especificación normativa del paquete UDP** |
| [Interfaz de usuario](ui/editor.md) | Editor de configuración y panel de operación |
| [Implementación](implementacion/stack.md) | Stack tecnológico, fases de trabajo, observabilidad |

## Documentos normativos

La [especificación del paquete UDP de encoder](interfaces/udp-encoder.md) es un **contrato
entre tres implementaciones**: el emulador, la FPGA y el controlador. Tiene versionado propio
y está redactada para poder extraerse de este sitio y entregarse a los otros dos equipos.

!!! danger "Estado del proyecto"
    Documento de diseño previo a implementación. Varias magnitudes físicas y campos de
    protocolo están **inventados como marcador de posición** y marcados como pendientes.
    Consultar [Pendientes](alcance/pendientes.md) antes de tomar cualquier valor como bueno.
