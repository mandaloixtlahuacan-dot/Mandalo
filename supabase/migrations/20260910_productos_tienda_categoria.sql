-- Categoría real por producto (ej. "hamburguesas", "hotdogs", "papas") para
-- tiendas con catálogo de precios fijos (tiendas.usa_catalogo_fijo). Dato
-- cargado a mano al dar de alta cada producto — nunca se deriva por keyword
-- en el código: eso fue justo lo que causó que la IA "resumiera" el menú
-- real en categorías/precios inventados en vez de usar los datos reales.
-- Fecha: 2026-09-10
--
-- Nullable a propósito: un producto sin categoría cae en "otros" en el bot,
-- no rompe nada — se puede corregir después con un UPDATE puntual.

alter table public.productos_tienda
  add column if not exists categoria text;

comment on column public.productos_tienda.categoria is
  'Categoría real del producto (ej. "hamburguesas", "papas") — cargada a mano, nunca derivada por keyword.';
