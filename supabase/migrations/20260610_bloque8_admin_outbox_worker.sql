-- Bloque 8 - Worker de admin_notificaciones (outbox)
-- Aditivo y seguro. No toca el flujo legacy de ventas.

create index if not exists admin_notificaciones_worker_claim_idx
  on public.admin_notificaciones (estado_envio, next_attempt_at asc, created_at asc);

create or replace function public.claim_admin_notificaciones_batch(
  p_limit integer default 10,
  p_max_attempts integer default 5,
  p_reclaim_stale_after_seconds integer default 900
)
returns table (
  id bigint,
  pedido_id bigint,
  tipo public.admin_notificacion_tipo,
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
    r.destinatario_telefono,
    r.contenido,
    r.estado_envio,
    r.intentos,
    r.next_attempt_at,
    r.metadata_json
  from reclamadas r;
end;
$$;

comment on function public.claim_admin_notificaciones_batch(integer, integer, integer)
is 'Reclama atómicamente un lote del outbox admin_notificaciones usando FOR UPDATE SKIP LOCKED.';

