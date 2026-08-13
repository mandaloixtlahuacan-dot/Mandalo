-- Cron de Supabase (pg_cron) -> /api/internal/order-timeout-worker
-- Fecha: 2026-08-12
--
-- Contexto: los tres timeouts unificados de 10 min (tienda sin cotizar,
-- cliente sin confirmar precio final, repartidor sin aceptar — sección 3 del
-- Mandalo_Brief_Final_ClaudeCode_2.md) no pueden dispararse con un Database
-- Webhook porque no hay ningún INSERT/UPDATE en el momento exacto en que se
-- cumplen los 10 minutos: nada cambia en la base de datos cuando "pasa el
-- tiempo sin respuesta". Hace falta un reloj.
--
-- CLAUDE.md pide arquitectura event-driven "sin cron jobs frecuentes" — esa
-- regla es sobre los Cron Jobs de VERCEL (limitados a 1/día en el plan
-- Hobby). pg_cron es distinto: vive dentro de la base de datos de Supabase y
-- no tiene esa restricción, así que es la pieza correcta para un reloj de
-- 1 minuto sin salirse de las restricciones del plan Hobby de Vercel.
--
-- Mismo patrón que 20260806_fase2_admin_outbox_webhook.sql: pg_net.http_post
-- directo (sin la función puente supabase_functions.http_request, que no
-- está instalada en este proyecto).
--
-- ============================================================
-- ACCIÓN REQUERIDA ANTES DE CORRER ESTO — reemplaza los dos placeholders:
--   <TU_URL_DE_VERCEL>  -> URL pública de producción, ej. https://mandalo.vercel.app
--   <TU_CRON_SECRET>    -> el valor real de CRON_SECRET en Vercel
-- Nunca me pegues el valor real de CRON_SECRET en el chat — reemplázalo aquí
-- directo en el SQL Editor, antes de correr.
-- ============================================================
--
-- Limitación conocida: igual que el trigger de admin_notificaciones, pg_net
-- encola la petición de forma asíncrona (no espera respuesta). Si un tick se
-- pierde por lo que sea, el siguiente (60s después) recoge cualquier pedido
-- que haya quedado pendiente — no hace falta backfill manual.

create extension if not exists pg_cron;

select cron.schedule(
  'mandalo_order_timeout_worker',
  '* * * * *', -- cada minuto
  $$
  select net.http_post(
    url := '<TU_URL_DE_VERCEL>/api/internal/order-timeout-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <TU_CRON_SECRET>'
    ),
    timeout_milliseconds := 8000
  );
  $$
);

-- Para revisar el job después de crearlo:
--   select * from cron.job where jobname = 'mandalo_order_timeout_worker';
-- Para desactivarlo si hace falta:
--   select cron.unschedule('mandalo_order_timeout_worker');
