-- Tiendas con menú de precios fijos (ej. hot dogs/hamburguesas): el bot
-- calcula el subtotal directo contra productos_tienda y se salta la
-- cotización manual por WhatsApp que usan las demás tiendas.
-- Fecha: 2026-09-07
--
-- Flag explícito en vez de "detectar automático si tiene filas en
-- productos_tienda": una tienda podría tener productos cargados sin estar
-- lista para saltarse la revisión humana todavía (ej. mientras calibra
-- precios). Mismo patrón que la columna `activa`.

alter table public.tiendas
  add column if not exists usa_catalogo_fijo boolean not null default false;

comment on column public.tiendas.usa_catalogo_fijo is
  'true = el bot cotiza automático contra productos_tienda (sin esperar #PRECIO de la tienda).';
