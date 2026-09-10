# Flujo Propio — WhatsApp Bot Starter

Plantilla **mínima** (Next.js App Router + TypeScript) para bots de cliente:

**Whapi.cloud → `POST /api/webhook` (Vercel) → OpenAI → reply Whapi**

Sin marca ni datos de operación de terceros. Personaliza `config/client-brief.json`.

---

## Qué incluye

| Pieza | Rol |
|-------|-----|
| `app/api/webhook/route.ts` | Entrada Whapi: secret, `fromMe`, dedupe, LLM, reply |
| `lib/whapi.ts` | `sendText(toJid, body)` → `POST {WHAPI_BASE_URL}/messages/text` |
| `lib/mexicoJid.ts` | Normaliza MX a `521XXXXXXXXXX@s.whatsapp.net` |
| `lib/brief.ts` | System prompt desde `config/client-brief.json` |
| `lib/dedupe.ts` | Dedupe en memoria por `message.id` (usar DB en prod) |
| `.env.example` | Variables sin secretos reales |

---

## Auth del webhook (un solo método claro)

1. **Preferido:** header `x-bot-webhook-secret: <WEBHOOK_SECRET>`
2. **Fallback:** query `?secret=<WEBHOOK_SECRET>`

Si `WEBHOOK_SECRET` no está definido, el endpoint responde **401**.

Ejemplo curl:

```bash
curl -X POST "https://<proyecto>.vercel.app/api/webhook" \
  -H "Content-Type: application/json" \
  -H "x-bot-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"messages":[{"id":"test-1","from_me":false,"chat_id":"5215551234567@s.whatsapp.net","type":"text","text":{"body":"Hola"}}]}'
```

---

## Variables de entorno

```bash
WHAPI_TOKEN=
WHAPI_BASE_URL=https://gate.whapi.cloud
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
WEBHOOK_SECRET=
BOT_ADMIN_PHONE=XXXXXXXXXX
```

---

## Orden de deploy (importante)

1. **Primero Vercel** (importa el repo, pone env, deploy).
2. **Después Whapi**: apunta el webhook a la URL pública de Vercel.
3. **No uses cloudflared / túneles** para producción: Vercel ya es HTTPS público.

Detalle paso a paso: [`ONBOARDING.md`](./ONBOARDING.md).

---

## Whapi — eventos y persistencia

En el panel Whapi (Settings → Webhook):

- URL: `https://<proyecto>.vercel.app/api/webhook`
- Método: **POST**
- Eventos: **`messages`** y/o **`messages.post`**
- Activa **`callback_persist`** (reintentos si tu endpoint no responde 2xx)
- Envía el secret en header `x-bot-webhook-secret` (o `?secret=` en la URL)

Si el canal se desvincula: **vuelve a escanear el QR** en Whapi. No hace falta redeploy.

### Nota JID México

Números móviles MX en Whapi suelen ir como:

`521` + **10 dígitos** + `@s.whatsapp.net`

Ejemplo: `5215512345678@s.whatsapp.net`  
(no uses solo `52` + 10 dígitos para móviles). `lib/mexicoJid.ts` lo normaliza.

---

## Dedupe

El starter guarda `message.id` en un `Map` en memoria. Sirve para demos y Hobby.

**En producción** reemplaza `lib/dedupe.ts` por una tabla con PK `message_id` (Postgres/Supabase). Whapi reintenta webhooks; sin dedupe durable el bot contesta dos veces tras cold start / multi-instancia.

---

## Desarrollo local

```bash
cp .env.example .env.local
# llena WHAPI_TOKEN, OPENAI_API_KEY, WEBHOOK_SECRET
npm install
npm run dev
```

Para probar el webhook en local necesitas un túnel **temporal** (solo dev). En prod: solo Vercel.

---

## Smoke tests

Ver tabla en `ONBOARDING.md` § Smoke tests.

---

## Personalizar

1. Edita `config/client-brief.json` (nombre, tono, FAQs, horario).
2. Redeploy en Vercel.
3. No hardcodees teléfonos reales ni tokens en el repo.
