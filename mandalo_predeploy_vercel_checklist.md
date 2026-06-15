# Checklist predeploy Vercel - Mándalo

## Requisitos previos

- `npm run build` pasa localmente.
- `npm run lint` revisado; cualquier error residual está aceptado conscientemente.
- Supabase accesible con `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.
- Waapi configurado y apuntando al webhook público.

## Variables en Vercel

Cargar en el proyecto:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `WAAPI_TOKEN`
- `WAAPI_API_BASE`
- `MANDALO_WEBHOOK_SECRET`
- `MANDALO_ADMIN_PHONE`
- `CRON_SECRET`
- `MANDALO_INTERNAL_WORKER_SECRET`
- `ADMIN_OUTBOX_BATCH_SIZE`
- `ADMIN_OUTBOX_MAX_ATTEMPTS`
- `ADMIN_OUTBOX_BASE_BACKOFF_SECONDS`
- `ADMIN_OUTBOX_DRY_RUN`
- opcionales: `MANDALO_COMISION_FIJA`, `MANDALO_ENVIO_FIJO`

Recomendación:

- usar el mismo valor para `CRON_SECRET` y `MANDALO_INTERNAL_WORKER_SECRET`

## Migraciones Supabase necesarias

Debe estar ejecutado al menos:

- `20260514_init.sql`
- `20260514_roles_y_ordenes.sql`
- `20260609_bloque7_modelo_profesional.sql`
- `20260610_bloque8_admin_outbox_worker.sql`

## Verificaciones después del deploy

### Webhook

- URL esperada: `https://TU-DOMINIO/api/webhook`
- Waapi debe enviar `x-mandalo-webhook-secret` con el valor de `MANDALO_WEBHOOK_SECRET`
- prueba negativa sin header: debe rechazar con `UNAUTHORIZED`
- prueba positiva con header: debe procesar normalmente

### Worker / outbox

- endpoint interno: `https://TU-DOMINIO/api/internal/admin-outbox`
- probar manualmente:

```bash
curl -X GET "https://TU-DOMINIO/api/internal/admin-outbox" \
  -H "Authorization: Bearer TU_CRON_SECRET"
```

### Cron

- `vercel.json` debe conservar:
  - path: `/api/internal/admin-outbox`
  - schedule: `*/5 * * * *`
- validar en dashboard de Vercel que el cron aparece configurado
- revisar logs del endpoint interno para confirmar invocaciones periódicas

## SQL de validación

### Estado general del outbox

```sql
select estado_envio, count(*)
from public.admin_notificaciones
group by estado_envio
order by estado_envio;
```

### Últimos movimientos

```sql
select
  id,
  pedido_id,
  tipo,
  destinatario_telefono,
  estado_envio,
  intentos,
  next_attempt_at,
  sent_at,
  updated_at,
  last_error
from public.admin_notificaciones
order by updated_at desc nulls last, created_at desc
limit 20;
```

### Dummy del worker

```sql
insert into public.admin_notificaciones (
  tipo,
  destinatario_telefono,
  contenido,
  estado_envio,
  intentos,
  next_attempt_at,
  idempotency_key,
  metadata_json
) values (
  'alerta_operativa',
  '3310184790',
  'Prueba manual worker',
  'pendiente',
  0,
  now(),
  'dummy-worker-manual-1',
  '{}'::jsonb
);

select id, estado_envio, intentos, sent_at, last_error
from public.admin_notificaciones
where idempotency_key = 'dummy-worker-manual-1';
```

## Riesgos conocidos pendientes

- `lint` todavía puede mostrar deuda histórica residual fuera del flujo crítico.
- La ejecución autónoma del cron debe validarse en logs de Vercel; SQL solo confirma procesamiento cuando existe cola.
- Waapi es dependencia externa: si el proveedor falla, el webhook puede recibir pero no entregar mensajes salientes.
- `public.pedidos` legacy sigue coexistiendo con `pedidos_v2`; eso es intencional en esta fase.

