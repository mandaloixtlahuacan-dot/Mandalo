# NO_COPIAR — piezas solo-Mandalo (no embarcar a clientes)

Lista explícita de lo que **no** debe ir a repos starter / bots de cliente Flujo Propio.

---

## 1. Marca e identidad

- Nombre comercial **Mándalo / Mandalo** en prompts, README, package name, logs de producto
- Narrativa “tienda de pueblo en **Ixtlahuacán del Río**”
- WhatsApp de producción documentado en `CLAUDE.md` (número del canal Mandalo)
- Teléfono admin de ejemplo en `.env.example` / checklists (`MANDALO_ADMIN_PHONE` con valor real o de operación)
- Favicon / copy UI que diga Mandalo Delivery

## 2. Documentación operativa con datos reales

- `CLAUDE.md` completo (reglas de negocio + contexto Víctor/Claude Code del proyecto Mandalo)
- `ROADMAP.md` (estado vivo, bugs, commits, prioridades Mandalo)
- `Mandalo_Brief_Final_ClaudeCode_2.md`
- Auditorías y diagnósticos: `auditoria_mandalo_*`, `diagnostico_mandalo_*`, `informe_fase1_*`, `contrato_fase2_*`, `plan_bloque7_*`, `bloque7_documento1_*`
- Checklists preproducción / predeploy con teléfonos o SQL dummy apuntando a números reales
- `README 2.md` u otros dumps internos

## 3. Prompt y flujo de delivery Mandalo

- `src/lib/mandaloPrompt.ts` (tono + reglas de precio + horario 3pm–9pm + multi-tienda Mandalo)
- Fórmulas de precio: servicio Mándalo fijo + repartidor `$25 + $15×(tiendas-1)` (u otras variantes históricas)
- Ventana de reparto Mandalo y copy “por ahora operamos…”
- Retención: borrar pedidos al `entregado`/`cancelado` + wipe de chat (regla de negocio Mandalo; otros clientes suelen querer historial)
- Dominio completo de estados de pedido Mandalo si el cliente solo necesita FAQ/CRM

## 4. Datos maestros y seeds

- Seeds `supabase/seed/*` con tiendas/repartidores reales o de prueba Mandalo
- Filas de `zonas_cobertura` del pueblo
- Catálogos fijos de tiendas Mandalo (`20260907_tiendas_catalogo_fijo.sql` contenido de negocio)
- Cualquier dump SQL con teléfonos, nombres de tiendas reales, pedidos

## 5. Credenciales y secretos

- Cualquier `.env`, token Whapi, OpenAI key, service role, `CRON_SECRET`
- Secrets embebidos en docs (ej. menciones históricas tipo Bearer de cron en texto de seguridad)
- No inventar ni reutilizar secretos entre clientes

## 6. Prefijos y naming acoplados

- Prefijo env `MANDALO_*` sin renombrar
- Logs/product strings `[mandalo]` como marca en software de terceros (usar `[bot]` / slug del cliente)
- Package `"name": "mandalo"` en `package.json` del starter

## 7. Workers / migraciones de dominio delivery (salvo que el cliente lo pida)

- Timeouts unificados 10 min + recordatorio 5 + cancelaciones en cadena Mandalo
- `scheduled-dispatch-worker` / `esperando_apertura_tienda` si no hay horarios de tienda
- `weekly-report-worker` y métricas semanales Mandalo
- Comandos courier `#RECOGI` / `#ENTREGADO` / protocolos de mensaje a tienda “COTIZAR.”

## 8. Proceso interno del equipo Mandalo

- Referencias a Trae AI / NotebookLM / “Arquitecto Jefe” / pactos personales
- Instrucciones “pedir API key a Víctor” en docs de cliente
- Historial de bugs de producción Mandalo (útil internamente; no en repo cliente)

---

## Qué SÍ se puede reutilizar (patrón, no copy-paste ciego)

- Forma del webhook Whapi + dedupe + GPS extract
- `openaiClient` + schema JSON + sanitize
- Outbox genérico + provider gateway
- Detección de rol por teléfono (como idea)
- Scaffold Next.js + Zod env lazy

Al dudar: si el archivo nombra el pueblo, un precio Mandalo, un teléfono real, o un bug de producción Mandalo → **fuera del starter**.
