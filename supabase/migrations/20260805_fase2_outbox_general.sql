-- Fase 2 (prep de esquema): amplía admin_notificaciones a outbox general
-- Fecha: 2026-08-05
--
-- Contexto: dispatchWorker.ts necesita mandar mensajes a tienda/repartidor/cliente,
-- no solo avisos al administrador. La tabla admin_notificaciones (Bloque 8) ya tiene
-- el mecanismo de claim atómico (FOR UPDATE SKIP LOCKED) probado y funcionando —
-- se decidió (con Víctor) ampliarla en vez de construir una tabla outbox aparte
-- desde cero. El nombre físico de la tabla se queda igual por ahora (evitar otra
-- ronda de renombrado); es un outbox general de mensajes, no solo "admin".
--
-- Esta migración es aditiva/segura: no borra columnas, no borra datos.
-- Repunta la FK pedido_id de pedidos_v2 a pedidos_new (la tabla definitiva de la
-- Fase 1, con nombre final pendiente hasta la Fase 3).

-- =========================
-- 1) tipo: de enum cerrado a texto libre
-- =========================
-- El catálogo de tipos de mensaje va a seguir creciendo (cotizacion_tienda,
-- dispatch_repartidor, cliente_actualizacion, venta_entregada, resumen_semanal,
-- alerta_operativa, ...). Un enum obliga a un ALTER TYPE por cada tipo nuevo;
-- se prefiere texto libre validado en la app, consistente con el resto del
-- esquema definitivo (que tampoco usa enums para catálogos abiertos).
alter table public.admin_notificaciones
  alter column tipo type text using tipo::text;

-- =========================
-- 2) Destinatario: a quién va dirigido el mensaje
-- =========================
-- destinatario_tipo: 'cliente' | 'tienda' | 'repartidor' | 'admin'
-- destinatario_id: id de tienda/repartidor cuando aplique (null para cliente/admin,
-- que se identifican por destinatario_telefono).
alter table public.admin_notificaciones
  add column if not exists destinatario_tipo text,
  add column if not exists destinatario_id bigint;

create index if not exists admin_notificaciones_destinatario_idx
  on public.admin_notificaciones (destinatario_tipo, destinatario_id);

-- =========================
-- 3) Repuntar pedido_id a la tabla de pedidos definitiva (Fase 1)
-- =========================
-- No hay notificaciones reales en cola que perder (confirmado: sin pedidos reales).
alter table public.admin_notificaciones
  drop constraint if exists admin_notificaciones_pedido_id_fkey;

alter table public.admin_notificaciones
  add constraint admin_notificaciones_pedido_id_fkey
  foreign key (pedido_id) references public.pedidos_new(id) on delete set null;

-- =========================
-- 4) Actualizar el RPC de claim atómico (Bloque 8) para exponer los campos nuevos
-- =========================
-- Firma sin cambios (compatibilidad con adminOutboxWorker.ts existente); solo
-- cambia el tipo de "tipo" (ahora text) y se agregan destinatario_tipo/destinatario_id
-- al resultado, para que dispatchWorker.ts sepa a quién y cómo enviar cada mensaje.
create or replace function public.claim_admin_notificaciones_batch(
  p_limit integer default 10,
  p_max_attempts integer default 5,
  p_reclaim_stale_after_seconds integer default 900,
  p_pedido_id bigint default null,
  p_tipo text default null
)
returns table (
  id bigint,
  pedido_id bigint,
  tipo text,
  destinatario_tipo text,
  destinatario_id bigint,
  destinatario_telefono text,
  contenido text,
  estado_envio public.admin_notificacion_estado,
  intentos integer,
  next_attempt_at timestamptz,
  metadata_json jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with elegibles as (
    select an.id
    from public.admin_notificaciones an
    where (
      an.estado_envio = 'pendiente'
      or (an.estado_envio = 'fallida' and an.next_attempt_at <= now() and an.intentos < p_max_attempts)
      or (
        an.estado_envio = 'enviando'
        and an.updated_at is not null
        and an.updated_at <= now() - make_interval(secs => p_reclaim_stale_after_seconds)
      )
    )
    and (p_pedido_id is null or an.pedido_id = p_pedido_id)
    and (p_tipo is null or an.tipo = p_tipo)
    order by an.created_at asc
    limit greatest(coalesce(p_limit, 10), 1)
    for update skip locked
  ),
  reclamadas as (
    update public.admin_notificaciones an
    set
      estado_envio = 'enviando',
      intentos = coalesce(an.intentos, 0) + 1,
      updated_at = now()
    from elegibles e
    where an.id = e.id
    returning
      an.id,
      an.pedido_id,
      an.tipo,
      an.destinatario_tipo,
      an.destinatario_id,
      an.destinatario_telefono,
      an.contenido,
      an.estado_envio,
      an.intentos,
      an.next_attempt_at,
      an.metadata_json
  )
  select
    r.id,
    r.pedido_id,
    r.tipo,
    r.destinatario_tipo,
    r.destinatario_id,
    r.destinatario_telefono,
    r.contenido,
    r.estado_envio,
    r.intentos,
    r.next_attempt_at,
    r.metadata_json
  from reclamadas r;
end;
$$;

comment on function public.claim_admin_notificaciones_batch(integer, integer, integer, bigint, text)
is 'Reclama atómicamente un lote del outbox general (admin_notificaciones) usando FOR UPDATE SKIP LOCKED. Cubre mensajes a cliente/tienda/repartidor/admin. p_pedido_id/p_tipo son filtros opcionales.';

-- =========================
-- 5) Claim de una notificación específica por id (para disparo por webhook,
--    no solo polling por lote) — mismo criterio atómico, reutilizable desde
--    adminOutboxWorker.ts y dispatchWorker.ts.
-- =========================
create or replace function public.claim_admin_notificacion_by_id(
  p_id bigint,
  p_max_attempts integer default 5
)
returns table (
  id bigint,
  pedido_id bigint,
  tipo text,
  destinatario_tipo text,
  destinatario_id bigint,
  destinatario_telefono text,
  contenido text,
  estado_envio public.admin_notificacion_estado,
  intentos integer,
  next_attempt_at timestamptz,
  metadata_json jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with elegible as (
    select an.id
    from public.admin_notificaciones an
    where an.id = p_id
      and (
        an.estado_envio = 'pendiente'
        or (an.estado_envio = 'fallida' and an.next_attempt_at <= now() and an.intentos < p_max_attempts)
      )
    for update skip locked
  ),
  reclamada as (
    update public.admin_notificaciones an
    set
      estado_envio = 'enviando',
      intentos = coalesce(an.intentos, 0) + 1,
      updated_at = now()
    from elegible e
    where an.id = e.id
    returning
      an.id,
      an.pedido_id,
      an.tipo,
      an.destinatario_tipo,
      an.destinatario_id,
      an.destinatario_telefono,
      an.contenido,
      an.estado_envio,
      an.intentos,
      an.next_attempt_at,
      an.metadata_json
  )
  select
    r.id,
    r.pedido_id,
    r.tipo,
    r.destinatario_tipo,
    r.destinatario_id,
    r.destinatario_telefono,
    r.contenido,
    r.estado_envio,
    r.intentos,
    r.next_attempt_at,
    r.metadata_json
  from reclamada r;
end;
$$;

comment on function public.claim_admin_notificacion_by_id(bigint, integer)
is 'Reclama atómicamente UNA fila del outbox general por id (disparo puntual vía webhook), con el mismo criterio de skip-locked que el claim por lote.';
