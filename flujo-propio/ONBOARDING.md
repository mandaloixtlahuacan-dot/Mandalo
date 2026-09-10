# Onboarding Flujo Propio — checklist ~1 hora (español)

Objetivo: levantar un bot WhatsApp nuevo (cliente Flujo Propio) con el patrón  
**Whapi → Vercel webhook → OpenAI → reply Whapi**.

> Código starter: carpeta `flujo-propio-starter/` (rama `flujo-propio/starter-code`).  
> No copies secretos de Mandalo. Genera llaves nuevas por cliente.

---

## 0. Antes de empezar (5 min)

- [ ] Nombre del cliente / slug del proyecto (ej. `bot-cliente-x`)
- [ ] Quién es el **admin WA** (número México 10 dígitos, sin inventar)
- [ ] Cuenta OpenAI con crédito
- [ ] Cuenta Whapi.cloud (canal WhatsApp del cliente)
- [ ] Repo GitHub + proyecto Vercel vinculados
- [ ] Brief corto: tono, qué vende/atiende, horarios

---

## 1. OpenAI (5 min)

- [ ] Crear API key **nueva** para este cliente
- [ ] Elegir modelo (`gpt-4o-mini` para costo)
- [ ] Guardar: `OPENAI_API_KEY`, `OPENAI_MODEL`

---

## 2. Whapi — canal (10–15 min) **sin webhook aún**

- [ ] Crear canal / escanear QR del WhatsApp del **cliente**
- [ ] Copiar token → `WHAPI_TOKEN` (o `WAAPI_TOKEN` en legado Mandalo)
- [ ] Base URL: `https://gate.whapi.cloud`
- [ ] **Aún no** apuntes el webhook hasta tener Vercel deployado

### Nits operativos (botwa)

| Tema | Qué hacer |
|------|-----------|
| Eventos | `messages` y/o `messages.post` |
| Persistencia | Activa **`callback_persist`** |
| Sesión caída | **Re-escanea el QR** (no redeploy) |
| Túneles | **No cloudflared** en prod — URL Vercel HTTPS |
| JID MX | `521` + 10 dígitos + `@s.whatsapp.net` |

---

## 3. Código / brief (10 min)

- [ ] Usar **flujo-propio-starter** (sanitizado; ver `STARTER_SPEC.md` / `NO_COPIAR.md`)
- [ ] Llenar `config/client-brief.json`
- [ ] `npm i` && `npm run build` (opcional)

---

## 4. Vercel **primero** (10 min)

Orden: **deploy público → luego webhook Whapi**.

Variables típicas del starter:

```
WHAPI_TOKEN=
WHAPI_BASE_URL=https://gate.whapi.cloud
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
WEBHOOK_SECRET=
BOT_ADMIN_PHONE=XXXXXXXXXX
```

- [ ] Deploy; URL `https://<proyecto>.vercel.app`
- [ ] `GET /api/health` → ok
- [ ] `POST /api/webhook` sin secret → 401
- [ ] Con header `x-bot-webhook-secret` → 200

---

## 5. Conectar webhook Whapi (5 min)

- [ ] URL `https://<proyecto>.vercel.app/api/webhook`
- [ ] POST; secret en `x-bot-webhook-secret` o `?secret=`
- [ ] Eventos `messages` / `messages.post` + `callback_persist`
- [ ] Mensaje de prueba → reply en WhatsApp

---

## 6. Smoke test final

| Prueba | Esperado |
|--------|----------|
| “Hola” | Saludo del brief |
| FAQ del brief | Respuesta alineada |
| Doble webhook mismo id | Un solo reply (`DUPLICATE_MESSAGE`) |
| `fromMe` | Ignorado |
| Canal desvinculado | Re-escanear QR |

---

## 7. Post-go-live

- [ ] Rotar secrets pegados en chat
- [ ] Documentar URL webhook + owner Whapi
- [ ] Dedupe durable (DB) si hay multi-instancia
- [ ] Checklist `NO_COPIAR.md`

Si algo falla primero: logs Vercel → secret → token Whapi → QR → OpenAI crédito.
