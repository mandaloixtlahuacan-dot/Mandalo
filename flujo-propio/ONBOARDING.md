# Onboarding Flujo Propio — checklist ~1 hora (español)

Objetivo: levantar un bot WhatsApp nuevo (cliente Flujo Propio) con el mismo patrón que Mandalo: **Whapi → Vercel webhook → OpenAI → reply Whapi**, más Supabase mínimo.

> No copies secretos de Mandalo. Genera llaves nuevas por cliente.

---

## 0. Antes de empezar (5 min)

- [ ] Nombre del cliente / slug del proyecto (ej. `bot-cliente-x`)
- [ ] Quién es el **admin WA** (número México 10 dígitos, sin inventar)
- [ ] Cuenta OpenAI con crédito
- [ ] Cuenta Whapi.cloud (canal WhatsApp del cliente)
- [ ] Proyecto Supabase nuevo (idealmente **uno por cliente**)
- [ ] Repo GitHub + proyecto Vercel vinculados
- [ ] Brief corto: tono, qué vende/atiende, horarios, si es solo FAQ o también pedidos

---

## 1. Supabase (10–15 min)

- [ ] Crear proyecto; anotar `SUPABASE_URL` y **service role** key (Settings → API)
- [ ] Aplicar migraciones **mínimas del starter** (no el pack completo Mandalo):
  - tabla de conversación / clientes (teléfono + `metadata_json`)
  - `whatsapp_mensajes_procesados(message_id PK, telefono, created_at)` — dedupe
  - (opcional v1) outbox `admin_notificaciones` + RPC claim
  - (opcional multi-rol) `tiendas`, `repartidores`, `pedidos…`
- [ ] Si hay multi-rol: insertar filas seed con teléfonos reales del cliente (tienda/repartidor)
- [ ] Confirmar que **no** quedó RLS bloqueando al service role (el bot usa service role)

---

## 2. OpenAI (5 min)

- [ ] Crear API key **nueva** para este cliente
- [ ] Elegir modelo (`gpt-4o-mini` para costo; o el que acuerden)
- [ ] Probar con `tools/openai_smoketest` del starter (o un curl mínimo)
- [ ] Guardar: `OPENAI_API_KEY`, `OPENAI_MODEL`

---

## 3. Whapi (10–15 min)

- [ ] Crear canal / escanear QR del WhatsApp del **cliente**
- [ ] Copiar token de API → `WAAPI_TOKEN`
- [ ] Base URL: `https://gate.whapi.cloud` → `WAAPI_API_BASE`
- [ ] **Aún no** apuntes el webhook hasta tener Vercel deployado (paso 5)
- [ ] Anotar el número público del bot (solo docs internas del cliente; no hardcodear en el starter genérico)

---

## 4. Código / brief (10 min)

- [ ] Fork o copia del **starter sanitizado** (ver `STARTER_SPEC.md`)
- [ ] Renombrar env `MANDALO_*` → `BOT_WEBHOOK_SECRET`, `BOT_ADMIN_PHONE`, etc.
- [ ] Llenar `config/client-brief.json` (o `.md`): nombre comercial, tono, FAQs, reglas; **sin** datos de Mandalo
- [ ] System prompt debe leer el brief, no el texto de Ixtlahuacán
- [ ] `npm i` && `npm run build` local (opcional pero recomendado)

---

## 5. Vercel (10 min)

- [ ] Importar repo; framework Next.js
- [ ] Variables de entorno (Production + Preview si aplica):

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
WAAPI_TOKEN=
WAAPI_API_BASE=https://gate.whapi.cloud
BOT_WEBHOOK_SECRET=          # genera uno largo aleatorio
BOT_ADMIN_PHONE=             # 10 dígitos MX del admin del cliente
CRON_SECRET=                 # mismo valor recomendado que worker secret
BOT_INTERNAL_WORKER_SECRET=
```

- [ ] Deploy; copiar URL: `https://<proyecto>.vercel.app`
- [ ] Probar: `POST /api/webhook` sin secret → rechazado / ignored unauthorized
- [ ] Con header `x-bot-webhook-secret: <secret>` y payload de prueba → 200

---

## 6. Conectar webhook Whapi (5 min)

- [ ] En Whapi: URL `https://<proyecto>.vercel.app/api/webhook`
- [ ] Método POST; enviar secret en header acordado (o query `?secret=`)
- [ ] Enviar mensaje de prueba desde un celular **no** admin
- [ ] Verificar logs Vercel: payload, dedupe, llamada OpenAI, `waapi -> sendText`
- [ ] Confirmar reply en WhatsApp

---

## 7. Admin WA (5 min)

- [ ] Registrar `BOT_ADMIN_PHONE` (y en BD si el starter lo guarda)
- [ ] Probar comando admin documentado (ej. reset de sesión si existe)
- [ ] Definir canal de escalamiento (quejas → mensaje al admin vía outbox o send directo)

---

## 8. Smoke test final (5–10 min)

| Prueba | Esperado |
|--------|----------|
| “Hola” | Saludo del brief, tono correcto |
| Pregunta de negocio | Respuesta según brief, sin inventar datos Mandalo |
| Ubicación GPS (si aplica) | Se parsea; no se trata el preview base64 como dirección |
| Reenvío / doble webhook | Segundo intento = `DUPLICATE_MESSAGE`, un solo reply |
| Mensaje fromMe | Ignorado |
| Admin phone | Comandos admin; no se trata como cliente genérico |

---

## 9. Post-go-live (fuera de la hora, pero obligatorio)

- [ ] Rotar cualquier secret que se haya pegado en chat
- [ ] Documentar URL webhook + owner del canal Whapi
- [ ] Decidir si se activa outbox + pg_cron (timeouts / reportes) o se deja v0 síncrono
- [ ] Checklist de `NO_COPIAR.md` — cero brand/phones/precios Mandalo en el repo del cliente

---

## Tiempos orientativos

| Bloque | Min |
|--------|-----|
| Supabase mínimo | 15 |
| OpenAI | 5 |
| Whapi canal | 15 |
| Código + brief | 10 |
| Vercel + env | 10 |
| Webhook + smoke | 10 |
| **Total** | **~65** |

Si algo falla primero: logs Vercel del webhook → secret → token Whapi → OpenAI → Supabase service role.
