# Semilla RD100S

!!! danger "Página bloqueada · falta la fuente"
    Esta página **no se ha podido reconstruir**. Se derivaba de un documento con el mapa real de
    entradas y salidas del RD100S que se perdió junto con la sesión original. Sin ese fichero no
    hay forma de regenerar el contenido sin inventarlo, y inventar un mapa de señales que
    aparenta ser real sería peor que no tener la página.
    
    **Acción requerida:** recuperar el documento fuente del mapa de E/S del RD100S y regenerar
    esta página junto con el fichero `config/rd100s.json`.

## Qué es la semilla

Un fichero de configuración por defecto que permite empezar a probar contra el RD100S sin
escribir el JSON desde cero. **No es parte del código y no tiene ningún estatus especial**: es
una configuración más, que el usuario puede modificar o reemplazar entera
([Contexto](../alcance/contexto.md#el-sistema-no-es-especifico-del-rd100s)).

## Estructura esperada

Cuando se regenere, esta página debe documentar:

- Los cuatro subsistemas como espacios de nombres: `tx`, `ant`, `rx`, `env`.
- La tabla completa de señales por subsistema, con su tipo, unidades, rango de ingeniería y
  destino Modbus.
- El mapeo a los diez unit IDs descritos en
  [Mapa Modbus](../interfaces/modbus.md#unit-ids-de-la-semilla).
- La cadena de interlock del transmisor tal como la modela la semilla.
- Los bloques instanciados con sus parámetros.

## Lo que sí está documentado en otro sitio

El mapeo Modbus de la semilla, los unit IDs, la regla de direccionamiento y los tres módulos no
cubiertos por el Apéndice G están en [Mapa Modbus](../interfaces/modbus.md), que sí sobrevivió.
Esa página es utilizable tal cual mientras esta se regenera.

## Advertencia permanente

!!! warning "Todo valor físico de la semilla es provisional"
    Rangos de ingeniería
    ([PEND-06](../alcance/pendientes.md#pend-06-codificacion-y-escalado-de-las-senales-analogicas)),
    direcciones de tres módulos
    ([PEND-07](../alcance/pendientes.md#pend-07-mapa-modbus-de-los-modulos-4069-4117-y-4150)),
    unit IDs ([PEND-08](../alcance/pendientes.md#pend-08-unit-ids-reales-del-gateway)),
    tiempos, umbrales y coeficientes (PEND-10 a PEND-16). La semilla sirve para arrancar, no para
    concluir nada sobre el radar real.
