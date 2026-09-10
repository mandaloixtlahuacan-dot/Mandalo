# STARTER_SPEC — árbol exacto del starter Flujo Propio (sanitizado)

Plantilla **config-driven**: un brief por cliente, **sin** marca Mandalo, sin teléfonos reales, sin precios/pueblo de Ixtlahuacán.

Objetivo del v0: **loop mínimo** `webhook → LLM → Whapi`.  
Multi-rol (tienda/repartidor) queda como **módulo opcional** documentado, no como default.

---

## Árbol de archivos propuesto

```
flujo-propio-starter/
├── README.md
├── AGENTS.md                          # reglas cortas para agentes de código
├── package.json                       # next + openai + @supabase/supabase-js + zod
├── package-lock.json
├── tsconfig.json
├── next.config.ts
├── next-env.d.ts
├── eslint.config.mjs
├── vercel.json                        # { "crons": [] } en v0
├── .env.example                       # SOLO placeholders vacíos / defaults seguros
├── .gitignore
│
├── config/
│   ├── client-brief.example.json      # plantilla
│   └── client-brief.json              # gitignored o por env CLIENT_BRIEF_PATH
│
├── docs/
│   ├── ONBOARDING.md                  # copia adaptada del checklist
│   └── ARCHITECTURE.md                # diagrama del loop mínimo
│
├── tools/
│   └── openai_smoketest.mjs
│
├── supabase/
│   ├── migrations/
│   │   ├── 0001_clientes_chat.sql
│   │   ├── 0002_whatsapp_mensajes_procesados.sql
│   │   └── 0003_admin_outbox_optional.sql   # opcional
│   └── seed/
│       └── 001_ejemplo_sin_datos_reales.sql # comentarios only / falsos 555…
│
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx                   # “Bot OK” / health tip
    │   ├── globals.css
    │   └── api/
    │       ├── webhook/
    │       │   └── route.ts           # entrada Whapi (secret, fromMe, GPS, dedupe)
    │       ├── health/
    │       │   └── route.ts           # GET ok
    │       └── internal/              # opcional v1
    │           └── admin-outbox/
    │               └── route.ts
    │
    └── lib/
        ├── env.ts                     # Zod; prefijos BOT_* / CLIENT_*
        ├── supabaseAdmin.ts
        ├── openaiClient.ts
        ├── whapi.ts                   # rename limpio de waapi.ts
        ├── messages.ts                # parse inbound + chat_history helpers
        ├── brief.ts                   # carga config/client-brief.json
        ├── prompt.ts                  # system prompt desde brief (NO mandaloPrompt)
        ├── llmSchema.ts               # { customer_reply, session_state? }
        ├── botFlow.ts                 # orquestador mínimo (1 rol: cliente)
        └── optional/                  # módulo multi-rol (no importado en v0)
            ├── roles.ts
            ├── storeCommands.ts
            ├── courierCommands.ts
            └── README.md              # cómo activarlo
```

---

## `config/client-brief.example.json` (contrato)

```json
{
  "clientName": "Nombre Comercial",
  "botDisplayName": "Asistente",
  "locale": "es-MX",
  "timezone": "America/Mexico_City",
  "tone": {
    "style": "cálido, corto, sin jerga técnica",
    "maxEmojisPerMessage": 2,
    "greeting": "¡Hola! Soy el asistente de {{clientName}}. ¿En qué te ayudo?"
  },
  "business": {
    "summary": "Una frase de qué hace el negocio",
    "faqs": [{ "q": "…", "a": "…" }],
    "hoursText": "Lun–Vie 9:00–18:00",
    "outOfScope": ["temas médicos", "datos de otros clientes"]
  },
  "features": {
    "multiRole": false,
    "orders": false,
    "geoCoverage": false,
    "outbox": false
  }
}
```

Reglas: sin teléfonos, sin tokens, sin URLs privadas. El admin phone solo en env.

---

## Loop mínimo (comportamiento v0)

1. `POST /api/webhook` valida `BOT_WEBHOOK_SECRET`.
2. Ignora `fromMe`; dedupe por `message_id`.
3. Extrae texto (y opcionalmente GPS → placeholder en el mensaje).
4. Guarda turno en `clientes.metadata_json.chat_history`.
5. Arma prompt con `brief` + historial corto.
6. OpenAI → JSON `{ customer_reply }`.
7. Sanitiza reply (sin fences JSON).
8. `whapi.sendText(to, customer_reply)`.
9. Responde HTTP 200 siempre que sea posible (Whapi reintenta si no).

---

## `.env.example` (sanitizado)

```bash
SUPABASE_URL=""
SUPABASE_SERVICE_ROLE_KEY=""

OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4o-mini"

WAAPI_TOKEN=""
WAAPI_API_BASE="https://gate.whapi.cloud"

BOT_WEBHOOK_SECRET=""
BOT_ADMIN_PHONE=""
CRON_SECRET=""
BOT_INTERNAL_WORKER_SECRET=""

# Opcional v1
ADMIN_OUTBOX_BATCH_SIZE="10"
ADMIN_OUTBOX_MAX_ATTEMPTS="5"
ADMIN_OUTBOX_BASE_BACKOFF_SECONDS="60"
ADMIN_OUTBOX_DRY_RUN="false"
```

---

## Módulo opcional multi-rol

Activar solo si `features.multiRole=true` y existen tablas `tiendas` / `repartidores`:

- Reusar patrón `detectActorByPhone` (cache 60s, match últimos 10 dígitos).
- Comandos deterministas (no LLM) para tienda/repartidor.
- Máquina de estados de pedidos **propia del cliente**, no la de Mandalo.

No incluir en el default del starter: pricing Mandalo, timeouts de delivery, `#RECOGI`, zonas del pueblo, retención borrando pedidos.

---

## Qué NO debe existir en el starter

Ver `NO_COPIAR.md`. Checklist rápido: cero strings “Mándalo/Mandalo/Ixtlahuacán”, cero números `33…` de producción, cero `mandaloPrompt.ts` / `Mandalo_Brief_*` / ROADMAP operativo.

---

## Starter mínimo publicado

El árbol **mínimo** entregable (v0 sin Supabase) vive en `flujo-propio-starter/`
(rama `flujo-propio/starter-code`):

- `app/api/webhook/route.ts` — secret header `x-bot-webhook-secret` (+ `?secret=`)
- `lib/whapi.ts`, `lib/mexicoJid.ts`, `lib/brief.ts`, `lib/dedupe.ts` (Map in-memory)
- Env: `WHAPI_*`, `OPENAI_*`, `WEBHOOK_SECRET`, `BOT_ADMIN_PHONE`
- Docs: README + ONBOARDING (Vercel primero, eventos `messages`/`messages.post`, `callback_persist`, QR, sin cloudflared)

El árbol largo de este documento (Supabase, multi-rol, outbox) es la **visión v1+**.
