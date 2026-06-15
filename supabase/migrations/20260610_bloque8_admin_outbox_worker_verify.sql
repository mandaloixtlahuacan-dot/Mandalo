-- Bloque 8 - Verificación del worker de admin_notificaciones

-- A) Conteo por estado
select estado_envio, count(*)
from public.admin_notificaciones
group by estado_envio
order by estado_envio;

-- B) Últimas filas del outbox
select
  id,
  pedido_id,
  tipo,
  destinatario_telefono,
  estado_envio,
  intentos,
  next_attempt_at,
  sent_at,
  last_error,
  idempotency_key,
  created_at
from public.admin_notificaciones
order by created_at desc
limit 20;

-- C) Pendientes que ya debieron ejecutarse
select
  id,
  pedido_id,
  tipo,
  estado_envio,
  intentos,
  next_attempt_at,
  created_at
from public.admin_notificaciones
where estado_envio in ('pendiente', 'fallida')
  and next_attempt_at <= now()
order by next_attempt_at asc
limit 20;

-- D) Enviadas recientemente
select
  id,
  pedido_id,
  tipo,
  sent_at,
  updated_at
from public.admin_notificaciones
where estado_envio = 'enviada'
order by sent_at desc nulls last
limit 20;

-- E) Validar función de claim atómico
select
  p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'claim_admin_notificaciones_batch';

-- F) Validar índice útil del worker
select schemaname, tablename, indexname
from pg_indexes
where schemaname = 'public'
  and tablename = 'admin_notificaciones'
order by indexname;

-- G) Buscar una notificación específica por id
-- Reemplaza <NOTIFICATION_ID>
select *
from public.admin_notificaciones
where id = <NOTIFICATION_ID>;

-- H) Buscar por pedido
-- Reemplaza <PEDIDO_V2_ID>
select *
from public.admin_notificaciones
where pedido_id = <PEDIDO_V2_ID>
order by created_at desc;

-- I) Buscar por idempotency key
-- Reemplaza <IDEMPOTENCY_KEY> por un string entre comillas
select *
from public.admin_notificaciones
where idempotency_key = <IDEMPOTENCY_KEY>;
