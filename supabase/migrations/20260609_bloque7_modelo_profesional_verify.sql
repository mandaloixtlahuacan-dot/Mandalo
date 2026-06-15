-- Bloque 7 - Script de verificación (ejecutar en Supabase SQL Editor)
-- Objetivo: validar que la migración creó enums/tablas, agregó columnas e habilitó RLS.

-- =========================
-- 1) Validación de enums
-- =========================
select t.typname as enum_name
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public'
  and t.typname in (
    'negocio_modalidad_liquidacion',
    'pedido_estado_pago',
    'pedido_estado_flujo',
    'mensaje_rol',
    'admin_notificacion_tipo',
    'admin_notificacion_estado'
  )
order by 1;

-- =========================
-- 2) Validación de tablas
-- =========================
select
  to_regclass('public.clientes') as clientes,
  to_regclass('public.cliente_direcciones') as cliente_direcciones,
  to_regclass('public.historial_clientes') as historial_clientes,
  to_regclass('public.pedidos_v2') as pedidos_v2,
  to_regclass('public.pedido_items') as pedido_items,
  to_regclass('public.pedido_eventos') as pedido_eventos,
  to_regclass('public.pedido_mensajes') as pedido_mensajes,
  to_regclass('public.pedido_pagos') as pedido_pagos,
  to_regclass('public.reportes_semanales') as reportes_semanales,
  to_regclass('public.reporte_movimientos') as reporte_movimientos,
  to_regclass('public.admin_notificaciones') as admin_notificaciones,
  to_regclass('public.catalogo_productos') as catalogo_productos,
  to_regclass('public.negocio_productos') as negocio_productos,
  to_regclass('public.sugerencias_sustitucion') as sugerencias_sustitucion;

-- =========================
-- 3) Columnas nuevas en negocios
-- =========================
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'negocios'
  and column_name in (
    'updated_at',
    'activo',
    'slug',
    'descripcion',
    'direccion_texto',
    'zona_servicio',
    'acepta_contra_entrega',
    'liquidacion_modalidad',
    'liquidacion_dia_corte',
    'liquidacion_dia_pago',
    'prioridad_posicionamiento',
    'premium_activo',
    'metadata_json'
  )
order by column_name;

-- =========================
-- 4) Columnas nuevas en repartidores
-- =========================
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'repartidores'
  and column_name in ('updated_at', 'metadata_json')
order by column_name;

-- =========================
-- 5) RLS habilitado
-- =========================
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'clientes',
    'cliente_direcciones',
    'historial_clientes',
    'pedidos_v2',
    'pedido_items',
    'pedido_eventos',
    'pedido_mensajes',
    'pedido_pagos',
    'admin_notificaciones',
    'reportes_semanales',
    'reporte_movimientos',
    'catalogo_productos',
    'negocio_productos',
    'sugerencias_sustitucion'
  )
order by c.relname;

-- =========================
-- 6) Índices (muestras)
-- =========================
select schemaname, tablename, indexname
from pg_indexes
where schemaname = 'public'
  and tablename in ('negocios', 'pedidos_v2', 'admin_notificaciones', 'pedido_eventos', 'pedido_mensajes')
order by tablename, indexname;

