-- Lista de productos de abarrotes, sin precio.
-- La tienda sigue cotizando. usa_catalogo_fijo no se prende con esto.
-- NO APLICADA: Víctor la corre en el SQL Editor cuando la lista exista.
-- Fecha: 2026-10-09

alter table public.tiendas
  add column if not exists usa_lista_productos boolean not null default false;

comment on column public.tiendas.usa_lista_productos is
  'true = hay lista en productos_tienda para acotar preguntas. La tienda sigue cotizando; no es menú de precio fijo.';

alter table public.productos_tienda
  add column if not exists marca text,
  add column if not exists presentacion text,
  add column if not exists alias text[] not null default '{}';

create unique index if not exists productos_tienda_tienda_nombre_uq
  on public.productos_tienda (tienda_id, lower(nombre_producto), coalesce(lower(marca), ''), coalesce(lower(presentacion), ''));
