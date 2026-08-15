# Spike fase 0 — servidor Modbus multi-unit

Prueba de concepto de [PEND-21](../docs/alcance/pendientes.md#pend-21-verificacion-de-la-libreria-servidor-modbus-resuelto-en-fase-0).
Resultado documentado en [D-17](../docs/alcance/decisiones.md#d-17-servidor-modbus-tcp-sobre-modbus-serial-no-jsmodbus).

No es código de producción — se descarta o se referencia, no se extiende.

```
pnpm install
pnpm exec tsx test-jsmodbus-multiunit.ts   # demuestra que jsmodbus NO enruta por unitId
pnpm exec tsx test-modbus-serial.ts        # demuestra que modbus-serial SI cumple los 4 puntos
```
