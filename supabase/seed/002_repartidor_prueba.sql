-- Seed: primer repartidor de prueba
-- Cambia el whatsapp por el número real del REPARTIDOR (formato internacional, sin espacios).

insert into public.repartidores (nombre, whatsapp, activo, vehiculo)
values
  ('Repartidor de Prueba', '521234567891', true, 'moto');

