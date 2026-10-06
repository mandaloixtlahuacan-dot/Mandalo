-- Horario distinto por día. Carnicería La Central cierra el domingo a las 15:00
-- y el resto de días abiertos a las 17:00. El jueves ya está en dias_cerrado.
-- Fecha: 2026-10-06
--
-- Víctor corre este SQL en el SQL Editor. No borra tiendas ni pedidos.
-- Idempotente: la columna nace null, así que las demás tiendas siguen con
-- hora_apertura / hora_cierre. Hay que correrlo ANTES de desplegar el código
-- que selecciona horario_por_dia; si la columna no existe, esas lecturas fallan.
--
-- Clave: día 0–6 (domingo = 0), igual que dias_cerrado. Valor: abre / cierra.
-- America/Mexico_City. La Central (id 6 en producción):
--   lun–sáb 08:00–17:00, jueves cerrado, domingo 08:00–15:00.
-- Teléfono: 5213318527050.

alter table public.tiendas
  add column if not exists horario_por_dia jsonb;

comment on column public.tiendas.horario_por_dia is
  'Excepción por día (0=domingo..6=sábado). Ej: {"0":{"abre":"08:00","cierra":"15:00"}}. Null o sin esa clave = hora_apertura/hora_cierre.';

update public.tiendas
set
  telefono = '5213318527050',
  hora_apertura = '08:00',
  hora_cierre = '17:00',
  dias_cerrado = '{4}',
  horario_por_dia = coalesce(horario_por_dia, '{}'::jsonb) || '{"0":{"abre":"08:00","cierra":"15:00"}}'::jsonb
where nombre ilike 'carnicer_a la central';

-- Verificación: debe verse La Central, teléfono real, jueves en dias_cerrado
-- y domingo 08:00–15:00. Ninguna otra tienda debe ganar horario_por_dia aquí.
select id, nombre, telefono, hora_apertura, hora_cierre, dias_cerrado, horario_por_dia
from public.tiendas
where nombre ilike 'carnicer_a la central'
   or horario_por_dia is not null
order by id;
