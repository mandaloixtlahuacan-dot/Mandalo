# Documento 1

## Diseño SQL de migraciones (Bloque 7)

Este documento acompaña a la migración aditiva: `mandalo/supabase/migrations/20260609_bloque7_modelo_profesional.sql`.

[Regla de oro] No se elimina `public.pedidos` (legacy). El modelo nuevo corre en paralelo y se habilita la convivencia dual para migración gradual.

## Qué crea / modifica el SQL

### Mantiene (sin cambios destructivos)

- `public.pedidos` (legacy: hoy mezcla chat/orden/estado)

### Evoluciona (aditivo)

- `public.negocios`: agrega columnas para:
  - modalidad de liquidación (`contra_entrega` / `semanal`)
  - prioridad premium (`premium_activo`, `prioridad_posicionamiento`)
  - configuración de zona (`zona_servicio`, `direccion_texto`)

- `public.repartidores`: agrega `metadata_json` y `updated_at`

### Crea (nuevo modelo relacional)

- Clientes y memoria:
  - `public.clientes`
  - `public.cliente_direcciones`
  - `public.historial_clientes`

- Órdenes nuevas (coexistencia dual):
  - `public.pedidos_v2` (tabla transaccional real; el estado del flujo es canónico)
  - `public.pedido_items`
  - `public.pedido_eventos` (auditoría y trazabilidad)
  - `public.pedido_mensajes` (separa chat de la orden)
  - `public.pedido_pagos` (trazabilidad financiera)

- Reportes:
  - `public.reportes_semanales`
  - `public.reporte_movimientos`

- Administrador (outbox asíncrono):
  - `public.admin_notificaciones`

- Catálogo y sustituciones:
  - `public.catalogo_productos`
  - `public.negocio_productos`
  - `public.sugerencias_sustitucion`

## Directrices críticas integradas

## Rol del administrador y notificaciones asíncronas

El diseño usa un patrón **outbox**:

- La app inserta un registro en `public.admin_notificaciones` al ocurrir un evento (por ejemplo, al entrar a `entregado`).
- Un worker **server-side** (cron / job interno / edge function programada) procesa `pendiente` -> `enviada` con reintentos.

Requisitos cumplidos:

- el número administrador se configura vía env var (ej. `MANDALO_ADMIN_PHONE`), nunca hardcodeado en SQL
- si falla WhatsApp/UltraMsg, **no se detiene la venta**: solo queda `pendiente` para reintentar

## Seguridad y auditoría

- Se habilita RLS en tablas sensibles y no se crean policies públicas.
- El flujo operativo backend puede seguir usando service role.
- La lógica de reportes y notificaciones debe vivir en **procesos server-side**, nunca expuestos por webhook público.
- `pedido_pagos` y `pedido_eventos` soportan trazabilidad: quién cobró, cuánto y cuándo.

## Visión multinegocio y premium

- `negocios` incorpora `premium_activo` y `prioridad_posicionamiento`
- la selección de negocio puede ponderar premium sin cambiar la lógica central del flujo
- el catálogo puede escalar por categoría (abarrotes, ferretería, etc.) sin cambios estructurales

## IA optimista y sustituciones

El modelo soporta un flujo “optimista”:

- si falta inventario, la conversación no se detiene
- el pedido puede seguir en `capturando_pedido`
- se registran sustituciones y decisiones en:
  - `sugerencias_sustitucion`
  - `pedido_items.fue_sustituido`
  - `historial_clientes`

## Ejecución de la migración (en Supabase SQL Editor)

1. Ejecutar la migración completa:
   - `mandalo/supabase/migrations/20260609_bloque7_modelo_profesional.sql`

2. Verificar que las tablas nuevas existan.

3. Verificar que `public.pedidos` siga intacta (no debe cambiar su estructura ni datos).

## Plan de convivencia dual (sin romper estabilidad)

Fase inmediata (sin cambios de app todavía):

- solo crear tablas y columnas nuevas
- mantener el runtime operando sobre legacy

Fase siguiente (cuando decidan avanzar):

- al ejecutar `transitionOrderState()`:
  - escribir/actualizar la orden también en `public.pedidos_v2`
  - registrar `pedido_eventos` por transición
  - escribir chat en `pedido_mensajes` además del legacy

Fase final:

- retirar dependencia del legacy para chat y auditoría
- mantener legacy solo como histórico o migrarlo

## Checklist de validación de DB (después de ejecutar SQL)

- Confirmar tablas:
  - `select to_regclass('public.pedidos_v2');`
  - `select to_regclass('public.admin_notificaciones');`
  - `select to_regclass('public.pedido_pagos');`
- Confirmar enums:
  - `select * from pg_type where typname in ('pedido_estado_flujo','pedido_estado_pago','negocio_modalidad_liquidacion');`
- Confirmar RLS habilitado:
  - `select relname, relrowsecurity from pg_class where relname in ('pedidos_v2','pedido_eventos','admin_notificaciones');`

## Nota sobre eliminación de seeds de prueba

La eliminación de `supabase/seed/001_tienda_prueba.sql` y `supabase/seed/002_repartidor_prueba.sql` se recomienda como una fase separada de saneamiento (para no mezclar diseño de migración con limpieza de repo).

