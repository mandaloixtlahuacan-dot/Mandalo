-- Plantilla para pegar una lista de abarrotes a mano.
-- No se corre sola. Primero aplica supabase/migrations/20261009_productos_lista_abarrotes.sql
-- Cambia el id de la tienda. precio va null: la tienda cotiza.

-- update public.tiendas set usa_lista_productos = true where id = 1;

-- insert into public.productos_tienda (tienda_id, nombre_producto, marca, presentacion, categoria, alias, precio, disponible)
-- values
--   (1, 'Leche', 'Lala', 'entera 1 L', 'lacteos', '{lala entera}', null, true),
--   (1, 'Leche', 'Lala', 'deslactosada 1 L', 'lacteos', '{lala deslactosada}', null, true);
--
-- El índice único es por expresión (lower/coalesce). Para no duplicar, usa
-- scripts/import-store-products.ts --apply, que actualiza la fila si ya existe.
