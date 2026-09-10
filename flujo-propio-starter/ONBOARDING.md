# Onboarding Flujo Propio — checklist (~1 hora)

Objetivo: levantar un bot WhatsApp nuevo con el patrón  
**Whapi → Vercel webhook → OpenAI → reply Whapi**.

> Genera llaves **nuevas** por cliente. No copies secretos de otros proyectos.

---

## 0. Antes de empezar (5 min)

- [ ] Nombre del cliente / slug del proyecto Vercel
- [ ] Admin WA: 10 dígitos MX (solo en env `BOT_ADMIN_PHONE`)
- [ ] Cuenta OpenAI con crédito
- [ ] Cuenta Whapi.cloud (canal del **cliente**)
- [ ] Repo GitHub con este starter + proyecto Vercel

---

## 1. OpenAI (5 min)

- [ ] Crear API key nueva → `OPENAI_API_KEY`
- [ ] Modelo: `gpt-4o-mini` (o el acordado) → `OPENAI_MODEL`
- [ ] Smoke: un `curl` mínimo a Chat Completions (opcional)

---

## 2. Whapi — canal (10 min) **sin webhook aún**

- [ ] Crear canal / escanear QR del WhatsApp del cliente
- [ ] Copiar token → `WHAPI_TOKEN`
- [ ] Base: `https://gate.whapi.cloud` → `WHAPI_BASE_URL`
- [ ] **No** configures la URL del webhook todavía (espera Vercel, paso 3)
- [ ] Anotar el número público del bot (docs internas del cliente; no en el starter genérico)

### Nits operativos Whapi (botwa)

| Tema | Qué hacer |
|------|-----------|
| Eventos | Habilita **`messages`** y **`messages.post`** |
| Persistencia | Activa **`callback_persist`** para reintentos |
| Sesión caída | **Re-escanea el QR** en Whapi; no hace falta redeploy |
| Túneles | **No uses cloudflared** en prod — solo URL Vercel HTTPS |
| JID MX | Móviles: `521` + 10 dígitos + `@s.whatsapp.net` |

---

## 3. Vercel **primero** (10–15 min)

Orden correcto: **deploy público → luego webhook Whapi**.

- [ ] Importar repo; framework Next.js
- [ ] Environment variables (Production):

```
WHAPI_TOKEN=
WHAPI_BASE_URL=https://gate.whapi.cloud
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
WEBHOOK_SECRET=          # largo, aleatorio
BOT_ADMIN_PHONE=XXXXXXXXXX
```

- [ ] Deploy; copiar `https://<proyecto>.vercel.app`
- [ ] Probar health: `GET /api/health` → `ok: true`
- [ ] Probar auth: `POST /api/webhook` **sin** secret → **401**
- [ ] Con header `x-bot-webhook-secret` + payload de prueba → **200**

---

## 4. Conectar webhook Whapi (5 min)

- [ ] URL: `https://<proyecto>.vercel.app/api/webhook`
- [ ] Método **POST**
- [ ] Eventos: `messages` / `messages.post`
- [ ] `callback_persist`: **on**
- [ ] Secret: header `x-bot-webhook-secret` **o** `?secret=` en la URL
- [ ] Enviar “Hola” desde un celular que **no** sea el del canal
- [ ] Logs Vercel: payload → dedupe → OpenAI → `sendText`
- [ ] Confirmar reply en WhatsApp

---

## 5. Brief del cliente (5–10 min)

- [ ] Editar `config/client-brief.json`: nombre, tono, FAQs, horario
- [ ] Sin teléfonos reales, sin precios de otros negocios
- [ ] Redeploy

---

## 6. Smoke tests

| Prueba | Esperado |
|--------|----------|
| `GET /api/health` | `ok: true`, tokens `set`/`missing` |
| `POST /api/webhook` sin secret | 401 |
| Header secret + “Hola” | Reply con saludo del brief |
| Pregunta de FAQ | Respuesta alineada al brief |
| Mismo `message.id` dos veces | Segundo = `DUPLICATE_MESSAGE`, un solo reply |
| Mensaje `from_me` / `fromMe` | Ignorado |
| Canal desvinculado | Re-escanear QR en Whapi |

---

## 7. Post go-live

- [ ] Rotar cualquier secret pegado en chat
- [ ] Documentar URL webhook + owner del canal Whapi
- [ ] Planear dedupe en DB si hay más de una instancia / cold starts frecuentes
- [ ] Si el bot deja de contestar: 1) QR Whapi 2) logs Vercel 3) token/secret 4) OpenAI crédito

---

## Tiempos orientativos

| Bloque | Min |
|--------|-----|
| OpenAI | 5 |
| Whapi canal (sin webhook) | 10 |
| Vercel + env + smoke auth | 15 |
| Webhook Whapi + mensaje real | 10 |
| Brief | 10 |
| **Total** | **~50** |

Fallo típico: webhook apuntado **antes** de que Vercel esté up → Whapi guarda errores. Solución: redeploy Vercel, verifica `/api/health`, luego guarda el webhook otra vez.
