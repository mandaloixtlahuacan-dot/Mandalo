-- Seed: primera tienda de prueba (Ixtlahuacán del Río)
-- 1) Cambia el whatsapp por el número real de la TIENDA (formato internacional, sin espacios).
-- 2) Ejecuta este SQL en Supabase (SQL Editor).

insert into public.negocios (nombre, whatsapp, categoria, horario_apertura, horario_cierre)
values
  ('Abarrotes de Prueba (Ixtlahuacán)', '521234567890', 'abarrotes', '09:00', '21:00');

