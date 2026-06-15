-- Documento 2 / Bloque 7 - Verificación de escritura dual (Legacy -> v2)
-- Uso: reemplaza los placeholders <> y ejecuta en Supabase SQL Editor.

-- 1) Localiza el pedido v2 por legacy_pedido_id
-- Reemplaza <LEGACY_ID>
select *
from public.pedidos_v2
where legacy_pedido_id = <LEGACY_ID>;

-- 2) Con el id v2 (reemplaza <PEDIDO_V2_ID>), revisa eventos
select *
from public.pedido_eventos
where pedido_id = <PEDIDO_V2_ID>
order by created_at desc;

-- 3) Mensajes asociados (por pedido_id o por cliente_id si lo tienes)
select *
from public.pedido_mensajes
where pedido_id = <PEDIDO_V2_ID>
order by created_at desc;

-- 4) Notificaciones admin pendientes (outbox)
select *
from public.admin_notificaciones
where pedido_id = <PEDIDO_V2_ID>
order by created_at desc;

