-- Cron de Supabase (pg_cron) -> /api/internal/scheduled-dispatch-worker
-- Fecha: 2026-08-24
--
-- Contexto: pedidos programados (estado esperando_apertura_tienda,
-- CLAUDE.md Sección 5 regla 6 / Sección 8 — la tienda elegida estaba cerrada
-- al confirmar) necesitan un reloj para detectar "¿ya abrió la tienda?" y
-- "¿ya pasaron 48h sin que abriera?" — nada cambia en la base de datos en el
-- instante exacto en que una tienda abre, así que un Database Webhook no
-- sirve aquí, igual que con los tres timeouts de 10 min de
-- 20260812_order_timeout_worker_cron.sql (mismo razonamiento, no se repite
-- aquí — ver ese archivo para el contexto completo de por qué pg_cron y no
-- un Cron Job de Vercel).
--
-- ============================================================
-- ACCIÓN REQUERIDA ANTES DE CORRER ESTO — reemplaza los dos placeholders:
--   <TU_URL_DE_VERCEL>  -> URL pública de producción, ej. https://mandalo.vercel.app
--   <TU_CRON_SECRET>    -> el valor real de CRON_SECRET en Vercel
-- Nunca me pegues el valor real de CRON_SECRET en el chat — reemplázalo aquí
-- directo en el SQL Editor, antes de correr.
--
-- IMPORTANTE: correr esto DESPUÉS de que
-- 20260824_esperando_apertura_tienda_estado.sql ya haya quedado confirmado
-- (el estado nuevo tiene que existir en la BD antes de que el código que lo
-- usa reciba tráfico real).
-- ============================================================

select cron.schedule(
  'mandalo_scheduled_dispatch_worker',
  '* * * * *', -- cada minuto
  $$
  select net.http_post(
    url := '<TU_URL_DE_VERCEL>/api/internal/scheduled-dispatch-worker',
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
--   select * from cron.job where jobname = 'mandalo_scheduled_dispatch_worker';
-- Para desactivarlo si hace falta:
--   select cron.unschedule('mandalo_scheduled_dispatch_worker');
