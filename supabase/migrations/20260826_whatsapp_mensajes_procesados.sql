-- Deduplicación de mensajes entrantes de WhatsApp (Whapi.cloud)
-- Fecha: 2026-08-26
--
-- Contexto: bug crítico confirmado en producción con logs reales — Whapi
-- reintenta la entrega del webhook cuando no le llega respuesta lo bastante
-- rápido, y el bot no tenía NINGUNA protección contra reprocesar el mismo
-- mensaje. Un pedido de prueba (Agua Ciel + Takis Fuego, Abarrotes Agua
-- Santa) mostró cada uno de sus 7 mensajes reales procesado exactamente 16
-- veces (112 llamadas totales a processMandaloWebhook para una conversación
-- de 7 turnos). Cada reprocesamiento volvía a leer el pedido, llamar a la
-- IA y escribir el snapshot — sin ningún bloqueo entre esas escrituras
-- concurrentes, la última en llegar ganaba, y los productos ya capturados
-- se perdían una y otra vez: el pedido nunca avanzó de seleccion_productos,
-- nunca se le asignó folio, y nunca se le mandó nada a la tienda.
--
-- Esta tabla es el lado de ENTRADA del mismo patrón que ya usa el lado de
-- SALIDA (outboxRepository.enqueueOutboundMessage con idempotencyKey desde
-- el día uno) — un claim atómico vía unique constraint: el webhook intenta
-- insertar el message_id antes de procesar; si choca (23505), ya se
-- procesó, se ignora sin tocar nada más. Ver src/app/api/webhook/route.ts,
-- claimInboundMessage.
--
-- Pendiente de considerar (no bloquea este fix): esta tabla crece con cada
-- mensaje entrante sin límite. Si el volumen lo justifica más adelante, se
-- puede agregar un cron de limpieza (ej. borrar filas de más de 7 días) —
-- por ahora cada fila es mínima (dos columnas de texto) y no es urgente.

create table if not exists public.whatsapp_mensajes_procesados (
  message_id text primary key,
  telefono text not null,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_mensajes_procesados_telefono_idx on public.whatsapp_mensajes_procesados (telefono);
