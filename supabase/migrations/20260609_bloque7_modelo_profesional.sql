-- Bloque 7 - Modelo de datos profesional (Aditivo + Coexistencia dual)
-- Fecha: 2026-06-09
--
-- Objetivo:
-- 1) Mantener intacta la tabla legacy `public.pedidos` (chat + órdenes híbridas).
-- 2) Evolucionar `public.negocios` para operación multinegocio (premium, liquidación, etc.).
-- 3) Introducir un modelo relacional nuevo para órdenes/pagos/mensajes/eventos/reportes,
--    sin romper el flujo actual ni `transitionOrderState()`.
--
-- Nota:
-- - Este SQL NO elimina tablas existentes.
-- - Las notificaciones al administrador deben ser asíncronas (outbox), y el teléfono
--   debe venir desde variables de entorno en la app (NO hardcode en DB).

-- ===============
-- Extensiones base
-- ===============
create extension if not exists pgcrypto;

-- =========================
-- Función genérica updated_at
-- =========================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================
-- Enums (catálogos controlados)
-- =========================

-- Modalidad de liquidación a negocios
do $$
begin
  if not exists (select 1 from pg_type where typname = 'negocio_modalidad_liquidacion') then
    create type public.negocio_modalidad_liquidacion as enum ('contra_entrega', 'semanal');
  end if;
end $$;

-- Estado de pago (separado del estado del flujo)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pedido_estado_pago') then
    create type public.pedido_estado_pago as enum ('pendiente', 'cobrado', 'liquidado', 'anulado');
  end if;
end $$;

-- Estado del flujo (catálogo canónico)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pedido_estado_flujo') then
    create type public.pedido_estado_flujo as enum (
      'capturando_pedido',
      'rechazado_fuera_de_zona',
      'pendiente_confirmacion_cliente',
      'pendiente_cotizacion_tienda',
      'pendiente_aprobacion_total',
      'pendiente_aceptacion_repartidor',
      'repartidor_confirmado',
      'pedido_recogido',
      'repartidor_en_destino',
      'entregado',
      'cancelado',
      'bloqueado_operativamente'
    );
  end if;
end $$;

-- Roles de mensajes (no confundir con estado del pedido)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'mensaje_rol') then
    create type public.mensaje_rol as enum ('cliente', 'bot', 'tienda', 'repartidor', 'sistema');
  end if;
end $$;

-- Notificaciones de administrador (outbox)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'admin_notificacion_tipo') then
    create type public.admin_notificacion_tipo as enum ('venta_entregada', 'resumen_semanal', 'alerta_operativa');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'admin_notificacion_estado') then
    create type public.admin_notificacion_estado as enum ('pendiente', 'enviando', 'enviada', 'fallida', 'cancelada');
  end if;
end $$;

-- =========================
-- Evolución de tablas existentes (Aditivo)
-- =========================

-- NEGOCIOS (tabla maestra)
alter table public.negocios
  add column if not exists updated_at timestamptz,
  add column if not exists activo boolean not null default true,
  add column if not exists slug text,
  add column if not exists descripcion text,
  add column if not exists direccion_texto text,
  -- Zona/sector de operación. Sin default para evitar hardcodes regionales.
  add column if not exists zona_servicio text,
  add column if not exists acepta_contra_entrega boolean not null default true,
  add column if not exists liquidacion_modalidad public.negocio_modalidad_liquidacion not null default 'contra_entrega',
  add column if not exists liquidacion_dia_corte smallint,
  add column if not exists liquidacion_dia_pago smallint,
  add column if not exists prioridad_posicionamiento integer not null default 0,
  add column if not exists premium_activo boolean not null default false,
  add column if not exists metadata_json jsonb not null default '{}'::jsonb;

-- Slug único (solo cuando exista)
create unique index if not exists negocios_slug_uk
  on public.negocios (slug)
  where slug is not null and slug <> '';

-- Constraints defensivos (día de semana 0-6, null permitido)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'negocios_liquidacion_dia_corte_chk'
  ) then
    alter table public.negocios
      add constraint negocios_liquidacion_dia_corte_chk
      check (liquidacion_dia_corte is null or (liquidacion_dia_corte between 0 and 6));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'negocios_liquidacion_dia_pago_chk'
  ) then
    alter table public.negocios
      add constraint negocios_liquidacion_dia_pago_chk
      check (liquidacion_dia_pago is null or (liquidacion_dia_pago between 0 and 6));
  end if;
end $$;

drop trigger if exists trg_negocios_updated_at on public.negocios;
create trigger trg_negocios_updated_at
before update on public.negocios
for each row execute function public.set_updated_at();

create index if not exists negocios_activo_idx on public.negocios (activo);
create index if not exists negocios_categoria_idx on public.negocios (categoria);
create index if not exists negocios_prioridad_idx on public.negocios (activo, premium_activo desc, prioridad_posicionamiento desc, created_at desc);

-- REPARTIDORES (tabla maestra)
alter table public.repartidores
  add column if not exists updated_at timestamptz,
  add column if not exists metadata_json jsonb not null default '{}'::jsonb;

drop trigger if exists trg_repartidores_updated_at on public.repartidores;
create trigger trg_repartidores_updated_at
before update on public.repartidores
for each row execute function public.set_updated_at();

-- =========================
-- Clientes y memoria
-- =========================

create table if not exists public.clientes (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  telefono text not null,
  nombre_preferido text,
  ultima_direccion_texto text,
  ultima_zona_validada boolean,
  ultimo_pedido_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  constraint clientes_telefono_uk unique (telefono)
);

drop trigger if exists trg_clientes_updated_at on public.clientes;
create trigger trg_clientes_updated_at
before update on public.clientes
for each row execute function public.set_updated_at();

create table if not exists public.cliente_direcciones (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  cliente_id bigint not null references public.clientes(id) on delete cascade,
  direccion_texto text not null,
  google_maps_link text,
  es_favorita boolean not null default false,
  esta_en_zona_servicio boolean,
  zona_detectada text,
  ultima_utilizada_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_cliente_direcciones_updated_at on public.cliente_direcciones;
create trigger trg_cliente_direcciones_updated_at
before update on public.cliente_direcciones
for each row execute function public.set_updated_at();

create index if not exists cliente_direcciones_cliente_idx on public.cliente_direcciones (cliente_id, ultima_utilizada_at desc);
create index if not exists cliente_direcciones_fav_idx on public.cliente_direcciones (cliente_id, es_favorita desc);

create table if not exists public.historial_clientes (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  cliente_id bigint not null references public.clientes(id) on delete cascade,
  tipo_evento text not null,
  resumen text,
  payload_json jsonb not null default '{}'::jsonb
);

create index if not exists historial_clientes_cliente_idx on public.historial_clientes (cliente_id, created_at desc);

-- =========================
-- Órdenes v2 (coexistencia con public.pedidos legacy)
-- =========================

-- Nota:
-- - Creamos `pedidos_v2` porque `public.pedidos` ya existe y es legacy.
-- - La app puede escribir dualmente durante la migración sin romper compatibilidad.
create table if not exists public.pedidos_v2 (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,

  -- Referencia opcional a la fila legacy (cuando aplique)
  legacy_pedido_id bigint,

  cliente_id bigint references public.clientes(id) on delete set null,
  negocio_id bigint references public.negocios(id) on delete set null,
  repartidor_id bigint references public.repartidores(id) on delete set null,

  estado_flujo public.pedido_estado_flujo not null default 'capturando_pedido',
  estado_pago public.pedido_estado_pago not null default 'pendiente',

  subtotal_tienda numeric,
  cargo_envio numeric not null default 0,
  cargo_servicio numeric not null default 0,
  total_cliente numeric,

  metodo_pago text,

  direccion_entrega_texto text,
  google_maps_link text,
  esta_en_zona_servicio boolean,
  zona_detectada text,

  snapshot_json jsonb not null default '{}'::jsonb,

  origen_canal text not null default 'whatsapp',
  observaciones_operativas text,
  metadata_json jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_pedidos_v2_updated_at on public.pedidos_v2;
create trigger trg_pedidos_v2_updated_at
before update on public.pedidos_v2
for each row execute function public.set_updated_at();

create index if not exists pedidos_v2_created_at_idx on public.pedidos_v2 (created_at desc);
create index if not exists pedidos_v2_estado_flujo_idx on public.pedidos_v2 (estado_flujo);
create index if not exists pedidos_v2_estado_pago_idx on public.pedidos_v2 (estado_pago);
create index if not exists pedidos_v2_cliente_idx on public.pedidos_v2 (cliente_id, created_at desc);
create index if not exists pedidos_v2_negocio_idx on public.pedidos_v2 (negocio_id, created_at desc);
create index if not exists pedidos_v2_repartidor_idx on public.pedidos_v2 (repartidor_id, created_at desc);
create index if not exists pedidos_v2_legacy_idx on public.pedidos_v2 (legacy_pedido_id);

-- =========================
-- Items (productos) por pedido
-- =========================
create table if not exists public.pedido_items (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  pedido_id bigint not null references public.pedidos_v2(id) on delete cascade,
  producto_nombre text not null,
  cantidad numeric,
  unidad text,
  detalle text,
  precio_unitario numeric,
  subtotal numeric,
  fue_sustituido boolean not null default false,
  producto_sustituto_nombre text,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists pedido_items_pedido_idx on public.pedido_items (pedido_id);

-- =========================
-- Auditoría: eventos de pedido
-- =========================
create table if not exists public.pedido_eventos (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  pedido_id bigint not null references public.pedidos_v2(id) on delete cascade,

  tipo_evento text not null,
  estado_origen public.pedido_estado_flujo,
  estado_destino public.pedido_estado_flujo,

  actor_tipo public.mensaje_rol, -- cliente/bot/tienda/repartidor/sistema
  actor_id bigint,
  actor_telefono text,

  descripcion text,
  payload_json jsonb not null default '{}'::jsonb
);

create index if not exists pedido_eventos_pedido_idx on public.pedido_eventos (pedido_id, created_at desc);
create index if not exists pedido_eventos_tipo_idx on public.pedido_eventos (tipo_evento, created_at desc);

-- =========================
-- Mensajes (chat) por pedido
-- =========================
create table if not exists public.pedido_mensajes (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),

  pedido_id bigint references public.pedidos_v2(id) on delete set null,
  cliente_id bigint references public.clientes(id) on delete set null,

  rol_mensaje public.mensaje_rol not null,
  telefono_origen text,
  telefono_destino text,
  contenido text not null,
  canal text not null default 'whatsapp',
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists pedido_mensajes_pedido_idx on public.pedido_mensajes (pedido_id, created_at desc);
create index if not exists pedido_mensajes_cliente_idx on public.pedido_mensajes (cliente_id, created_at desc);

-- =========================
-- Pagos y liquidaciones
-- =========================
create table if not exists public.pedido_pagos (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,

  pedido_id bigint not null references public.pedidos_v2(id) on delete cascade,
  negocio_id bigint references public.negocios(id) on delete set null,

  estado_pago public.pedido_estado_pago not null default 'pendiente',

  monto_cobrado_cliente numeric,
  monto_liquidable_negocio numeric,

  fecha_cobro timestamptz,
  fecha_liquidacion timestamptz,

  modalidad_liquidacion public.negocio_modalidad_liquidacion,

  cobrado_por_actor_tipo public.mensaje_rol, -- cliente/bot/tienda/repartidor/sistema
  cobrado_por_actor_id bigint,
  referencia_pago text,

  metadata_json jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_pedido_pagos_updated_at on public.pedido_pagos;
create trigger trg_pedido_pagos_updated_at
before update on public.pedido_pagos
for each row execute function public.set_updated_at();

create index if not exists pedido_pagos_pedido_idx on public.pedido_pagos (pedido_id);
create index if not exists pedido_pagos_negocio_idx on public.pedido_pagos (negocio_id, estado_pago, created_at desc);

-- =========================
-- Outbox de notificaciones a administrador (asíncrono)
-- =========================
create table if not exists public.admin_notificaciones (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,

  pedido_id bigint references public.pedidos_v2(id) on delete set null,
  tipo public.admin_notificacion_tipo not null,

  -- IMPORTANTE:
  -- Este valor debe venir desde la app (env var), nunca hardcodeado en SQL.
  destinatario_telefono text not null,

  contenido text not null,
  estado_envio public.admin_notificacion_estado not null default 'pendiente',
  intentos integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,

  -- Para idempotencia: p.ej. "venta_entregada:pedido:123"
  idempotency_key text,
  metadata_json jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_admin_notificaciones_updated_at on public.admin_notificaciones;
create trigger trg_admin_notificaciones_updated_at
before update on public.admin_notificaciones
for each row execute function public.set_updated_at();

create unique index if not exists admin_notificaciones_idempotency_uk
  on public.admin_notificaciones (idempotency_key)
  where idempotency_key is not null;

create index if not exists admin_notificaciones_estado_idx
  on public.admin_notificaciones (estado_envio, next_attempt_at asc, created_at asc);

-- =========================
-- Reportes semanales
-- =========================
create table if not exists public.reportes_semanales (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  fecha_inicio date not null,
  fecha_fin date not null,

  total_pedidos integer not null default 0,
  total_entregados integer not null default 0,
  total_cancelados integer not null default 0,

  monto_total_vendido numeric not null default 0,
  monto_total_cobrado numeric not null default 0,
  monto_total_liquidado numeric not null default 0,

  negocios_activos integer not null default 0,
  payload_json jsonb not null default '{}'::jsonb,

  constraint reportes_semanales_rango_uk unique (fecha_inicio, fecha_fin)
);

create table if not exists public.reporte_movimientos (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  reporte_semanal_id bigint not null references public.reportes_semanales(id) on delete cascade,
  pedido_id bigint references public.pedidos_v2(id) on delete set null,
  negocio_id bigint references public.negocios(id) on delete set null,
  tipo_movimiento text not null,
  monto numeric,
  descripcion text,
  payload_json jsonb not null default '{}'::jsonb
);

create index if not exists reporte_movimientos_reporte_idx on public.reporte_movimientos (reporte_semanal_id, created_at desc);
create index if not exists reporte_movimientos_negocio_idx on public.reporte_movimientos (negocio_id, created_at desc);

-- =========================
-- Catálogo y sustituciones (para IA + aprendizaje dinámico)
-- =========================
create table if not exists public.catalogo_productos (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  nombre_canonico text not null,
  categoria text,
  marca text,
  presentacion text,
  unidad text,
  activo boolean not null default true,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists catalogo_productos_nombre_idx on public.catalogo_productos (nombre_canonico);
create index if not exists catalogo_productos_categoria_idx on public.catalogo_productos (categoria);

create table if not exists public.negocio_productos (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  negocio_id bigint not null references public.negocios(id) on delete cascade,
  catalogo_producto_id bigint references public.catalogo_productos(id) on delete set null,
  nombre_visible text not null,
  precio_referencia numeric,
  disponible boolean,
  prioridad_catalogo integer not null default 0,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists negocio_productos_negocio_idx on public.negocio_productos (negocio_id, disponible desc, prioridad_catalogo desc);

create table if not exists public.sugerencias_sustitucion (
  id bigint generated by default as identity primary key,
  created_at timestamptz not null default now(),
  pedido_id bigint not null references public.pedidos_v2(id) on delete cascade,
  pedido_item_id bigint references public.pedido_items(id) on delete set null,
  negocio_id bigint references public.negocios(id) on delete set null,
  producto_solicitado text not null,
  producto_sugerido text not null,
  motivo text,
  aceptada boolean,
  metadata_json jsonb not null default '{}'::jsonb
);

create index if not exists sugerencias_sustitucion_pedido_idx on public.sugerencias_sustitucion (pedido_id, created_at desc);

-- =========================
-- Seguridad (RLS)
-- =========================
-- Regla:
-- - Habilitamos RLS para proteger tablas sensibles frente a tokens públicos.
-- - El backend con service_role puede operar sin fricción.
--
-- Nota:
-- - Si después crean un panel admin con "authenticated", se añadirán policies específicas.

alter table public.pedidos_v2 enable row level security;
alter table public.pedido_items enable row level security;
alter table public.pedido_eventos enable row level security;
alter table public.pedido_mensajes enable row level security;
alter table public.pedido_pagos enable row level security;
alter table public.admin_notificaciones enable row level security;
alter table public.reportes_semanales enable row level security;
alter table public.reporte_movimientos enable row level security;
alter table public.catalogo_productos enable row level security;
alter table public.negocio_productos enable row level security;
alter table public.sugerencias_sustitucion enable row level security;
alter table public.clientes enable row level security;
alter table public.cliente_direcciones enable row level security;
alter table public.historial_clientes enable row level security;

-- No se crean policies aquí para evitar exposición accidental.
-- (service_role bypass RLS; los demás quedan bloqueados por defecto).
