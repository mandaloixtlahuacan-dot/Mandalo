-- Arreglos de datos del 15 de octubre de 2026.
-- Se aplica a mano en el SQL Editor. No borra filas ni cambia el esquema.
-- El pedido #39 no entra en ningún UPDATE.
--
-- Qué hace:
--   1. Cancela en silencio los pedidos atorados #18, #48, #49, #113 y #122
--      (razón "inactivo"), solo si siguen armándose.
--   2. Marca como cancelados los mensajes viejos del outbox 20, 21, 71 y 113
--      para que el reintento no los mande.
--   3. Apaga ZAGU (columna activa = false) sin borrarla.
--      "Abarrotes Agua Santa (PRUEBA)" no se toca. Abarrotes Peques no se crea.

-- =========================
-- Verificación (no cambia nada)
-- =========================
select id, estado, updated_at, cliente_telefono, metadata_json ->> 'cancelled_reason' as cancelled_reason
from public.pedidos
where id in (18, 39, 48, 49, 113, 122)
order by id;

select id, estado_envio, intentos, created_at, left(last_error, 80) as last_error
from public.admin_notificaciones
where id in (20, 21, 71, 113)
order by id;

select id, nombre, activa
from public.tiendas
where nombre ilike '%zagu%'
   or nombre = 'Abarrotes Agua Santa (PRUEBA)'
order by id;

-- =========================
-- 1) Pedidos atorados: cancelar, no borrar
-- =========================
with targets as (
  select id, estado, cliente_telefono
  from public.pedidos
  where id in (18, 48, 49, 113, 122)
    and id <> 39
    and estado in ('seleccion_productos', 'confirmacion_cliente')
),
stuck as (
  update public.pedidos p
  set
    estado = 'cancelado',
    metadata_json = coalesce(p.metadata_json, '{}'::jsonb) || jsonb_build_object(
      'cancelled_reason', 'inactivo',
      'cancelled_at', to_jsonb(now())
    )
  from targets t
  where p.id = t.id
    and p.estado = t.estado
  returning p.id, t.estado as estado_origen, p.cliente_telefono
),
logged as (
  insert into public.pedido_eventos (
    pedido_id,
    tipo_evento,
    estado_origen,
    estado_destino,
    actor_tipo,
    payload_json
  )
  select
    s.id,
    'cancelado',
    s.estado_origen,
    'cancelado',
    'sistema',
    jsonb_build_object('reason', 'inactivo', 'source', 'data_fix_20261015')
  from stuck s
  returning pedido_id
)
update public.clientes c
set metadata_json = jsonb_set(
  coalesce(c.metadata_json, '{}'::jsonb),
  '{chat_history}',
  '[]'::jsonb,
  true
)
where c.telefono in (select cliente_telefono from stuck)
  and (select count(*) from logged) >= 0
  and not exists (
    select 1
    from public.pedidos open_pedido
    where open_pedido.cliente_telefono = c.telefono
      and open_pedido.estado not in ('cancelado', 'entregado')
  );

-- =========================
-- 2) Outbox viejo: no reenviar
-- =========================
update public.admin_notificaciones
set
  estado_envio = 'cancelada',
  intentos = greatest(coalesce(intentos, 0), 5),
  last_error = 'permanent: stale since august 2026, not sent'
where id in (20, 21, 71, 113)
  and estado_envio in ('pendiente', 'fallida', 'enviando');

-- =========================
-- 3) ZAGU: inactiva, no borrada
-- La columna de tiendas es activa. Solo corre si el nombre ZAGU es único.
-- =========================
update public.tiendas
set activa = false
where nombre ilike 'zagu'
  and (select count(*) from public.tiendas where nombre ilike 'zagu') = 1;

-- =========================
-- Resultado
-- =========================
select id, estado, metadata_json ->> 'cancelled_reason' as cancelled_reason
from public.pedidos
where id in (18, 39, 48, 49, 113, 122)
order by id;

select id, estado_envio, intentos, last_error
from public.admin_notificaciones
where id in (20, 21, 71, 113)
order by id;

select id, nombre, activa
from public.tiendas
where nombre ilike '%zagu%'
   or nombre = 'Abarrotes Agua Santa (PRUEBA)'
order by id;
