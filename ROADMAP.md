# Mándalo — Estado del proyecto

> Este archivo es el estado operativo: qué está listo, qué está roto, qué falta construir.
> Para reglas de negocio y arquitectura estable, ver `CLAUDE.md` (fuente de verdad).
> Última actualización: 12 de agosto de 2026, rama `fix/cotizacion-tienda-y-pendientes`
> (punchlist completo de `Mandalo_Brief_Final_ClaudeCode_2.md`, sección 7 — sin mergear).

## ✅ Completo y confirmado en producción

- **Fase 1 — esquema aditivo** (2026-08-04): tablas definitivas (`tiendas`, `clientes`, `repartidores`, `productos_tienda`, `pedidos`, `pedido_tiendas`, `pedido_items`) creadas en paralelo al esquema legacy, con backfill de datos maestros. `supabase/migrations/20260804_fase1_esquema_definitivo.sql`.
- **Fase 2 — reescritura de código** (merge 2026-08-07): capa de datos y lógica de negocio reescritas sobre el esquema definitivo, outbox general vía `admin_notificaciones` con claim atómico (`FOR UPDATE SKIP LOCKED`).
- **Fase 3 — corte de tablas** (2026-08-07): tablas nuevas renombradas a sus nombres finales, legacy renombradas a `*_legacy_20260805` (no borradas).
- **Cobertura geográfica**: validación Haversine (centro 20.865831,-103.240017, radio 1.5km) antes de crear cualquier registro. Radio **provisional**, pendiente de calibrar con direcciones reales (ver CLAUDE.md Sección 14).
- **Entrega de mensajes (outbox)**: trigger `pg_net` en `admin_notificaciones` dispara `/api/internal/admin-outbox` en cada INSERT.
- **Fix de captura conversacional** (merge 2026-08-08, commit `5809027`): la IA responde con lenguaje natural mientras falta información; `items` se fusionan entre turnos; saludo inicial según hora del día. **⚠️ Todavía sin confirmar en vivo por Víctor vía WhatsApp real.**

## 🚧 Bloque de trabajo 2026-08-12 (rama `fix/cotizacion-tienda-y-pendientes`, sin mergear ni desplegar)

Punchlist completo del brief, los 14 puntos de la sección 7 — código listo, compila y buildea limpio (`npx tsc --noEmit`, `eslint`, `next build`), **sin probar en vivo contra WhatsApp real todavía**.

1. **Cotización a tienda nunca se disparaba (bug raíz)** — `validationEngine.validateBusiness` daba por válida la tienda con solo el nombre en texto libre, sin exigir el ID real resuelto contra `tiendas`. Cuando el nombre no calzaba (typo, acento, nombre parcial), el pedido llegaba a `confirmacion_cliente` sin fila en `pedido_tiendas` — sin teléfono al que mandar la cotización — y se quedaba varado para siempre al confirmar. Fix en dos capas: `validateBusiness` ahora exige `businessId != null`; red de seguridad en `handleEsperandoConfirmacionInicial` que regresa a `seleccion_productos` si la tienda no se encuentra al confirmar, en vez de dejar el pedido sin salida.
2. **Timeouts unificados de 10 min + recordatorio a los 5** — `orderTimeoutWorker.ts` cubre los tres casos (tienda sin cotizar, cliente sin confirmar precio final, repartidor sin aceptar) vía **pg_cron** cada minuto (no vía Database Webhook — nada cambia en la BD cuando "pasa el tiempo"). Reemplaza y borra el worker huérfano `courierTimeoutWorker.ts` (5 min, reintentaba con otro repartidor); la nueva regla cancela directo y avisa a cliente/tienda. **Necesita que Víctor corra `supabase/migrations/20260812_order_timeout_worker_cron.sql`** (reemplazar placeholders de URL y `CRON_SECRET`) — sin eso, el reloj no arranca.
3. **Precio final combinado al cliente** — ya estaba bien (`handleTiendaMessage`), solo verificado.
4. **Dispatch al repartidor con datos de tienda** — `getPedidoById` no traía `tiendas.direccion`; el mensaje al repartidor solo tenía la dirección de entrega, nunca la de recogida. Agregada.
5. **Notificaciones de estado al cliente** (recogido/en camino/entregado) — ya estaba bien (`handleRepartidorMessage`), solo verificado.
6. **Retención + reinicio de conversación** — `pedidoRepositoryV2.deletePedido`/`finalizePedidoRetention` (borra el pedido, cascada a `pedido_tiendas`/`pedido_items`/`pedido_eventos`, reinicia `clientes.metadata_json.chat_history`). Conectado en los tres puntos donde un pedido cierra: `cancelOpenPedido`, `#ENTREGADO`, `handleOrderTimeoutExpired` — siempre después de encolar cualquier mensaje final sobre ese pedido.
7. **Claim atómico de repartidor** — `handleCourierConfirm` ahora hace `UPDATE ... WHERE id = ? AND estado = 'dispatch_repartidor_pendiente'` condicional. Dos `#CONFIRMO` casi simultáneos: solo el primero gana, el segundo recibe "ya fue tomado".
8. **Validación de horario** — Mándalo (8am-8pm fijo, `businessHours.ts`) bloquea pedidos nuevos fuera de horario (no bloquea seguimiento de un pedido ya en curso). Tiendas (`hora_apertura`/`hora_cierre`) se filtran de la lista que ve la IA y de `resolveTiendaStrictByName` — si el cliente nombra una tienda cerrada, se le avisa explícito con el horario. Repartidores no tienen columna de horario en el esquema (ni la pedía CLAUDE.md); su disponibilidad ya se gobierna por `disponible`/`activo`.
9. **Bug de retención — `getOpenPedidoByCustomerPhone` no filtraba por estado** — ahora filtra explícitamente `estado not in (entregado, cancelado)`, además de que el punto 6 ya evita que existan esas filas.
10. **Folio corto visible por pedido** — `#<id>` agregado a todos los mensajes de seguimiento al cliente que no lo traían (antes solo aparecía en mensajes a tienda/repartidor).
11. **Admin en BD + escalamiento de quejas** — tabla `configuracion` (clave/valor) con fallback a `MANDALO_ADMIN_PHONE` si no está cargada (`configRepository.getAdminPhone`). Detector de queja (`isComplaintMessage`) con prioridad más alta que el hard-reset: escala directo al admin con el teléfono del cliente, sin tocar el flujo normal. **Migración `20260812_configuracion_admin_telefono.sql` es opcional** — el sistema sigue funcionando con la variable de entorno si Víctor no la corre.
12. **Worker de reporte semanal** — tabla `metricas_semanales` (contadores agregados, no guarda nada de un pedido individual) + RPCs `increment_metrica`/`read_and_reset_metricas`, incrementados en los mismos tres puntos de cierre del punto 6. `weeklyReportWorker.ts` vía pg_cron semanal (lunes 9am). **Cambio estructural nuevo (tabla nueva) — señalado explícitamente a Víctor, no asumido en silencio.** Necesita `supabase/migrations/20260812_metricas_semanales.sql`.
13. **Prompt reescrito con personalidad de sección 2** — `mandaloPrompt.ts`: framing de "encargado de confianza de tienda de pueblo", reglas de estilo (frases cortas, cero muletillas de IA, resúmenes como recibo), bloque nuevo de conocimiento de mercado mexicano (sinónimos regionales, marcas, unidades). El contrato JSON funcional (BLOQUE 3-7) no se tocó.
14. **Separación de pedidos de dos tiendas** — regla a nivel de prompt (no de backend): si el cliente pide de 2 tiendas en un mensaje, la IA arma `order_state` solo con la primera y le dice al cliente que serán dos pedidos consecutivos. No hay mecanismo de "pedido en cola" — el cliente vuelve a escribir para el segundo cuando el primero se entregue (ya funciona solo, por el reinicio de conversación del punto 6). Decisión de alcance: el esquema (`pedido_tiendas`) sigue soportando solo una tienda por pedido; no se construyó tracking real de multi-tienda porque el brief ya no lo pide.

**`CLAUDE.md` actualizado en este bloque** (confirmado con Víctor, 2026-08-12): Sección 8 ahora documenta los timeouts unificados de 10 min y la cancelación directa de repartidor (ya no reasignación en cadena); Sección 4 documenta `clientes.metadata_json`.

**Nota sobre `handleCourierReassignmentQueued`/`handleCourierReassignmentFailed`** (`stateTransitionService.ts`): quedaron sin llamador tras retirar el worker viejo. No se borraron — son la base ya construida para el futuro comando explícito de "cambio de repartidor" (CLAUDE.md Sección 14, nombre pendiente; caso real: repartidor que ya aceptó y no puede completar a medio pedido). Si ese comando nunca se construye, vale la pena revisar si siguen valiendo la pena o se retiran en una limpieza futura.

## 🔴 Pendiente antes de mergear/desplegar este bloque

- Correr `supabase/migrations/20260812_order_timeout_worker_cron.sql` (activa el reloj de timeouts — sin esto, los timeouts no se disparan).
- Correr `supabase/migrations/20260812_metricas_semanales.sql` (activa el reporte semanal).
- Opcional: correr `supabase/migrations/20260812_configuracion_admin_telefono.sql` (permite cambiar el número de admin sin redeploy).
- Probar el flujo completo en vivo contra WhatsApp real antes de mergear a `main`.

## ⚪ No construido todavía (fuera del punchlist del brief)

- **Timeout de `ajuste_producto`** (tienda reporta producto no disponible, cliente decide si continúa o cancela) — el estado existe en la máquina de estados pero no tiene lógica de manejo real; no estaba en el punchlist del brief sección 7.
- **Comando explícito de "cambio de repartidor"** (nombre exacto pendiente de definir, CLAUDE.md Sección 14) — infraestructura reservada (ver nota arriba), falta el comando en sí.
- **Multi-tienda real / recargo de `servicio_repartidor` por tienda adicional** — deliberadamente no construido, ver punto 14 arriba.
- **Radio de cobertura definitivo** — el valor de 1.5km sigue provisional.

## Cómo mantener esto al día

Cuando termines un ciclo de trabajo (una fase, un fix, una feature), actualiza este archivo antes de cerrar la sesión: mueve el ítem a "Completo" o bórralo de "No construido", y anota cualquier bug nuevo que hayas descubierto en el camino. Si el cambio es de arquitectura/reglas de negocio (no de estado operativo), va en `CLAUDE.md`, no aquí.
