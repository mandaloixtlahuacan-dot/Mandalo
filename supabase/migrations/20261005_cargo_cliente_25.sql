-- Cargo al cliente: $25 de envío y servicio.
-- Fecha: 2026-10-05
--
-- Víctor corre este SQL en el SQL Editor. No borra pedidos ni cambia totales
-- ya guardados. Solo el default de filas nuevas que no manden el valor.
--
-- servicio_mandalo = 0 y servicio_repartidor = 25. Sumados son el mismo $25
-- que el cliente ve en WhatsApp ("Envío y servicio: $25"). El código escribe
-- esos dos números al crear el pedido y al cotizar. El default viejo de
-- servicio_mandalo era 20.

alter table public.pedidos
  alter column servicio_mandalo set default 0;

-- Verificación: el default debe ser 0.
select column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'pedidos'
  and column_name = 'servicio_mandalo';
