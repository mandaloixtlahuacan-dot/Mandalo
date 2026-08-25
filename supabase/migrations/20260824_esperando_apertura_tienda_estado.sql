-- Nuevo estado de la máquina de estados: esperando_apertura_tienda
-- Fecha: 2026-08-24
--
-- Contexto: Mándalo pasa a operar 24/7 (CLAUDE.md Sección 5, regla 6). Si el
-- cliente pide de una tienda que está cerrada en ese momento (por su propio
-- hora_apertura/hora_cierre), el pedido ya no se rechaza — se programa para
-- dispararse solo en cuanto la tienda abra. Ese "esperando" necesita su
-- propio estado en la máquina de estados (CLAUDE.md Sección 7), entre
-- confirmacion_cliente y pendiente_tiendas.
--
-- ============================================================
-- IMPORTANTE: correr este archivo SOLO — Postgres no permite usar un valor
-- de enum recién agregado (ALTER TYPE ... ADD VALUE) dentro de la misma
-- transacción en que se agrega. Debe quedar confirmado en su propia
-- sentencia antes de desplegar cualquier código que lo use, y antes de
-- correr la migración del worker (20260824_scheduled_dispatch_worker_cron.sql).
-- ============================================================
--
-- Idempotente: revisa pg_enum antes de intentar agregar el valor, seguro de
-- volver a correr si por algo se ejecuta dos veces.

do $$
begin
  if not exists (
    select 1 from pg_enum
    where enumlabel = 'esperando_apertura_tienda'
      and enumtypid = 'public.pedido_estado'::regtype
  ) then
    alter type public.pedido_estado add value 'esperando_apertura_tienda' after 'confirmacion_cliente';
  end if;
end $$;
