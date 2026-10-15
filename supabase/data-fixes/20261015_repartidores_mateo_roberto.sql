-- Alta y horario de repartidores. Fecha: 2026-10-15
--
-- Víctor lo corre en el SQL Editor DESPUÉS de
-- supabase/migrations/20261015_repartidores_horario_json.sql
-- No borra filas ni tablas. No toca a Paul ni a ningún otro número.
--
-- Mateo  5213327898967  tardes 15:00–21:00 lun–dom, sábado 08:00–21:00
-- Roberto 5213314705434  08:00–21:00 lun–dom, sábado no trabaja
-- Día 0 = domingo … día 6 = sábado. America/Mexico_City.

-- =========================
-- Verificación (no cambia nada)
-- =========================
select id, nombre, telefono, activo, disponible, horario_json
from public.repartidores
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) in ('3327898967', '3314705434')
   or nombre ilike 'paul%'
order by id;

-- =========================
-- Mateo: ya existe. Se reactiva y se le pone el horario.
-- Si el número no estuviera, se inserta.
-- =========================
update public.repartidores
set
  activo = true,
  disponible = true,
  horario_json = '{
    "0": {"abre": "15:00", "cierra": "21:00"},
    "1": {"abre": "15:00", "cierra": "21:00"},
    "2": {"abre": "15:00", "cierra": "21:00"},
    "3": {"abre": "15:00", "cierra": "21:00"},
    "4": {"abre": "15:00", "cierra": "21:00"},
    "5": {"abre": "15:00", "cierra": "21:00"},
    "6": {"abre": "08:00", "cierra": "21:00"}
  }'::jsonb,
  updated_at = now()
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3327898967';

insert into public.repartidores (nombre, telefono, activo, disponible, horario_json)
select
  'Mateo',
  '5213327898967',
  true,
  true,
  '{
    "0": {"abre": "15:00", "cierra": "21:00"},
    "1": {"abre": "15:00", "cierra": "21:00"},
    "2": {"abre": "15:00", "cierra": "21:00"},
    "3": {"abre": "15:00", "cierra": "21:00"},
    "4": {"abre": "15:00", "cierra": "21:00"},
    "5": {"abre": "15:00", "cierra": "21:00"},
    "6": {"abre": "08:00", "cierra": "21:00"}
  }'::jsonb
where not exists (
  select 1
  from public.repartidores
  where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3327898967'
);

-- =========================
-- Roberto: se inserta, o se reactiva si el número ya existe.
-- =========================
update public.repartidores
set
  nombre = 'Roberto',
  activo = true,
  disponible = true,
  horario_json = '{
    "0": {"abre": "08:00", "cierra": "21:00"},
    "1": {"abre": "08:00", "cierra": "21:00"},
    "2": {"abre": "08:00", "cierra": "21:00"},
    "3": {"abre": "08:00", "cierra": "21:00"},
    "4": {"abre": "08:00", "cierra": "21:00"},
    "5": {"abre": "08:00", "cierra": "21:00"}
  }'::jsonb,
  updated_at = now()
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3314705434';

insert into public.repartidores (nombre, telefono, activo, disponible, horario_json)
select
  'Roberto',
  '5213314705434',
  true,
  true,
  '{
    "0": {"abre": "08:00", "cierra": "21:00"},
    "1": {"abre": "08:00", "cierra": "21:00"},
    "2": {"abre": "08:00", "cierra": "21:00"},
    "3": {"abre": "08:00", "cierra": "21:00"},
    "4": {"abre": "08:00", "cierra": "21:00"},
    "5": {"abre": "08:00", "cierra": "21:00"}
  }'::jsonb
where not exists (
  select 1
  from public.repartidores
  where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3314705434'
);

-- =========================
-- Verificación
-- =========================
select id, nombre, telefono, activo, disponible, horario_json
from public.repartidores
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) in ('3327898967', '3314705434')
   or nombre ilike 'paul%'
order by id;
