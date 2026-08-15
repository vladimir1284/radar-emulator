# Stack tecnológico

## Elecciones

| Capa | Elección | Estado |
|---|---|---|
| Lenguaje | TypeScript, un solo proyecto | firme ([D-04](../alcance/decisiones.md#d-04-el-nucleo-se-escribe-en-typescript)) |
| Runtime | Node LTS | firme |
| Servidor Modbus | `jsmodbus` o `modbus-serial` | **sin verificar** ([PEND-21](../alcance/pendientes.md#pend-21-verificacion-de-la-libreria-servidor-modbus)) |
| UDP | `node:dgram` | firme, sin dependencia |
| WebSocket | `ws` | firme |
| Registro de eventos | SQLite con `better-sqlite3`, modo WAL | firme |
| Validación de configuración | JSON Schema con Ajv | firme |
| Interfaz | SPA ligera servida por el mismo proceso | firme |
| Despliegue | Docker Swarm + `cloudflared` | firme ([D-05](../alcance/decisiones.md#d-05-cloudflare-queda-como-tunel-y-autenticacion-no-como-runtime)) |
| Documentación | MkDocs Material | firme |

## Por qué un solo proceso y un solo lenguaje

Núcleo, servidor Modbus, emisor UDP, servidor WebSocket e interfaz viven en el mismo proceso
Node ([D-01](../alcance/decisiones.md#d-01-nucleo-y-adaptador-modbus-en-el-mismo-proceso)). Un
salto de red entre el adaptador Modbus y el núcleo añadiría jitter que no existe en el radar
real, y el banco existe para medir jitter.

## El riesgo técnico principal

!!! danger "Múltiples unit IDs sobre una sola conexión TCP"
    El diseño exige que el servidor atienda **diez unit IDs sobre la misma conexión TCP**,
    porque las direcciones de los módulos ADAM colisionan entre sí y la resolución es un unit ID
    por módulo físico ([Modbus TCP](../interfaces/modbus.md#las-direcciones-colisionan-entre-modulos)).
    
    `jsmodbus` y `modbus-serial` anuncian modo servidor, pero **no está verificado** que ninguna
    de las dos lo soporte correctamente. Es un requisito duro: si ninguna lo cumple, hay que
    implementar el servidor Modbus TCP a mano sobre `node:net`, lo cual es viable —el
    subconjunto de códigos de función es pequeño— pero cambia la estimación de la fase 1.
    
    **Es lo primero que hay que probar, antes de escribir cualquier otra cosa.**

Además del multi-unit, la prueba de concepto debe verificar dos cosas más de la librería
candidata: que permite responder **excepción** ante una escritura sobre una coil de solo lectura,
y que expone el instante de recepción de cada trama con resolución suficiente para el registro.

## Códigos de función a implementar

Solo seis, por cómo Advantech usa los espacios de direcciones:

| FC | Función | Uso |
|---|---|---|
| 01 | Read Coils | DI y DO |
| 03 | Read Holding Registers | AI y AO |
| 05 | Write Single Coil | DO |
| 06 | Write Single Register | AO |
| 15 | Write Multiple Coils | DO |
| 16 | Write Multiple Registers | AO |

FC02 y FC04 **no se usan**: las entradas digitales viven en `0X` y las analógicas en `4X`. Ver
[Modbus TCP](../interfaces/modbus.md#advantech-no-usa-los-espacios-1x-ni-3x).

## Estructura del repositorio

```
rd100s-emu/
├── src/
│   ├── core/          # estado, tick, grafo, modos de señal
│   ├── config/        # esquema, validación, carga
│   ├── adapters/
│   │   ├── modbus/    # servidor, mapeo, conversión de crudo
│   │   ├── udp/       # emisor de encoder y degradaciones
│   │   └── ws/        # telemetría, eventos, órdenes
│   ├── log/           # SQLite, sesiones, descarga
│   ├── blocks/        # biblioteca de comportamiento (fase 2)
│   └── ui/            # SPA
├── config/            # rd100s.json y otras configuraciones
├── scenarios/         # escenarios y aserciones (fase 3)
├── docs/              # este sitio
├── stack.yml
└── mkdocs.yml
```

El núcleo **no importa nada de `adapters/`**. La dependencia va en un solo sentido y conviene
imponerlo con una regla de lint, no solo por convención: es lo que mantiene el modelo
independiente de los transportes.

## Convenciones

- **Reloj monótono** en todo lo que se registre o se emita. Nunca hora de pared.
- **Marcado `// PEND-nn`** en cada punto donde se use un valor provisional.
