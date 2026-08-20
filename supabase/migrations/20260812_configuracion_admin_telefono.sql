-- Tabla mínima de configuración operativa + número de admin
-- Fecha: 2026-08-12
--
-- Contexto: brief sección 4 paso 9 pide que el número de admin (para
-- escalamiento de quejas) se pueda "configurar en base de datos si no está".
-- Hoy vive solo en la variable de entorno MANDALO_ADMIN_PHONE — cambiarla
-- requiere tocar Vercel y volver a desplegar (ver .claude/skills/mandalo-ops-safety).
-- Una tabla de config permite que Víctor cambie el número directo en Supabase
-- sin depender de un deploy. El código (configRepository.ts) cae de vuelta a
-- la variable de entorno si esta tabla no tiene el valor cargado, así que
-- correr esta migración es opcional para que el sistema siga funcionando,
-- pero recomendado para poder cambiar el número sin redeploy.
--
-- Clave-valor genérico (no una columna por dato) a propósito: incidental,
-- operativo, mismo criterio que metadata_json en el resto del esquema — no
-- es una tabla de negocio nueva, es config.
--
-- ============================================================
-- ACCIÓN REQUERIDA ANTES DE CORRER ESTO — reemplaza el placeholder:
--   <TELEFONO_ADMIN>  -> número de WhatsApp del admin, en el mismo formato
--                        que usa el resto del proyecto (ej. 5213311692798)
-- ============================================================

create table if not exists public.configuracion (
  clave text primary key,
  valor text,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_configuracion_updated_at on public.configuracion;
create trigger trg_configuracion_updated_at
before update on public.configuracion
for each row execute function public.set_updated_at();

insert into public.configuracion (clave, valor)
values ('admin_telefono', '<TELEFONO_ADMIN>')
on conflict (clave) do update set valor = excluded.valor;
