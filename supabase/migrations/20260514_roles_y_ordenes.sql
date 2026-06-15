-- Mándalo - soporte de 3 roles (cliente / tienda / repartidor) usando SOLO la tabla public.pedidos
--
-- IMPORTANTE:
-- En tu proyecto, NO existe public.ordenes (y el backend ya fue ajustado para no usarla).
-- Este archivo queda como migración de apoyo para índices recomendados en public.pedidos.

create index if not exists pedidos_estado_idx on public.pedidos (estado);
