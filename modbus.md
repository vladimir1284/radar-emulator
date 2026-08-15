# Interfaz Modbus TCP

El emulador actúa como **servidor** Modbus TCP. El controlador es el cliente y el único
maestro.

!!! note "El mapa es configurable"
    Nada de lo que sigue está cableado en el código. El mapa vive en el JSON de configuración y
    el usuario puede rehacerlo entero desde la interfaz. Lo que sigue es la **semilla por
    defecto**, derivada del Apéndice G del manual ADAM-4000 para que las pruebas contra el
    RD100S no partan de cero.

## Hallazgos del Apéndice G

Tres cosas del manual condicionan el diseño y no son evidentes.

### Advantech no usa los espacios 1X ni 3X

Las entradas digitales de solo lectura viven en el espacio **`0X`**, que en numeración Modicon
es el de *coils*, no el de *discrete inputs*. Las entradas analógicas viven en **`4X`**,
*holding registers*, no en *input registers*.

!!! important "Consecuencia para el controlador"
    Las lecturas de DI se hacen con **FC01 (Read Coils)**, no con FC02. Las lecturas de AI con
    **FC03 (Read Holding Registers)**, no con FC04. El emulador debe implementar coils con
    atributo de solo lectura: una escritura sobre una coil de entrada debe responder excepción,
    no aceptarse en silencio.

Como consecuencia práctica, el emulador solo necesita implementar cuatro espacios de
direcciones de los cuales dos quedan vacíos, y estos códigos de función:

| FC | Función | Uso |
|---|---|---|
| 01 | Read Coils | DI y DO |
| 03 | Read Holding Registers | AI y AO |
| 05 | Write Single Coil | DO |
| 06 | Write Single Register | AO |
| 15 | Write Multiple Coils | DO |
| 16 | Write Multiple Registers | AO |

### Las direcciones colisionan entre módulos

El ADAM-4051 sitúa sus 16 DI en `00001..00016`. El ADAM-4024 sitúa sus cuatro *Emergency DI
Input Flag* en `00001..00004`. Dentro de un mismo unit ID serían la misma dirección.

La resolución es que **cada módulo físico es un unit ID distinto**. En el sistema real cada
módulo es un nodo RS-485 con su propia dirección, y el gateway la traduce a unit ID. El
emulador replica ese modelo: diez unit IDs para los diez módulos del RD100S.

### El manual atribuye salidas analógicas a un módulo que no las tiene

El Apéndice G asigna al 4051 —16 entradas digitales— cuatro registros `4X` en `40001..40004`
etiquetados *Current Output Value R/W*. Un módulo exclusivamente de entrada digital no tiene
salidas analógicas; con alta probabilidad es un error de copia heredado de la tabla del 4024.

La semilla ignora esos registros. Ver [PEND-22](../alcance/pendientes.md#pend-22-anomalia-documental-en-el-adam-4051).

## Regla de mapeo por defecto

| Tipo | Espacio | Dirección convencional | Dirección de cable | Acceso |
|---|---|---|---|---|
| DI | `0X` | `00001 + canal` | `canal` | solo lectura |
| DO | `0X` | `00017 + canal` | `16 + canal` | lectura/escritura |
| AI | `4X` | `40001 + canal` | `canal` | solo lectura |
| AO | `4X` | `40001 + canal` | `canal` | lectura/escritura |

!!! warning "Convencional contra cable"
    La numeración de cinco dígitos del manual es **convencional**, base 1. La dirección que
    viaja en la trama Modbus es base 0: `00001` se transmite como `0`, `40001` como `0`. El
    JSON almacena **ambas**: `address` es la de cable y `conventional` es la del manual, para
    que sea trivial cotejar con la documentación de Advantech durante la puesta a punto.

## Unit IDs de la semilla

| Unit ID | Subsistema | Módulo | Contenido |
|---:|---|---|---|
| 1 | Transmitter | ADAM 4051 | 16 DI |
| 2 | Transmitter | ADAM 4024 | 4 DI + 4 AO |
| 3 | Transmitter | ADAM 4069 | 8 DO |
| 4 | Transmitter | ADAM 4117 | 8 AI |
| 11 | Antenna | ADAM 4051 | 16 DI |
| 12 | Antenna | ADAM 4024 | 4 DI + 4 AO |
| 13 | Antenna | ADAM 4069 | 8 DO |
| 14 | Antenna | ADAM 4117 | 8 AI |
| 21 | Receiver | ADAM 4150 | 7 DI + 8 DO |
| 31 | On/Off/Climate | ADAM 4055 | 8 DI + 8 DO |

Los números concretos son arbitrarios y deben ajustarse a las direcciones RS-485 reales
([PEND-08](../alcance/pendientes.md#pend-08-unit-ids-reales-del-gateway)).

!!! danger "Requisito duro sin verificar"
    El servidor debe atender **múltiples unit IDs sobre una sola conexión TCP**. No está
    verificado que las librerías candidatas lo soporten correctamente. Es lo primero que hay
    que probar ([PEND-21](../alcance/pendientes.md#pend-21-verificacion-de-la-libreria-servidor-modbus)).

## Módulos no cubiertos por el Apéndice G

El apéndice aportado documenta 4015, 4018+, 4017+, 4019+, 4024, 4051, 4055, 4056S, 4056SO y
4068. **No cubre 4069, 4117 ni 4150**, que sí aparecen en el mapa de señales del RD100S.

Sus direcciones en la semilla son **inferidas por analogía funcional**, no leídas de un manual:

| Módulo | Función | Análogo usado | Direcciones inferidas |
|---|---|---|---|
| ADAM 4069 | 8 salidas de relé | ADAM 4068 | DO en `00017..00024` |
| ADAM 4117 | 8 entradas analógicas | ADAM 4017+ | AI en `40001..40008` |
| ADAM 4150 | 7 DI + 8 DO | ADAM 4055 | DI en `00001..00007`, DO en `00017..00024` |

Verificar contra los manuales correspondientes antes de una prueba formal
([PEND-07](../alcance/pendientes.md#pend-07-mapa-modbus-de-los-modulos-4069-4117-y-4150)).

## Señales analógicas

El manual lista los registros de valor pero **no la conversión a unidades de ingeniería**, que
depende del *Type Code* de cada canal en `40201` y siguientes.

Cada señal analógica del JSON lleva por tanto dos capas:

```json
{
  "units": "kV",
  "range": [0.0, 30.0],
  "raw": {
    "encoding": "int16",
    "raw_range": [0, 65535],
    "note": "PENDIENTE: confirmar codificacion y rango crudo del modulo real"
  }
}
```

El núcleo trabaja siempre en unidades de ingeniería. La conversión a crudo ocurre únicamente en
el adaptador Modbus, en el borde. **Todos los rangos de ingeniería de la semilla son
invención** ([PEND-06](../alcance/pendientes.md#pend-06-codificacion-y-escalado-de-las-senales-analogicas)).

## Registros de identidad de módulo

El apéndice define registros de nombre de módulo, versión y *Comm Safety* en `40211..40216`, y
habilitación de canal en `40221`. Si el controlador los interroga durante la puesta en marcha,
el emulador debe responder con los valores del manual. La semilla **no los incluye**; se añaden
si se comprueba que el controlador los consulta.

Valores del manual, para referencia:

| Módulo | Module Name 1 | Module Name 2 |
|---|---|---|
| ADAM 4024 | `0x4024` | `0x0000` |
| ADAM 4051 | no documentado | no documentado |
| ADAM 4055 | `0x4055` | `0x0000` |
| ADAM 4068 | `0x4068` | `0x0000` |

## Comandos por flanco

Varios comandos aparecen como pares mutuamente excluyentes: `Turn On Tx` / `Turn Off Tx`,
`Turn On RFE` / `Turn Off RFE`, `Turn On Radar` / `Turn Off Radar`. Eso indica comandos
momentáneos sobre una máquina de estados enclavada en el radar, no bits de nivel.

El emulador detecta **flanco de subida**, no nivel. Dos consecuencias a implementar:

- Un pulso más corto que el tick puede perderse. El adaptador Modbus marca el flanco al recibir
  la escritura y el lazo lo consume en el siguiente tick, aunque la señal ya haya vuelto a
  cero.
- Si ambos comandos del par están activos simultáneamente, **prevalece apagar**. Es el estado
  seguro. La regla es explícita en la configuración, no implícita en el código.
