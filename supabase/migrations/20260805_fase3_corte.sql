-- Fase 3: corte definitivo — renombra las tablas nuevas a su nombre final y
-- saca del camino a las legacy (sin borrarlas todavía).
-- Fecha: 2026-08-05
--
-- Precondición: confirmar que no hay pedidos activos en curso antes de correr
-- esto (Fase 0, ya acordado). Debe correr JUNTO con el despliegue del código
-- de la Fase 2 — el código nuevo espera estos nombres finales, así que si esto
-- se aplica sin desplegar el código al mismo tiempo, el bot deja de funcionar
-- hasta que el deploy alcance.
--
-- Reversible: las tablas legacy quedan renombradas, no borradas. Si algo sale
-- mal, se puede revertir el rename manualmente.

alter table public.pedidos rename to pedidos_legacy_20260805;
alter table public.pedido_items rename to pedido_items_legacy_20260805;
alter table public.clientes rename to clientes_legacy_20260805;
alter table public.negocios rename to negocios_legacy_20260805;
alter table public.repartidores rename to repartidores_legacy_20260805;

alter table public.pedidos_new rename to pedidos;
alter table public.pedido_items_new rename to pedido_items;
alter table public.clientes_new rename to clientes;
alter table public.repartidores_new rename to repartidores;
-- tiendas ya tiene su nombre final desde la Fase 1, no requiere rename.

-- pedidos_v2 queda huérfana (nada la usa desde la Fase 2). No se borra aquí
-- — se retira en la limpieza final (Fase 6), junto con las demás tablas
-- fuera de spec.
