-- Fase 2 (prep de esquema): metadata_json operativo en pedidos_new
-- Fecha: 2026-08-05
--
-- Contexto: al consolidar stateTransitionService.ts (ciclo de vida del repartidor:
-- intentos, deadlines de confirmación, timestamps de recogida/entrega) para que
-- opere sobre pedidos_new en vez de pedidos_v2, se necesita un lugar para guardar
-- ese detalle operativo (ej. el arreglo de intentos de repartidor con su timestamp
-- y estado cada uno). No es información que el spec de la Sección 4 pida como
-- columna propia, y no tiene sentido "aplanarla" en columnas nuevas por cada
-- timestamp — es exactamente el tipo de dato que el resto del esquema (Bloque 7)
-- ya guarda en columnas metadata_json/snapshot_json. Aditivo, no rompe nada.
alter table public.pedidos_new
  add column if not exists metadata_json jsonb not null default '{}'::jsonb;

-- =========================
-- Repuntar pedido_eventos a pedidos_new
-- =========================
-- Se decidió (con Víctor) mantener viva la bitácora de auditoría pedido_eventos
-- durante la Fase 2, aunque es una tabla fuera de la Sección 4 del CLAUDE.md —
-- se retira hasta la limpieza final (Fase 6). Hoy apunta a pedidos_v2; la
-- repuntamos a la tabla de pedidos definitiva. Sin filas reales que perder.
alter table public.pedido_eventos
  drop constraint if exists pedido_eventos_pedido_id_fkey;

alter table public.pedido_eventos
  add constraint pedido_eventos_pedido_id_fkey
  foreign key (pedido_id) references public.pedidos_new(id) on delete cascade;

-- =========================
-- estado_origen/estado_destino: del enum viejo (pedido_estado_flujo, 12
-- valores de Bloque 7) al nuevo pedido_estado (11 valores canónicos, Fase 1).
-- Se vacía la bitácora antes del cambio de tipo: son solo eventos de pruebas
-- previas a esta migración, no hay nada real que preservar, y evita que el
-- cast falle si quedó algún valor del vocabulario viejo.
-- =========================
truncate table public.pedido_eventos;

alter table public.pedido_eventos
  alter column estado_origen type public.pedido_estado using estado_origen::text::public.pedido_estado,
  alter column estado_destino type public.pedido_estado using estado_destino::text::public.pedido_estado;

-- =========================
-- metadata_json en clientes_new (historial de chat reciente)
-- =========================
-- messages.ts guardaba el historial de conversación en la tabla legacy
-- `pedidos` (mezclado con órdenes). El reemplazo no puede vivir en pedidos_new
-- porque el cliente puede platicar (saludo, small talk) sin tener un pedido
-- activo — necesita un lugar atado al cliente, no a una orden. Mismo criterio
-- que las dos columnas anteriores: jsonb operativo, no columna por campo.
alter table public.clientes_new
  add column if not exists metadata_json jsonb not null default '{}'::jsonb;
