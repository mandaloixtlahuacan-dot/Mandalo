-- PROPUESTA. No aplicada.
-- Fecha: 2026-10-24
-- Anaquel de la app para productos_tienda.
-- La app ya clasifica en código (src/lib/app/shelves.ts) y no lee esta columna.
-- Sirve si más adelante se quiere guardar el anaquel y dejar de calcularlo.
-- No borra filas. No tiene CHECK, para no rechazar productos del bot.

alter table public.productos_tienda
  add column if not exists categoria_app text;
