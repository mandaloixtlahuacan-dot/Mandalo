# Mándalo — Estado del proyecto

> Este archivo es el estado operativo: qué está listo, qué está roto, qué falta construir.
> Para reglas de negocio y arquitectura estable, ver `CLAUDE.md` (fuente de verdad).
> Última actualización: 08 de agosto de 2026, tras el merge de `fix/captura-conversacional` a `main`.

## ✅ Completo y confirmado en producción

- **Fase 1 — esquema aditivo** (2026-08-04): tablas definitivas (`tiendas`, `clientes`, `repartidores`, `productos_tienda`, `pedidos`, `pedido_tiendas`, `pedido_items`) creadas en paralelo al esquema legacy, con backfill de datos maestros. `supabase/migrations/20260804_fase1_esquema_definitivo.sql`.
- **Fase 2 — reescritura de código** (merge 2026-08-07): capa de datos y lógica de negocio reescritas sobre el esquema definitivo (`captureEngine.ts`, `validationEngine.ts`, `pedidoRepositoryV2.ts`, `stateTransitionService.ts`), outbox general vía `admin_notificaciones` con claim atómico (`FOR UPDATE SKIP LOCKED`).
- **Fase 3 — corte de tablas** (2026-08-07): tablas nuevas renombradas a sus nombres finales, legacy renombradas a `*_legacy_20260805` (no borradas). Código actualizado para referenciar los nombres finales. `supabase/migrations/20260805_fase3_corte.sql`.
- **Cobertura geográfica**: validación Haversine (centro 20.865831,-103.240017, radio 1.5km) antes de crear cualquier registro. Radio **provisional**, pendiente de calibrar con direcciones reales (ver CLAUDE.md Sección 14).
- **Entrega de mensajes (outbox)**: trigger `pg_net` en `admin_notificaciones` dispara `/api/internal/admin-outbox` en cada INSERT — reemplaza al cron (no disponible en plan Hobby).
- **Flujo de un pedido de una sola tienda, de punta a punta**: saludo → captura conversacional (tienda, producto, dirección) → confirmación del cliente → cotización de tienda → asignación de repartidor → `#RECOGI` → `#ENTREGADO` → notificaciones al cliente en cada paso, incluyendo el cierre "gracias por tu compra y por confiar en nosotros" (`mandaloFlow.ts:858`).
- **Fix de captura conversacional** (merge 2026-08-08, commit `5809027`): la IA responde con lenguaje natural mientras falta información, en vez de repetir plantillas fijas; `items` se fusionan entre turnos en vez de perderse; prompt reforzado para no soltar tienda/dirección/productos ya capturados; saludo inicial según hora del día (America/Mexico_City). **⚠️ Mergeado a `main` pero todavía sin confirmar en vivo por Víctor vía WhatsApp real** — validar antes de dar esto por cerrado del todo.

## 🔴 Bugs conocidos, sin arreglar

- **`getOpenPedidoByCustomerPhone` no filtra por `estado`** (`pedidoRepositoryV2.ts:94-112`) — un pedido `entregado`/`cancelado` se sigue devolviendo como "abierto" para ese teléfono en el siguiente mensaje, porque nada borra esas filas (ver retención abajo). Riesgo real: un cliente que ya recibió su pedido y escribe de nuevo podría "resucitar" ese pedido viejo y mezclar datos con uno nuevo. Descubierto 2026-08-08 al limpiar pedidos de prueba.
- **Retención no implementada**: CLAUDE.md Sección 4 dice "al llegar a `entregado`/`cancelado` se elimina el registro" — no existe ningún `DELETE` sobre `pedidos` en el código (solo hay uno sobre `pedido_items` dentro de `replacePedidoItems`). Esto es la causa raíz del bug anterior.
- **Asignación de repartidor no es "notificar a todos, el primero que confirme se lo queda"** (CLAUDE.md Sección 8) — `findActiveCourier()` (`mandaloFlow.ts:275-295`) elige un solo repartidor determinísticamente (`order by id limit 1`), sin broadcast a los demás. Tampoco hay claim atómico a nivel de base de datos: `writePedidoState` (`stateTransitionService.ts:114-135`) hace un `update` sin guarda condicional (`.eq("estado", ...)`) — dos confirmaciones casi simultáneas podrían, en teoría, generar una condición de carrera.
- **El worker de timeout de repartidor está huérfano**: existe el código (`courier-timeout-worker`) y usa **5 minutos**, no los 7 documentados (que además son para timeout de *tienda*, un concepto distinto — ver abajo). Pero nada lo dispara en producción: `vercel.json` tiene `"crons": []` y no hay ningún trigger de Supabase (`pg_net`) apuntándole, a diferencia de `admin-outbox`. Corre solo si alguien lo invoca a mano.

## ⚪ No construido todavía (falta para el flujo completo de Mándalo)

- **Multi-tienda real**: el esquema (`pedido_tiendas`) lo soporta, pero `pedidoRepositoryV2.upsertPedidoTienda`/`getPedidoTiendaId` solo crean/leen **una** fila de `pedido_tiendas` por pedido (`pedidoRepositoryV2.ts:60-92`) — un pedido nunca puede tener dos tiendas hoy, aunque la Sección 6 del CLAUDE.md lo describe como flujo estándar ("puede incluir varias tiendas").
- **Recargo de `servicio_repartidor` por tienda adicional** ($35 + $15 × tiendas extra, CLAUDE.md Sección 5) — hoy es un monto fijo de $35 sin escalar (consistente con que no hay multi-tienda real todavía).
- **Timeout de 7 minutos por tienda que no responde** (cancelar esa parte del pedido, avisar a las demás tiendas) — no existe ningún código para esto. No confundir con el timeout de repartidor (5 min, huérfano, ver arriba) — son dos timeouts distintos y ninguno de los dos tiendas está construido.
- **Timeout de 10 minutos si el cliente no responde a un `ajuste_producto`** — el estado `ajuste_producto` existe en la máquina de estados (`orderStateMachine.ts`) pero no tiene ninguna lógica de manejo real.
- **Comando explícito de "cambio de repartidor"** (nombre exacto pendiente de definir, CLAUDE.md Sección 14) — hoy la reasignación solo pasa automáticamente por timeout (`stateTransitionService.handleCourierReassignmentQueued`); no hay comando que un repartidor pueda usar a medio pedido para pedir relevo.
- **Validación de horario de tienda** (`hora_apertura`/`hora_cierre`) antes de ofrecerla al cliente — no hay ninguna referencia a esos campos en el código; una tienda "cerrada" se sigue mostrando igual que una abierta.
- **Radio de cobertura definitivo** — el valor de 1.5km está puesto pero sigue marcado como provisional en CLAUDE.md Sección 5.

## Cómo mantener esto al día

Cuando termines un ciclo de trabajo (una fase, un fix, una feature), actualiza este archivo antes de cerrar la sesión: mueve el ítem a "Completo" o bórralo de "No construido", y anota cualquier bug nuevo que hayas descubierto en el camino. Si el cambio es de arquitectura/reglas de negocio (no de estado operativo), va en `CLAUDE.md`, no aquí.
