# Mándalo (Next.js + Supabase + Waapi + OpenAI)

Este proyecto replica el flujo del Blueprint de Make:

1) Recibe un mensaje entrante por webhook (WhatsApp/Waapi)  
2) Consulta Supabase (negocios, repartidores activos, historial del cliente)  
3) Genera respuesta con OpenAI  
4) Responde al cliente por WhatsApp (Waapi)  
5) Si la respuesta contiene **COTIZAR**, crea una **ORDEN** (registro en `pedidos`) y le pide precio a la **Tienda**  
6) Cuando la **Tienda** responde con el precio, se suma **comisión + envío** y se pide confirmación al **Cliente**  
7) Cuando el **Cliente** confirma, se asigna un **Repartidor** y se notifican actualizaciones

## Requisitos

- Node.js 18+ (recomendado 20+)
- Un proyecto de Supabase
- Cuenta de Waapi / proveedor de WhatsApp
- API Key de OpenAI

## 1) Variables de entorno

1. Copia `.env.example` a `.env.local`
2. Rellena las claves:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (solo backend; no la uses en frontend)
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
- (Opcional) `MANDALO_COMISION_FIJA` y `MANDALO_ENVIO_FIJO`

## 2) Base de datos (Supabase)

En tu Supabase, ejecuta el SQL inicial:

- `supabase/migrations/20260514_init.sql`
- `supabase/migrations/20260514_roles_y_ordenes.sql` (solo agrega índices; NO crea tabla `ordenes`)

Puedes hacerlo en el **SQL Editor** de Supabase o con Supabase CLI si usas migraciones.

Para producción completa, asegúrate también de haber ejecutado:

- `supabase/migrations/20260609_bloque7_modelo_profesional.sql`
- `supabase/migrations/20260610_bloque8_admin_outbox_worker.sql`

## 3) Correr en local

```bash
npm install
npm run dev
```

El endpoint de webhook queda en:

- `POST http://localhost:3000/api/webhook`

## 4) Configurar el webhook desde Waapi

Configura Waapi para que mande los mensajes entrantes a tu URL pública:

- `https://TU-DOMINIO/api/webhook`

Si definiste `MANDALO_WEBHOOK_SECRET`, manda también el header:

- `x-mandalo-webhook-secret: <tu secreto>`

## 5) Deploy a Vercel

1. Sube el repositorio a Vercel.
2. Configura todas las variables de `.env.example` en el dashboard del proyecto.
3. Usa la misma cadena para:
   - `CRON_SECRET`
   - `MANDALO_INTERNAL_WORKER_SECRET`
4. Verifica que `vercel.json` mantenga este cron:
   - `/api/internal/admin-outbox`
   - `*/5 * * * *`

### URLs esperadas en producción

- Webhook público:
  - `https://TU-DOMINIO/api/webhook`
- Worker interno:
  - `https://TU-DOMINIO/api/internal/admin-outbox`

## 6) Probar con curl (simulación)

```bash
curl -X POST "http://localhost:3000/api/webhook" \
  -H "content-type: application/json" \
  -d '{"chatId":"521234567890@c.us","text":"Hola, ¿qué tiendas hay?"}'
```

### Simular mensaje de TIENDA (cotización)

> Nota: en el código, el rol se detecta por el número (`negocios.whatsapp` / `repartidores.whatsapp`).
> Para simular TIENDA, usa un `from` que exista en `negocios.whatsapp`.

```bash
curl -X POST "http://localhost:3000/api/webhook" \
  -H "content-type: application/json" \
  -d '{"chatId":"52TIENDAWHATSAPP@c.us","text":"ORDEN #1 PRECIO 150"}'
```

### Simular mensaje de REPARTIDOR (estatus)

```bash
curl -X POST "http://localhost:3000/api/webhook" \
  -H "content-type: application/json" \
  -d '{"chatId":"52REPARTIDORWHATSAPP@c.us","text":"EN CAMINO ORDEN #1"}'
```

## 7) Worker y outbox

- El webhook de ventas **no envía** notificaciones administrativas directamente.
- El flujo encola en `public.admin_notificaciones`.
- El worker interno vive en `src/lib/adminOutboxWorker.ts`.
- El endpoint interno protegido es:
  - `GET/POST /api/internal/admin-outbox`

### Prueba dummy del outbox

1. Pon `ADMIN_OUTBOX_DRY_RUN=true`.
2. Inserta una fila en `admin_notificaciones`.
3. Ejecuta:

```bash
curl -X GET "https://TU-DOMINIO/api/internal/admin-outbox" \
  -H "Authorization: Bearer TU_CRON_SECRET"
```

4. Verifica en SQL que la fila pase de `pendiente` a `enviada`.

## 8) Notas de implementación

- El flujo vive en `src/lib/mandaloFlow.ts`.
- La respuesta del bot usa el prompt en `src/lib/mandaloPrompt.ts`.
- El proveedor de WhatsApp se integra en `src/lib/waapi.ts`.
- Supabase (admin) en `src/lib/supabaseAdmin.ts`.
- Roles (cliente/tienda/repartidor): `src/lib/roles.ts`
- Órdenes/estado (usando tabla `pedidos`): `src/lib/ordenes.ts`
