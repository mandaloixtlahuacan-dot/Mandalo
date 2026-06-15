# Checklist preproducción Mándalo (Fase 3)

Este documento es el checklist final para salida a producción tras el blindaje del flujo y la migración de transiciones a `transitionOrderState()`.

## Checklist técnico

- `npm run build` pasa sin errores.
- `npm run lint`:
  - si falla por deuda histórica (p. ej. `no-explicit-any`), registrar y aceptar explícitamente el riesgo antes de desplegar.
  - no permitir fallas nuevas relacionadas con el Bloque 5/6 (transiciones, parseos, ruteo).
- Verificar variables de entorno:
  - `MANDALO_ENVIO_FIJO`
  - `MANDALO_COMISION_FIJA`
- `WAAPI_*` (token/base URL)
  - `OPENAI_API_KEY`
  - `SUPABASE_*` (service role / URL)
- Confirmar que el webhook (`/api/webhook`) responde `200` y nunca se cae por excepciones no atrapadas.

## Checklist funcional (flujo completo)

### Cliente
- Saludo: “hola” → responde sin romper flujo.
- Captura de pedido: texto libre con productos.
- Dirección:
  - Si llega ubicación automática: responde con bloqueo y pide dirección escrita.
  - Dirección escrita válida.
- Resumen:
  - Mensaje al cliente sin texto técnico (“ORDEN #…”, “COTIZAR.”, etc.).
  - Confirmación: “SÍ” inicia cotización.
- Cancelación:
  - “nuevo / reiniciar / empezar de cero” cancela órdenes activas con transición `cancelado` y crea pedido limpio.

### Tienda
- Cotización:
  - La tienda responde: `ORDEN #123 PRECIO 150`.
  - El sistema transiciona a `pendiente_aprobacion_total` (persistido como legacy `awaiting_confirm`) y notifica total al cliente.
- Seguridad:
  - Mensajes `ORDEN #... PRECIO ...` solo se aceptan como tienda si el remitente pertenece a un negocio registrado.

### Repartidor
- Aceptación:
  - Repartidor responde: `ORDEN #123 SÍ` → transición a `repartidor_confirmado` (legacy `repartidor_asignado`).
  - Si el repartidor no manda `ORDEN #id`, no se muta estado y se pide el formato correcto.
- Actualizaciones:
  - `ORDEN #123 YA RECOGÍ` → `pedido_recogido` (legacy `en_camino`).
  - `ORDEN #123 YA LLEGUÉ` → `repartidor_en_destino` (legacy `llegado`).
  - `ORDEN #123 ENTREGADO` → `entregado` (legacy `completado`).

## Checklist de datos/configuración (Supabase)

- Tabla `negocios`:
  - `nombre` consistente con lo que el cliente elige.
  - `whatsapp` en formato comparable (se compara por normalización/últimos 10 dígitos).
- Tabla `pedidos`:
  - `estado` contiene estados legacy esperados (`collecting`, `esperando_confirmacion`, `awaiting_quote`, `awaiting_confirm`, `en_proceso`, `repartidor_asignado`, `en_camino`, `llegado`, `completado`, `cancelado`, etc.).
  - `detalle_pedido` contiene JSON válido para órdenes (cuando aplique).
  - estados `cliente/bot/tienda/repartidor/sistema` se usan solo como bitácora.
- Tabla `repartidores`:
  - al menos un registro con `activo = true` en producción.
  - `whatsapp` correcto.

## Checklist operativo (alta demanda)

- Logs mínimos recomendados por transición fallida:
  - actor (`cliente/tienda/repartidor`)
  - `orderId`
  - transición `from -> to`
  - motivo (mensaje de error / precondición fallida)
- Cache:
  - `sessionFlags` y cache de teléfonos de negocio son best-effort; no depender de ellos para integridad (solo UX/seguridad).
- Reintentos:
  - Transiciones fallidas deben responder controladamente y no dejar el webhook en crash-loop.

## Riesgos conocidos (pendientes siguiente fase)

- Waapi/proveedor de WhatsApp: si el proveedor está caído o rechaza requests, el flujo funcional no puede completarse aunque el webhook y transiciones sean correctas.
- Lint: existe deuda histórica de `any`/reglas ESLint. No bloquea build, pero aumenta riesgo de regresiones.
- Validación territorial estricta (Ixtlahuacán del Río): la máquina de estados incluye utilidades, pero falta integrar un rechazo canónico sin cambiar el flujo actual.
- Bitácora en `pedidos`: mezclar chat y órdenes en la misma tabla funciona, pero incrementa riesgo de ambigüedad; siguiente fase debería separar o endurecer consultas por tipos.
