# Análisis arquitectónico — Mandalo → Flujo Propio

Fuente: repo `mandaloixtlahuacan-dot/Mandalo` (rama `main`, inspección vía GitHub MCP, sin clone).  
Fecha de análisis: 2026-09-09 (hora Ciudad de México).

---

## 1. Stack

| Capa | Tecnología |
|------|------------|
| App | **Next.js 16.2.6** (App Router), **React 19**, TypeScript |
| LLM | **OpenAI** SDK (`openai` ^6), modelo configurable (`OPENAI_MODEL`, default en código `gpt-4-turbo`; `.env.example` sugiere `gpt-4o-mini`), fallback `gpt-3.5-turbo` si 403 / model_not_found |
| Validación | **Zod** (^4) — env + respuesta del agente |
| DB | **Supabase** (`@supabase/supabase-js`) con **service role** (server-only) |
| WhatsApp | **Whapi.cloud** (`WAAPI_API_BASE=https://gate.whapi.cloud`, token Bearer) — código legado nombra “Waapi” |
| Hosting | **Vercel** (`vercel.json` hoy: `{ "crons": [] }`). Workers por tiempo usan **pg_cron + pg_net** en Supabase; outbox también por Database Webhook → `/api/internal/*` |
| Lint/build | ESLint 9 + `eslint-config-next`, scripts estándar `dev/build/start/lint` |

No hay UI de negocio relevante: `src/app/page.tsx` es landing mínima; el producto es el bot por webhook.

---

## 2. Árbol relevante (`src/`)

```
src/app/api/webhook/route.ts          ← entrada Whapi
src/app/api/internal/
  admin-outbox/route.ts               ← outbox → WhatsApp (webhook DB / cron)
  dispatch-worker/route.ts
  order-timeout-worker/route.ts       ← timeouts 10 min (pg_cron)
  scheduled-dispatch-worker/route.ts  ← esperando_apertura_tienda
  weekly-report-worker/route.ts
src/lib/
  env.ts, supabaseAdmin.ts, openaiClient.ts, waapi.ts
  roles.ts                            ← cliente | tienda | repartidor por teléfono
  messages.ts                         ← parse inbound, chat_history, intents
  mandaloFlow.ts                      ← orquestador principal (~1700 líneas)
  mandaloPrompt.ts                    ← system prompt de negocio Mándalo
  llmResponseSchema.ts                ← JSON { customer_reply, order_state, dispatch }
  orderStateMachine.ts                ← estados + guards puros
  adminOutboxWorker.ts, ordenes.ts
  repositories/   (pedidoRepositoryV2, outbox, config, metrics)
  services/       (captureEngine, validationEngine, stateTransitionService,
                   storeDispatch, dispatchWorker, orderTimeout*, geo,
                   businessHours, providerGateway, courierCommandParser,
                   scheduledDispatchWorker, weeklyReportWorker)
```

Migraciones: `supabase/migrations/` (20 SQL, 20260514 → 20260907). Seeds de prueba: `supabase/seed/001_tienda_prueba.sql`, `002_repartidor_prueba.sql`.

---

## 3. Flujo de mensaje (Whapi → app → OpenAI → reply)

```
WhatsApp usuario
    ↓
Whapi.cloud (webhook HTTP POST)
    ↓
POST /api/webhook  (maxDuration=60, runtime=nodejs)
    ├─ opcional: validar MANDALO_WEBHOOK_SECRET
    │     (header x-mandalo-webhook-secret o ?secret=)
    ├─ ignorar fromMe (eco del proveedor)
    ├─ extraer texto / ubicación GPS / message_id / chatId
    ├─ dedupe atómico: INSERT whatsapp_mensajes_procesados
    │     (unique → 23505 = reintento Whapi, skip)
    ├─ normalizar → { data: { from, body, latitude?, longitude? } }
    └─ processMandaloWebhook(incoming)
            │
            ├─ Admin (MANDALO_ADMIN_PHONE): comando RESET_BOT <tel>
            ├─ detectActorByPhone(from)
            │     tiendas / repartidores en cache 60s; else CLIENTE
            │
            ├─ TIENDA  → handleTiendaMessage  (comandos #PRECIO / ORDEN…PRECIO / #NO_DISPONIBLE…)
            ├─ REPARTIDOR → handleRepartidorMessage (#RECOGI, #ENTREGADO, SÍ asignación…)
            └─ CLIENTE → handleClienteMessage
                    ├─ intents deterministas (cancel, queja, sí/no, GPS, estados de pedido)
                    ├─ getLLMResponse()
                    │     · carga tiendas abiertas/cerradas, zonas, repartidores, historial
                    │     · buildMandaloSystemPrompt(...)
                    │     · OpenAI chat.completions → JSON
                    │     · Zod mandaloAgentResponseSchema
                    ├─ captureEngine / validationEngine / state machine
                    ├─ persistencia en Supabase (clientes, pedidos, items, outbox…)
                    └─ sendWhatsApp → waapiSendText → POST {base}/messages/text
```

**Respuesta saliente “fiable” (outbox):**  
Muchas notificaciones (admin, tienda, repartidor) se encolan en `admin_notificaciones` y se envían vía `providerGateway` + worker interno (claim atómico `FOR UPDATE SKIP LOCKED` / `claim_admin_notificacion_by_id`). El reply inmediato al cliente en el webhook suele ir directo con `waapiSendText`.

**Idempotencia inbound:** crítica — sin ella Whapi reintenta y el bot reprocesa el mismo mensaje (documentado en producción ago 2026).

---

## 4. Variables de entorno (solo nombres; sin secretos)

Obligatorias en runtime (validadas en `src/lib/env.ts`):

| Variable | Rol |
|----------|-----|
| `SUPABASE_URL` | Proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Cliente admin (bypass RLS) |
| `OPENAI_API_KEY` | LLM |
| `OPENAI_MODEL` | Modelo (default código: gpt-4-turbo) |
| `WAAPI_TOKEN` | Bearer Whapi |
| `WAAPI_API_BASE` | Default `https://gate.whapi.cloud` |

Recomendadas / operativas:

| Variable | Rol |
|----------|-----|
| `MANDALO_WEBHOOK_SECRET` | Auth webhook inbound |
| `MANDALO_ADMIN_PHONE` | Admin WA + RESET_BOT / escalamientos |
| `CRON_SECRET` | Bearer workers internos |
| `MANDALO_INTERNAL_WORKER_SECRET` | Header legacy `x-mandalo-worker-secret` |
| `ADMIN_OUTBOX_*` | Batch, reintentos, backoff, dry-run |
| `MANDALO_COMISION_FIJA` / `MANDALO_ENVIO_FIJO` | Cargos opcionales |

`.env.example` incluye un teléfono admin de ejemplo de Mándalo — **no reutilizar en clientes**.

---

## 5. Rol de Supabase

Única fuente de verdad operativa:

- **Identidad por rol:** `tiendas.telefono`, `repartidores.telefono`; clientes en `clientes` (PK teléfono). Sin tabla “users” genérica.
- **Pedidos:** `pedidos` + `pedido_tiendas` + `pedido_items` + eventos; máquina de estados en `pedidos.estado`.
- **Chat:** `clientes.metadata_json.chat_history` (~30 msgs); se limpia al cerrar pedido (retención: no historial entre pedidos).
- **Outbox:** `admin_notificaciones` (generalizada a cualquier destinatario).
- **Dedupe WA:** `whatsapp_mensajes_procesados`.
- **Cobertura:** zonas / geo (migración `20260823_zonas_cobertura.sql`).
- **Config:** teléfono admin en BD (`20260812_configuracion_admin_telefono.sql`), métricas semanales.
- **Workers por tiempo:** `pg_cron` → HTTP a `/api/internal/order-timeout-worker` y `scheduled-dispatch-worker` (Hobby de Vercel no permite cron frecuente).

Cliente: siempre **service role** server-side (`supabaseAdmin.ts`). No hay anon key en el flujo del bot.

---

## 6. Mandalo-específico vs reutilizable (Flujo Propio)

### Reutilizable (núcleo de “client bots”)

- Webhook Whapi: parse multi-shape, `fromMe`, GPS, secret, dedupe por `message_id`
- Cliente Whapi send text + normalización MX (`ensureMxWhatsappIntl`, `@c.us`)
- OpenAI wrapper + JSON schema + sanitize de `customer_reply`
- `providerGateway` + outbox con claim/retry
- `roles` genérico (mapa teléfono → rol) si el cliente tiene multi-actor
- Patrón workers internos autenticados con Bearer
- Scaffold Next.js API routes en Vercel
- Lazy `getEnv()` con Zod

### Mandalo-only (no copiar tal cual a clientes)

- Marca, tono, pueblo **Ixtlahuacán del Río**, WhatsApp de producción documentado en CLAUDE.md
- Prompt `mandaloPrompt.ts` y brief `Mandalo_Brief_*`
- Precio: comisión Mándalo + fórmula repartidor multi-tienda; efectivo only
- Domino de delivery completo: tiendas + repartidores + timeouts 10′ + `#PRECIO`/`#RECOGI`/`#ENTREGADO`
- Geo radio Haversine + zonas del pueblo + ventana 3pm–9pm
- Retención agresiva (borrar pedidos al cerrar)
- Docs/auditorías/roadmap con datos y teléfonos reales de operación
- Seeds y admin phone de prueba de Mándalo
- Prefijos `MANDALO_*` en env (renombrar a `CLIENT_*` / `BOT_*` en el starter)

---

## 7. Notas para el starter Flujo Propio

1. Separar **config/brief** (JSON o MD del cliente) del **motor** webhook→LLM→Whapi.  
2. Empezar con **un solo rol (cliente)**; el módulo multi-rol (tienda/repartidor) es opcional.  
3. Mantener dedupe inbound y `maxDuration` alto desde el día 1.  
4. Outbox es opcional en v0; reply síncrono basta para demos.  
5. No empujar secretos ni teléfonos reales a repos de cliente.

Ver también: `ONBOARDING.md`, `STARTER_SPEC.md`, `NO_COPIAR.md`, `EXECUTIVE.txt`.
