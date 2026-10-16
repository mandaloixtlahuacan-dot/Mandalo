-- Archivo de la conversación antes de la retención del pedido.
-- Fecha: 2026-10-16
--
-- Víctor corre este SQL en el SQL Editor ANTES de desplegar el código que
-- escribe aquí. Si la tabla no existe, el cierre del pedido sigue: el
-- archivo es best-effort y no detiene el flujo.
--
-- Aditivo. No toca pedidos, pedido_eventos ni clientes.
-- No hay FK a pedidos: ese registro se elimina al cerrar, y el archivo
-- tiene que quedarse.

create table if not exists public.conversaciones_archivo (
  id bigint generated always as identity primary key,
  telefono text not null,
  pedido_id bigint,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.conversaciones_archivo is
  'Copia de los eventos agent_turn y de clientes.metadata_json.chat_history justo antes de borrar el pedido. payload: { agent_turns, chat_history }.';

comment on column public.conversaciones_archivo.payload is
  'agent_turns: filas de pedido_eventos con tipo_evento agent_turn. chat_history: arreglo del chat del cliente.';

create index if not exists conversaciones_archivo_telefono_idx
  on public.conversaciones_archivo (telefono, created_at desc);

create index if not exists conversaciones_archivo_pedido_idx
  on public.conversaciones_archivo (pedido_id);

alter table public.conversaciones_archivo enable row level security;

-- Verificación: la tabla existe y trae las columnas nuevas.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'conversaciones_archivo'
order by ordinal_position;
