-- Cargo al cliente: $15 de envío (repartidor) + $10 de servicio (Mándalo) = $25.
-- Fecha: 2026-10-19
--
-- Víctor corre este SQL en el SQL Editor. No borra pedidos ni cambia totales
-- ya guardados. Solo el default de filas nuevas que no manden el valor.
-- El código escribe 10 y 15 al crear el pedido y al cotizar.

alter table public.pedidos
  alter column servicio_mandalo set default 10;

alter table public.pedidos
  alter column servicio_repartidor set default 15;

-- Verificación: los defaults deben ser 10 y 15.
select column_name, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'pedidos'
  and column_name in ('servicio_mandalo', 'servicio_repartidor')
order by column_name;
