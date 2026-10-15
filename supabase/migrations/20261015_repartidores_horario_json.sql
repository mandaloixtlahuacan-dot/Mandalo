-- Horario semanal por repartidor. Fecha: 2026-10-15
--
-- Víctor corre este SQL en el SQL Editor ANTES de desplegar el código que
-- lee horario_json. Si la columna no existe, el despacho no encuentra
-- repartidores. No borra filas ni cambia otras columnas.
--
-- Clave: día 0–6 (domingo = 0 … sábado = 6), hora America/Mexico_City.
-- Sin la clave de ese día, ese repartidor no está disponible.
-- Los horarios de Mateo y Roberto van en
-- supabase/data-fixes/20261015_repartidores_mateo_roberto.sql
-- (correrlo después de este archivo).

alter table public.repartidores
  add column if not exists horario_json jsonb;

comment on column public.repartidores.horario_json is
  'Horario semanal (0=domingo..6=sábado). Ej: {"1":{"abre":"08:00","cierra":"21:00"}}. Sin la clave de ese día, no está disponible. Null = sin horario, no se le ofrece pedido.';

-- Verificación: la columna existe y nadie perdió filas.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'repartidores'
  and column_name = 'horario_json';
