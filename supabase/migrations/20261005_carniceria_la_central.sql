-- Carnicería La Central: tercer filtro (Carnicerías) y menú de precios fijos.
-- Fecha: 2026-10-05
--
-- Víctor corre este SQL en el SQL Editor. No borra tiendas ni pedidos.
-- Antes de usarla en vivo:
--   1) Cambia el teléfono marcador 520000000000 por el WhatsApp real de la
--      carnicería (formato internacional, sin espacios). Este UPDATE no pisa
--      un teléfono que ya no sea el marcador.
--   2) Pon hora_apertura / hora_cierre reales. En NULL la tienda se trata
--      como siempre abierta.
--   3) La foto oficial ya está en public/menus/carniceria-la-central.png.
--      CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL solo hace falta si esa foto no
--      entra al despliegue.
--
-- Menú impreso: 19 productos, sin pollo. Carnes, pastor y carbón por kilo.
-- Salsas por pieza. El carbón del menú se llama Carbón fino (el habla también
-- acepta firo y carbón). Si este SQL ya se corrió con los nombres viejos,
-- los UPDATE de abajo los alinean antes de insertar.

insert into public.tiendas (nombre, categoria, telefono, direccion, activa, usa_catalogo_fijo)
select
  'Carnicería La Central',
  'Carnicerías',
  '520000000000',
  'Ixtlahuacán del Río',
  true,
  true
where not exists (
  select 1 from public.tiendas where nombre ilike 'carnicer_a la central'
);

update public.tiendas
set
  categoria = 'Carnicerías',
  usa_catalogo_fijo = true,
  activa = true
where nombre ilike 'carnicer_a la central';

update public.productos_tienda p
set nombre_producto = 'Carne de puerco al pastor',
    categoria = 'Carne de puerco al pastor',
    precio = 120
from public.tiendas t
where p.tienda_id = t.id
  and t.nombre ilike 'carnicer_a la central'
  and p.nombre_producto = 'Carne al pastor'
  and not exists (
    select 1
    from public.productos_tienda p2
    where p2.tienda_id = t.id
      and p2.nombre_producto = 'Carne de puerco al pastor'
  );

update public.productos_tienda p
set nombre_producto = 'Carbón fino',
    categoria = 'Extras',
    precio = 75
from public.tiendas t
where p.tienda_id = t.id
  and t.nombre ilike 'carnicer_a la central'
  and p.nombre_producto = 'Carbón Firo'
  and not exists (
    select 1
    from public.productos_tienda p2
    where p2.tienda_id = t.id
      and p2.nombre_producto = 'Carbón fino'
  );

insert into public.productos_tienda (tienda_id, nombre_producto, precio, disponible, categoria)
select t.id, v.nombre_producto, v.precio, true, v.categoria
from public.tiendas t
cross join (
  values
    ('Arrachera Marinada', 280, 'Res marinada'),
    ('Bistec de res Marinada', 210, 'Res marinada'),
    ('Peinesillo', 215, 'Res'),
    ('Diezmillo', 215, 'Res'),
    ('Bistec de res', 210, 'Res'),
    ('Cocido de res', 155, 'Res'),
    ('Chamberete', 155, 'Res'),
    ('Ribeye de res con hueso', 210, 'Res'),
    ('Pulpa de puerco', 115, 'Puerco'),
    ('Costilla de puerco marinada', 120, 'Puerco'),
    ('Bistec de puerco marinado', 120, 'Puerco'),
    ('Bistec de puerco', 120, 'Puerco'),
    ('Costilla de puerco', 110, 'Puerco'),
    ('Carne de puerco al pastor', 120, 'Carne de puerco al pastor'),
    ('Chorizo', 115, 'Embutidos'),
    ('Chorizo Argentino', 135, 'Embutidos'),
    ('Carbón fino', 75, 'Extras'),
    ('Salsa BBQ', 59, 'Extras'),
    ('Salsa Hot Wings', 55, 'Extras')
) as v(nombre_producto, precio, categoria)
where t.nombre ilike 'carnicer_a la central'
  and not exists (
    select 1
    from public.productos_tienda p
    where p.tienda_id = t.id
      and p.nombre_producto = v.nombre_producto
  );

-- Verificación (no cambia datos): una tienda, 19 productos, sin pollo,
-- con Pulpa de puerco y Carbón fino. El teléfono marcador y el horario
-- siguen pendientes de Víctor.
select t.id, t.nombre, t.categoria, t.telefono, t.usa_catalogo_fijo, t.hora_apertura, t.hora_cierre
from public.tiendas t
where t.nombre ilike 'carnicer_a la central';

select p.nombre_producto, p.precio, p.categoria, p.disponible
from public.productos_tienda p
join public.tiendas t on t.id = p.tienda_id
where t.nombre ilike 'carnicer_a la central'
order by p.categoria, p.nombre_producto;
