# RD100S-ENC-UDP · Especificación del stream de posición

!!! abstract "Documento normativo"
    **Identificador:** RD100S-ENC-UDP
    **Versión:** 1 (borrador)
    **Estado:** propuesta, contiene valores provisionales
    **Vinculante para:** equipo de FPGA (emisor real), equipo de controlador (receptor),
    equipo de emulador (emisor simulado)

Este documento define el contrato de un canal que **tres implementaciones independientes**
deben respetar. El controlador debe leer la posición del emulador exactamente igual que la
leería de la FPGA, sin reconfiguración ni build distinto. Cualquier detalle que quede implícito
aquí se implementará de forma divergente en los tres lados y el problema aparecerá tarde.

!!! danger "Valores provisionales"
    La escala angular, la unidad de marca de tiempo, la cadencia y los bits de estado están
    **inventados como marcador de posición** para desbloquear la implementación. Ver
    [PEND-01](../alcance/pendientes.md#pend-01-escala-de-azimut-y-elevacion) a
    [PEND-05](../alcance/pendientes.md#pend-05-crc-en-el-paquete). No congelar la versión 1 sin
    revisarlos con los tres equipos.

## 1. Transporte

| Propiedad | Valor |
|---|---|
| Protocolo | UDP sobre IPv4 |
| Modo | Unicast a destino único configurado |
| Puerto destino | `5100` (configurable) |
| Puerto origen | efímero, irrelevante para el receptor |
| Patrón | emisión periódica libre, sin petición-respuesta |
| Cadencia nominal | 100 Hz — un paquete cada 10 ms |
| Jitter admisible | ±2 ms |
| Tamaño de datagrama | 36 octetos exactos, siempre |

El emisor no mantiene estado de sesión, no atiende peticiones y no espera confirmación. El
receptor no responde nada.

!!! note "Por qué UDP y no TCP"
    La posición es un dato donde la muestra vieja no sirve de nada. La pérdida es tolerable y la
    retransmisión es contraproducente: TCP produciría bloqueo de cabecera de línea para
    entregar datos ya caducos. Además, el emisor real es una FPGA con FreeRTOS y lwIP, donde
    UDP crudo con struct de tamaño fijo evita parsing de longitud variable y asignación
    dinámica.

No hay multicast, descubrimiento ni suscripción. El destino se configura estáticamente en el
emisor. Solo existe un consumidor.

## 2. Formato del paquete

**Endianness: little-endian** para todos los campos multi-octeto. Sin relleno: los campos están
naturalmente alineados y la estructura ocupa 36 octetos en C sin directivas de empaquetado.

| Offset | Tamaño | Tipo | Campo | Descripción |
|---:|---:|---|---|---|
| 0 | 2 | `u16` | `magic` | `0x5244`. Descarta tráfico ajeno al puerto |
| 2 | 1 | `u8` | `version` | `0x01`. Ver §5 |
| 3 | 1 | `u8` | `reserved0` | Cero en emisión, ignorado en recepción |
| 4 | 4 | `u32` | `seq` | Secuencia monótona, +1 por paquete |
| 8 | 8 | `u64` | `t_us` | Microsegundos desde arranque del emisor |
| 16 | 4 | `i32` | `az_mdeg` | Azimut en milésimas de grado |
| 20 | 4 | `i32` | `el_mdeg` | Elevación en milésimas de grado |
| 24 | 4 | `i32` | `az_rate` | Velocidad de azimut, mdeg/s |
| 28 | 4 | `i32` | `el_rate` | Velocidad de elevación, mdeg/s |
| 32 | 2 | `u16` | `status` | Palabra de estado, ver §3 |
| 34 | 2 | `u16` | `reserved1` | Cero en emisión, ignorado en recepción |

```c
/* RD100S-ENC-UDP v1 — 36 octetos, little-endian */
typedef struct {
    uint16_t magic;      /* 0x5244                       */
    uint8_t  version;    /* 0x01                         */
    uint8_t  reserved0;  /* 0                            */
    uint32_t seq;        /* monotona, envuelve en 2^32   */
    uint64_t t_us;       /* us desde arranque del emisor */
    int32_t  az_mdeg;    /* 0 .. 359999                  */
    int32_t  el_mdeg;    /* -90000 .. +90000             */
    int32_t  az_rate;    /* mdeg/s con signo             */
    int32_t  el_rate;    /* mdeg/s con signo             */
    uint16_t status;     /* ver seccion 3                */
    uint16_t reserved1;  /* 0                            */
} rd100s_enc_pkt_t;
```

### Campos angulares

Escala fija: **1 unidad = 0,001 grados**.

- `az_mdeg` en `0..359999`, con envolvente. Nunca negativo. El paso de 359999 a 0 es un salto
  legítimo que el receptor debe manejar al calcular velocidad por diferencias.
- `el_mdeg` en `-90000..+90000`. Los valores fuera del recorrido mecánico son posibles durante
  fallo de encoder y no deben tratarse como error de protocolo.

Los campos de velocidad se incluyen porque el emisor los conoce con mejor precisión que la que
el receptor obtendría derivando posiciones sucesivas, especialmente si pierde paquetes. Son
informativos: el receptor puede ignorarlos.

### Secuencia

`seq` se incrementa en uno por paquete emitido y envuelve en `2^32`. Permite al receptor
detectar pérdidas y reordenamientos, y al emulador **inyectarlos deliberadamente**.

El receptor no debe asumir que el primer paquete que recibe tiene `seq` cero: el emisor puede
llevar horas emitiendo.

### Marca de tiempo

`t_us` es **monótona**, en microsegundos, con origen en el arranque del emisor. No es hora de
pared y no tiene relación con ninguna referencia absoluta.

!!! warning "Requisito de implementación en el emulador"
    Debe derivarse del reloj monótono del proceso, nunca de la hora del sistema. Un ajuste NTP
    en el nodo Swarm haría saltar los timestamps hacia atrás en mitad de una prueba y
    corrompería la traza.

El receptor debe usar `t_us` —y no su propia hora de llegada— para calcular intervalos. Así el
jitter de red y el jitter del lazo del emisor no contaminan la medida.

Un reinicio del emisor se manifiesta como `t_us` que retrocede junto con `seq` que retrocede.
El receptor debe tratar esa combinación como reinicio, no como corrupción.

## 3. Palabra de estado

Bit 0 es el menos significativo.

| Bit | Nombre | Significado cuando vale 1 |
|---:|---|---|
| 0 | `AZ_VALID` | La lectura de azimut es válida |
| 1 | `EL_VALID` | La lectura de elevación es válida |
| 2 | `AZ_REF_OK` | El eje de azimut está referenciado |
| 3 | `EL_REF_OK` | El eje de elevación está referenciado |
| 4 | `AZ_FAULT` | Fallo detectado en la cadena de azimut |
| 5 | `EL_FAULT` | Fallo detectado en la cadena de elevación |
| 6 | `SIM` | **El paquete procede del emulador, no de la FPGA** |
| 7 | `DEGRADED` | El emisor opera en modo degradado o de inyección de fallo |
| 8-15 | — | Reservados, cero en emisión, ignorados en recepción |

!!! important "El bit SIM"
    La FPGA real emite `SIM = 0` siempre. El emulador emite `SIM = 1` siempre. El controlador
    **no debe alterar su comportamiento** en función de este bit: existe para que las trazas
    capturadas sean identificables sin ambigüedad y para detectar el error de haber dejado el
    emulador conectado en una prueba con hardware real.

`AZ_VALID` en cero significa que `az_mdeg` no es de fiar. El receptor debe descartar el valor,
no interpretarlo como posición cero.

Los bits definidos son una propuesta razonada, no un requisito recogido del sistema real. Los
que ningún equipo produzca ni consuma deben eliminarse antes de congelar la versión
([PEND-04](../alcance/pendientes.md#pend-04-palabra-de-estado-del-paquete)).

## 4. Integridad

No se incluye CRC. Se delega en el checksum de UDP, que es obligatorio en IPv4 para datagramas
con checksum distinto de cero.

Un receptor **debe descartar silenciosamente** cualquier datagrama que no cumpla las tres
condiciones: longitud exactamente 36 octetos, `magic` igual a `0x5244`, y `version` reconocida.
Descartar en silencio, sin registrar por cada paquete, para que un emisor mal configurado no
inunde el registro del receptor.

Ver [PEND-05](../alcance/pendientes.md#pend-05-crc-en-el-paquete) si el equipo de FPGA requiere
verificación adicional; añadirlo después obliga a incrementar la versión.

## 5. Versionado

`version` identifica el formato completo del paquete. Un receptor que encuentre una versión que
no conoce descarta el datagrama.

Cambios que **exigen** incrementar `version`: alterar cualquier offset o tamaño, cambiar la
escala de un campo, cambiar la unidad o el origen de `t_us`, redefinir un bit ya asignado,
añadir CRC.

Cambios que **no** la incrementan: asignar un bit reservado de `status`, ajustar la cadencia
nominal, cambiar el puerto por defecto.

## 6. Comportamiento del emisor simulado

Además de emitir el stream nominal, el emulador debe poder degradarlo bajo control del
operador. Con hardware real estas condiciones son casi imposibles de provocar de forma
controlada, y son de las pruebas más valiosas que ofrece el banco.

| Degradación | Parámetro | Qué prueba |
|---|---|---|
| Pérdida de paquetes | probabilidad, o patrón fijo 1 de cada N | Tolerancia a huecos y uso de `seq` |
| Ráfaga de pérdida | duración del corte | Recuperación tras silencio |
| Duplicación | probabilidad | Idempotencia frente a `seq` repetida |
| Reordenamiento | ventana de retardo | Manejo de `seq` no monótona |
| Jitter de emisión | desviación máxima | Dependencia de la cadencia nominal |
| Congelación | activar/desactivar | Detección de posición estancada con `seq` avanzando |
| Encoder inválido | `AZ_VALID` / `EL_VALID` a cero | Reacción a lectura no fiable |
| Salto de secuencia | delta a aplicar | Detección de reinicio del emisor |
| Silencio total | activar/desactivar | Timeout del receptor |

Cada activación y desactivación se registra como evento con marca de tiempo, igual que
cualquier forzado de señal.

!!! note "Congelación contra silencio"
    Son pruebas distintas. En la congelación los paquetes siguen llegando con `seq` creciente y
    posición constante: un receptor que solo vigile la llegada de datagramas no lo detectará. En
    el silencio no llega nada.

## 7. Comportamiento esperado del receptor

Recomendaciones para el equipo de controlador, no exigencias.

- Declarar pérdida de stream tras un timeout configurable, sugerido en 100 ms —diez periodos
  nominales— y actuar en consecuencia sobre el lazo de posición.
- Contabilizar huecos de `seq` como métrica de calidad del enlace.
- Tratar `seq` y `t_us` retrocediendo simultáneamente como reinicio del emisor: reinicializar el
  estado de seguimiento en vez de intentar reconciliar.
- No confiar en la periodicidad de llegada para temporizar nada. Usar `t_us`.

## 8. Configuración en el emulador

```json
{
  "encoder_udp": {
    "enabled": true,
    "spec": "RD100S-ENC-UDP v1",
    "dest_host": "controller",
    "dest_port": 5100,
    "src_port": 0,
    "rate_hz": 100,
    "azimuth_signal": "ant.az_position",
    "elevation_signal": "ant.el_position",
    "az_rate_signal": "ant.az_rate",
    "el_rate_signal": "ant.el_rate"
  }
}
```

Las señales de origen son configurables por diseño: permiten alimentar el stream desde
cualquier señal, incluida una forzada manualmente por el operador, sin tocar código.
