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
--   3) La foto del menú no va en esta migración. El bot la toma de
--      public/menus/carniceria-la-central.png o de la variable
--      CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL. Sin foto, manda el menú en texto.
--
-- No hay pollo. El carbón es Firo (con R). Carnes: precio por kilo.
-- Carbón y salsas: precio por pieza.

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

insert into public.productos_tienda (tienda_id, nombre_producto, precio, disponible, categoria)
select t.id, v.nombre_producto, v.precio, true, v.categoria
from public.tiendas t
cross join (
  values
    ('Arrachera Marinada', 280, 'Carnes'),
    ('Bistec de res Marinada', 210, 'Carnes'),
    ('Chorizo', 115, 'Carnes'),
    ('Chorizo Argentino', 135, 'Carnes'),
    ('Costilla de puerco marinada', 120, 'Carnes'),
    ('Bistec de puerco marinado', 120, 'Carnes'),
    ('Carne al pastor', 120, 'Carnes'),
    ('Peinesillo', 215, 'Carnes'),
    ('Diezmillo', 215, 'Carnes'),
    ('Bistec de res', 210, 'Carnes'),
    ('Cocido de res', 155, 'Carnes'),
    ('Chamberete', 155, 'Carnes'),
    ('Bistec de puerco', 120, 'Carnes'),
    ('Costilla de puerco', 110, 'Carnes'),
    ('Ribeye de res con hueso', 210, 'Carnes'),
    ('Carbón Firo', 75, 'Extras'),
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

-- Verificación (no cambia datos): debe verse una tienda y 18 productos, sin pollo.
select t.id, t.nombre, t.categoria, t.telefono, t.usa_catalogo_fijo, t.hora_apertura, t.hora_cierre
from public.tiendas t
where t.nombre ilike 'carnicer_a la central';

select p.nombre_producto, p.precio, p.categoria, p.disponible
from public.productos_tienda p
join public.tiendas t on t.id = p.tienda_id
where t.nombre ilike 'carnicer_a la central'
order by p.nombre_producto;
