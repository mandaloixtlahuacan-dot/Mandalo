-- Contadores acumulados para el reporte semanal al admin
-- Fecha: 2026-08-12
--
-- Contexto: brief sección 5 pide "notificación semanal al número de admin
-- con contexto del negocio (cantidad de pedidos, etc.)". La retención de
-- pedidos (CLAUDE.md Sección 4: "al llegar a entregado/cancelado el registro
-- se elimina, no se guarda historial") ya implementada en este ciclo de
-- trabajo hace que no quede ningún pedido cerrado del que contar nada. Esta
-- tabla es la excepción mínima: NO guarda datos de pedidos (nada de
-- cliente/tienda/dirección/productos), solo contadores numéricos agregados
-- que se incrementan en el momento exacto en que un pedido se cierra, justo
-- antes de borrarlo.
--
-- Nota para Víctor: esto es un cambio estructural nuevo (tabla nueva), lo
-- señalo explícitamente en vez de asumirlo — si prefieres una forma distinta
-- de resolver el reporte semanal (o directamente no quieres ningún dato
-- agregado persistente, ni siquiera contadores), dímelo y lo ajusto.

create table if not exists public.metricas_semanales (
  clave text primary key,
  valor numeric not null default 0,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_metricas_semanales_updated_at on public.metricas_semanales;
create trigger trg_metricas_semanales_updated_at
before update on public.metricas_semanales
for each row execute function public.set_updated_at();

-- Incremento atómico (INSERT ... ON CONFLICT DO UPDATE es una sola
-- sentencia — no hace falta FOR UPDATE SKIP LOCKED como en el outbox, aquí
-- no hay "reclamo" de fila, solo suma).
create or replace function public.increment_metrica(p_clave text, p_delta numeric default 1)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.metricas_semanales (clave, valor, updated_at)
  values (p_clave, p_delta, now())
  on conflict (clave) do update
    set valor = public.metricas_semanales.valor + excluded.valor,
        updated_at = now();
$$;

-- Lee todos los contadores y los reinicia a 0 en la misma función (evita la
-- ventana entre "leer" y "resetear" donde se perdería un incremento que
-- llegue justo en medio).
create or replace function public.read_and_reset_metricas()
returns table (clave text, valor numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query select m.clave, m.valor from public.metricas_semanales m;
  update public.metricas_semanales set valor = 0, updated_at = now();
end;
$$;

comment on function public.increment_metrica(text, numeric)
is 'Suma p_delta al contador p_clave en metricas_semanales, creándolo si no existe. Atómico (una sola sentencia).';
comment on function public.read_and_reset_metricas()
is 'Devuelve todos los contadores acumulados y los reinicia a 0 en la misma llamada. Usado por el worker de reporte semanal.';

-- ============================================================
-- ACCIÓN REQUERIDA ANTES DE CORRER ESTO — reemplaza los dos placeholders:
--   <TU_URL_DE_VERCEL>  -> URL pública de producción
--   <TU_CRON_SECRET>    -> el valor real de CRON_SECRET en Vercel
-- ============================================================
select cron.schedule(
  'mandalo_weekly_report_worker',
  -- 9:00am hora de Ixtlahuacán del Río (America/Mexico_City, UTC-6 fijo —
  -- México eliminó el horario de verano en la mayor parte del país desde
  -- 2022, así que no hay ajuste estacional que hacer) = 15:00 UTC, que es
  -- la zona horaria en la que corre pg_cron en Supabase.
  '0 15 * * 1', -- lunes 9:00am hora de Ixtlahuacán del Río
  $$
  select net.http_post(
    url := '<TU_URL_DE_VERCEL>/api/internal/weekly-report-worker',
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
--   select * from cron.job where jobname = 'mandalo_weekly_report_worker';
-- Para desactivarlo si hace falta:
--   select cron.unschedule('mandalo_weekly_report_worker');
