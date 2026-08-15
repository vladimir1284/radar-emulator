# Instrucciones para el agente de desarrollo

## Antes de escribir código

Lee, en este orden:

1. `docs/alcance/contexto.md` — qué es y qué no es este sistema.
2. `docs/alcance/decisiones.md` — **ninguna decisión se revierte sin discutirlo.** Varias tienen
   consecuencias que no son evidentes desde el punto donde se implementan.
3. `docs/alcance/pendientes.md` — **ningún valor físico o de protocolo de esta documentación es
   de fiar** sin comprobar antes si está aquí como pendiente.
4. `docs/implementacion/fases.md` — el plan de trabajo.

## Lo primero que hay que hacer

La **fase 0**: verificar que existe una librería de servidor Modbus TCP que atienda múltiples
unit IDs sobre una sola conexión. Es un requisito duro sin verificar (PEND-21). Reporta el
resultado antes de escribir código de producción; si ninguna sirve, cambia la estimación de la
fase 1.

## Reglas que no se negocian

- **Reloj monótono** en todo lo que se registre o se emita. Nunca hora de pared.
- **El tick nunca bloquea.** No escribe en disco, no envía por socket, no espera a nadie.
- **`src/core/` no importa nada de `src/adapters/`.** La dependencia va en un solo sentido.
- **Unidades de ingeniería en el núcleo.** El valor crudo solo existe en el borde Modbus.
- **Nada específico del RD100S se cablea en el código.** Vive en la configuración JSON.
- Marca `// PEND-nn` en cada punto donde uses un valor provisional.

## Cuando encuentres una contradicción

La documentación tiene tres orígenes: escrita a mano, reconstruida tras una pérdida de sesión, e
inferida. Si algo no cuadra, **pregunta antes de elegir**. En particular:

- D-04 a D-09 de `decisiones.md` están reconstruidas, no son literales.
- `docs/configuracion/semilla-rd100s.md` está bloqueada por falta del documento fuente.
- `docs/configuracion/bloques.md` y `docs/ui/editor.md` son esqueletos deliberados.

## Documentación

El sitio se compila con `mkdocs build --strict`. Si añades una página, entra en el `nav` de
`mkdocs.yml` o el build falla. Mantén esa disciplina: es lo que garantiza que no haya páginas
huérfanas ni enlaces rotos.
