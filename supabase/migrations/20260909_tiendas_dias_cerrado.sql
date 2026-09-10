-- Tiendas que cierran uno o más días fijos de la semana (ej. cerrado los
-- lunes). Hasta ahora hora_apertura/hora_cierre eran un rango diario
-- idéntico todos los días, sin distinguir el día.
-- Fecha: 2026-09-09
--
-- dias_cerrado: números de día 0-6, domingo=0 … sábado=6 (misma convención
-- que JS Date.getDay() y Postgres EXTRACT(DOW)). Vacío = abierta todos los
-- días — comportamiento actual, sin cambios para las tiendas existentes.

alter table public.tiendas
  add column if not exists dias_cerrado smallint[] not null default '{}';

alter table public.tiendas
  drop constraint if exists tiendas_dias_cerrado_chk;
alter table public.tiendas
  add constraint tiendas_dias_cerrado_chk
  check (dias_cerrado <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]);

comment on column public.tiendas.dias_cerrado is
  'Días de la semana que la tienda NO abre (0=domingo..6=sábado). Vacío = abre todos los días.';
