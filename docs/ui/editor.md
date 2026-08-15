# Editor de configuración

!!! danger "Página incompleta · fuera de la fase 1"
    Esta página es un **esqueleto**. En la versión actual el JSON de configuración
    [se escribe a mano](../configuracion/esquema.md), y un editor gráfico de señales, bloques y
    conexiones es un proyecto en sí mismo que no debe abordarse antes de tener el núcleo, el
    servidor Modbus y el panel de operación funcionando.

## Decisión vigente

El JSON se edita a mano. Eso traslada la exigencia a dos sitios:

- El **esquema debe ser verboso y explícito**, sin azúcar sintáctico ni valores implícitos que
  solo se entiendan leyendo el código.
- La **validación debe producir errores legibles** con la ruta JSON del nodo culpable. Es lo que
  sustituye al editor: un fichero de mil líneas escrito a mano necesita que el sistema diga
  exactamente dónde está el fallo.

Ver [Validación](../configuracion/esquema.md#validacion).

## Lo mínimo que sí entra en la fase 1

No un editor, pero sí tres cosas sin las que operar es incómodo:

| Función | Por qué |
|---|---|
| Ver la configuración cargada | Saber contra qué radar se está probando |
| Ver el hash del JSON aplicado | Es el identificador que aparece en el registro de sesión |
| Recargar configuración desde fichero | Iterar sin reiniciar el contenedor |

La recarga arranca **sesión nueva**. Mezclar en una misma sesión eventos producidos bajo dos
configuraciones distintas haría el registro inutilizable como evidencia.

## Si algún día se aborda

Cuestiones que habría que resolver antes de escribir una línea:

- **Qué se edita.** Un editor de señales y mapeo Modbus es una tabla. Un editor de bloques y
  conexiones es un lienzo de grafo. Son dos productos distintos y el segundo es
  desproporcionado frente al valor que aporta.
- **Ida y vuelta con el fichero.** Si el editor reescribe el JSON, debe preservar comentarios,
  orden y notas `PEND-nn`, o destruirá información que solo existe ahí.
- **Semántica de la edición en caliente.** Ver
  [cuestiones abiertas de la biblioteca de bloques](../configuracion/bloques.md#cuestiones-abiertas):
  qué conserva estado y qué se reinicializa al aplicar una configuración modificada.
