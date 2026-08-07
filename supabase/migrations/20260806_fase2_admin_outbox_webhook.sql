-- Fase 2 (prep de infraestructura): Database Webhook admin_notificaciones -> /api/internal/admin-outbox
-- Fecha: 2026-08-06
--
-- Contexto: la prueba de punta a punta del 2026-08-06 confirmó que ningún
-- mensaje del outbox se entrega solo hoy — nada dispara a los workers.
-- admin-outbox es genérico (no filtra por "tipo", solo manda lo que tenga
-- destinatario_telefono/contenido), así que conectar SU disparo cubre los
-- cuatro tipos de mensaje (cotizacion_tienda, dispatch_repartidor,
-- notificacion_cliente, alerta_operativa) con un solo webhook — no hace
-- falta tocar dispatch-worker para esto.
--
-- Nota (segundo intento): el primer intento usaba supabase_functions.http_request
-- (la función puente que arma el Dashboard) — falla en este proyecto con
-- "function supabase_functions.http_request() does not exist" (bug conocido:
-- a veces esa función puente no se instala aunque la extensión pg_net sí esté
-- activa). Esta versión llama a net.http_post() de pg_net directamente, sin
-- depender de esa función puente.
--
-- ============================================================
-- ACCIÓN REQUERIDA ANTES DE CORRER ESTO — reemplaza los dos placeholders:
--   <TU_URL_DE_VERCEL>  -> URL pública de producción, ej. https://mandalo.vercel.app
--   <TU_CRON_SECRET>    -> el valor real de CRON_SECRET en Vercel
-- Nunca me pegues el valor real de CRON_SECRET en el chat — reemplázalo aquí
-- directo en el SQL Editor, antes de correr.
-- ============================================================
--
-- Limitación conocida: esto dispara una sola vez por INSERT, de forma
-- asíncrona (pg_net encola la petición, no espera respuesta dentro de la
-- transacción). Si esa llamada HTTP fallara (no el envío en sí, sino que
-- nunca llegue a admin-outbox), el mensaje se queda "pendiente" sin
-- reintento automático — no hay cron de respaldo en el plan Hobby. Es el
-- mismo trade-off que ya existe en el resto de la arquitectura event-driven.

create or replace function public.trg_admin_notificaciones_dispatch_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := '<TU_URL_DE_VERCEL>/api/internal/admin-outbox',
    body := jsonb_build_object('record', to_jsonb(new)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <TU_CRON_SECRET>'
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

comment on function public.trg_admin_notificaciones_dispatch_fn()
is 'Dispara /api/internal/admin-outbox vía pg_net (net.http_post) en cada INSERT a admin_notificaciones. Reemplaza a supabase_functions.http_request, ausente en este proyecto.';

drop trigger if exists trg_admin_notificaciones_dispatch on public.admin_notificaciones;

create trigger trg_admin_notificaciones_dispatch
after insert on public.admin_notificaciones
for each row
execute function public.trg_admin_notificaciones_dispatch_fn();
