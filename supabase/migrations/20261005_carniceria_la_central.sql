-- Carnicería La Central: tercer filtro (Carnicerías) y menú de precios fijos.
-- Fecha: 2026-10-05. Horario y teléfono real: 2026-10-06.
--
-- Víctor corre este SQL en el SQL Editor. No borra tiendas ni pedidos.
-- Teléfono: 5213318527050.
-- Horario (America/Mexico_City): lunes a sábado 08:00–17:00, jueves cerrado
-- (dias_cerrado = {4}), domingo 08:00–15:00 en horario_por_dia.
-- La foto oficial ya está en public/menus/carniceria-la-central.png.
--
-- Menú impreso: 19 productos, sin pollo. Carnes, pastor y carbón por kilo.
-- Salsas por pieza. El carbón del menú se llama Carbón fino (el habla también
-- acepta firo y carbón). Si este SQL ya se corrió con los nombres viejos,
-- los UPDATE de abajo los alinean antes de insertar.

alter table public.tiendas
  add column if not exists horario_por_dia jsonb;

insert into public.tiendas (
  nombre, categoria, telefono, direccion, activa, usa_catalogo_fijo,
  hora_apertura, hora_cierre, dias_cerrado, horario_por_dia
)
select
  'Carnicería La Central',
  'Carnicerías',
  '5213318527050',
  'Ixtlahuacán del Río',
  true,
  true,
  '08:00',
  '17:00',
  '{4}',
  '{"0":{"abre":"08:00","cierra":"15:00"}}'::jsonb
where not exists (
  select 1 from public.tiendas where nombre ilike 'carnicer_a la central'
);

update public.tiendas
set
  categoria = 'Carnicerías',
  usa_catalogo_fijo = true,
  activa = true,
  telefono = '5213318527050',
  hora_apertura = '08:00',
  hora_cierre = '17:00',
  dias_cerrado = '{4}',
  horario_por_dia = coalesce(horario_por_dia, '{}'::jsonb) || '{"0":{"abre":"08:00","cierra":"15:00"}}'::jsonb
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
-- teléfono 5213318527050, lun–sáb 08:00–17:00, jueves cerrado, domingo 08:00–15:00.
select t.id, t.nombre, t.categoria, t.telefono, t.usa_catalogo_fijo, t.hora_apertura, t.hora_cierre, t.dias_cerrado, t.horario_por_dia
from public.tiendas t
where t.nombre ilike 'carnicer_a la central';

select p.nombre_producto, p.precio, p.categoria, p.disponible
from public.productos_tienda p
join public.tiendas t on t.id = p.tienda_id
where t.nombre ilike 'carnicer_a la central'
order by p.categoria, p.nombre_producto;
