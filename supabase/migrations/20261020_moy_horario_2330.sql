-- Nombre y horario de repartidores. Fecha: 2026-10-20
--
-- Víctor lo corre en el SQL Editor. Este archivo NO se aplica solo.
-- No borra filas ni tablas. Solo UPDATE del nombre y del horario.
-- No toca a Paul ni a las tiendas: cada tienda conserva su horario.
--
-- Moy (antes Roberto) 5213314705434
--   08:00–23:30 domingo a viernes. El sábado no trabaja.
-- Mateo 5213327898967
--   15:00–23:30 domingo a viernes, y el sábado 08:00–23:30.
-- Día 0 = domingo … día 6 = sábado. America/Mexico_City.
-- El cierre de Mándalo (08:00–23:30) vive en el código, no en esta tabla.

-- =========================
-- Verificación (no cambia nada)
-- =========================
select id, nombre, telefono, activo, disponible, horario_json
from public.repartidores
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) in ('3327898967', '3314705434')
   or nombre ilike 'paul%'
order by id;

-- =========================
-- Moy: el número 3314705434 deja de llamarse Roberto.
-- =========================
update public.repartidores
set
  nombre = 'Moy',
  horario_json = '{
    "0": {"abre": "08:00", "cierra": "23:30"},
    "1": {"abre": "08:00", "cierra": "23:30"},
    "2": {"abre": "08:00", "cierra": "23:30"},
    "3": {"abre": "08:00", "cierra": "23:30"},
    "4": {"abre": "08:00", "cierra": "23:30"},
    "5": {"abre": "08:00", "cierra": "23:30"}
  }'::jsonb,
  updated_at = now()
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3314705434';

-- =========================
-- Mateo: mismo patrón, cierra a las 23:30.
-- =========================
update public.repartidores
set
  horario_json = '{
    "0": {"abre": "15:00", "cierra": "23:30"},
    "1": {"abre": "15:00", "cierra": "23:30"},
    "2": {"abre": "15:00", "cierra": "23:30"},
    "3": {"abre": "15:00", "cierra": "23:30"},
    "4": {"abre": "15:00", "cierra": "23:30"},
    "5": {"abre": "15:00", "cierra": "23:30"},
    "6": {"abre": "08:00", "cierra": "23:30"}
  }'::jsonb,
  updated_at = now()
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) = '3327898967';

-- =========================
-- Verificación
-- =========================
select id, nombre, telefono, activo, disponible, horario_json
from public.repartidores
where right(regexp_replace(coalesce(telefono, ''), '\D', '', 'g'), 10) in ('3327898967', '3314705434')
   or nombre ilike 'paul%'
order by id;
