# Bloque 7

## Diseño del modelo de datos profesional y saneamiento

Fecha: 2026-06-09

## Objetivo

Preparar la base de datos de Mándalo para una operación multinegocio escalable, sin romper la máquina de estados ni el flujo ya blindado en la aplicación.

Este bloque no debe cambiar todavía la semántica del flujo conversacional ni la puerta segura `transitionOrderState()`. Su misión es diseñar la nueva base relacional, definir una migración gradual y ordenar la deuda técnica que hoy impide escalar con seguridad.

## Principio rector

La aplicación ya tiene una capa de control de estados robusta. El modelo de datos nuevo debe adaptarse a esa capa, no obligarla a retroceder.

Eso implica:

- no volver a mezclar chat, orden y eventos en una sola tabla
- no usar texto libre para campos críticos de negocio
- no romper compatibilidad de ejecución durante la migración
- introducir tablas nuevas con convivencia temporal

## Objetivos específicos

1. Separar entidades de negocio reales.
2. Preparar operación multinegocio con configuración independiente.
3. Modelar pagos y liquidaciones por negocio.
4. Crear memoria de cliente para personalización futura.
5. Diseñar base para reportes semanales automáticos.
6. Incorporar notificaciones operativas al administrador.
7. Mantener soporte para priorización de tiendas y aprendizaje dinámico del catálogo.

## Restricciones duras

- no romper `transitionOrderState()`
- no romper el flujo de WhatsApp ya estabilizado
- no hacer migración destructiva en un solo paso
- no eliminar tablas actuales sin fase de coexistencia
- la IA puede sugerir sustitutos sin detener la conversación, pero no debe inventar disponibilidad confirmada

## Problemas del modelo actual

Hoy `public.pedidos` concentra demasiadas funciones:

- historial de mensajes
- orden activa
- snapshot del pedido
- eventos de actor
- estado conversacional

Eso impide:

- auditar una orden con claridad
- saber qué negocio atendió qué venta
- liquidar por tienda
- generar reportes confiables
- construir memoria del cliente
- soportar administración multinegocio seria

## Modelo de datos objetivo

La propuesta final separa las siguientes entidades:

### Núcleo transaccional

- `negocios`
- `pedidos`
- `pedido_items`
- `pedido_eventos`
- `pedido_mensajes`
- `pedido_pagos`

### Núcleo relacional de clientes

- `clientes`
- `historial_clientes`
- `cliente_direcciones`
- `cliente_favoritos` (opcional en fase posterior)

### Operación y analítica

- `reportes_semanales`
- `reporte_movimientos`
- `admin_notificaciones`

### Catálogo y aprendizaje comercial

- `catalogo_productos`
- `negocio_productos`
- `sugerencias_sustitucion`

## Diseño propuesto por tabla

## 1. `negocios`

Tabla maestra de comercios.

### Propósito

- representar cada tienda como unidad operativa independiente
- soportar reglas comerciales, pago, prioridad y catálogo

### Columnas clave

- `id`
- `created_at`
- `activo`
- `nombre`
- `slug`
- `categoria`
- `descripcion`
- `whatsapp`
- `direccion_texto`
- `zona_servicio`
- `acepta_contra_entrega` boolean
- `liquidacion_modalidad` enum sugerido:
  - `contra_entrega`
  - `semanal`
- `liquidacion_dia_corte`
- `liquidacion_dia_pago`
- `prioridad_posicionamiento` integer
- `premium_activo` boolean
- `metadata_json`

### Índices sugeridos

- índice por `activo`
- índice por `categoria`
- índice por `whatsapp`
- índice compuesto por `activo, prioridad_posicionamiento desc`

### Uso futuro

- posicionamiento premium
- selección inteligente de negocio por IA
- reglas de comisión y liquidación por tienda

## 2. `clientes`

Tabla maestra del cliente.

### Propósito

- desacoplar identidad del cliente de la orden
- consolidar memoria futura

### Columnas clave

- `id`
- `created_at`
- `telefono`
- `nombre_preferido`
- `ultima_direccion_texto`
- `ultima_zona_validada`
- `ultimo_pedido_at`
- `metadata_json`

### Índices

- único por `telefono`

## 3. `cliente_direcciones`

### Propósito

- almacenar direcciones usadas por el cliente
- soportar dirección favorita y validación territorial

### Columnas clave

- `id`
- `cliente_id`
- `direccion_texto`
- `google_maps_link`
- `es_favorita`
- `esta_en_zona_servicio`
- `zona_detectada`
- `ultima_utilizada_at`

### Nota

La validación de Ixtlahuacán del Río debe persistirse aquí para reutilizarse sin depender siempre del texto libre.

## 4. `historial_clientes`

### Propósito

- base de la memoria útil del cliente
- permitir personalización sin contaminar la tabla de pedidos

### Columnas clave

- `id`
- `cliente_id`
- `tipo_evento` ejemplo:
  - `pedido_realizado`
  - `pedido_cancelado`
  - `direccion_confirmada`
  - `favorito_detectado`
  - `sustituto_aceptado`
- `resumen`
- `payload_json`
- `created_at`

### Uso futuro

- “el cliente suele pedir Coca 2L”
- “el cliente acostumbra pagar contra entrega”
- “el cliente vive dentro de Ixtlahuacán”

## 5. `pedidos`

Esta será la tabla central del flujo operativo.

### Propósito

- representar la orden como entidad estable y auditable

### Columnas clave

- `id`
- `created_at`
- `updated_at`
- `cliente_id`
- `negocio_id`
- `repartidor_id` nullable
- `estado_flujo`
- `estado_pago`
- `subtotal_tienda`
- `cargo_envio`
- `cargo_servicio`
- `total_cliente`
- `metodo_pago`
- `direccion_entrega_texto`
- `google_maps_link`
- `esta_en_zona_servicio`
- `zona_detectada`
- `snapshot_json`
- `origen_canal` ejemplo `whatsapp`
- `observaciones_operativas`

### Estado de flujo

Debe seguir el catálogo ya aprobado:

- `capturando_pedido`
- `rechazado_fuera_de_zona`
- `pendiente_confirmacion_cliente`
- `pendiente_cotizacion_tienda`
- `pendiente_aprobacion_total`
- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`
- `cancelado`
- `bloqueado_operativamente`

### Estado de pago

Separado del flujo:

- `pendiente`
- `cobrado`
- `liquidado`
- `anulado`

### Justificación

Hoy flujo y pago están implícitamente mezclados. Deben separarse porque una orden puede estar entregada pero aún no liquidada a la tienda.

## 6. `pedido_items`

### Propósito

- evitar depender solo de JSON para productos
- soportar reportes, favoritos y sustituciones

### Columnas clave

- `id`
- `pedido_id`
- `producto_nombre`
- `cantidad`
- `unidad`
- `detalle`
- `precio_unitario`
- `subtotal`
- `fue_sustituido`
- `producto_sustituto_nombre`
- `metadata_json`

### Beneficio

Permite reportes por producto y entrenamiento posterior del motor de sugerencias.

## 7. `pedido_eventos`

### Propósito

- auditoría de transiciones y acciones

### Columnas clave

- `id`
- `pedido_id`
- `tipo_evento`
- `estado_origen`
- `estado_destino`
- `actor_tipo`
- `actor_id`
- `actor_telefono`
- `descripcion`
- `payload_json`
- `created_at`

### Ejemplos

- cotización recibida
- cliente aprobó total
- repartidor aceptó
- entrega confirmada
- pedido fuera de zona

### Relación con `transitionOrderState()`

Toda transición segura debe poder registrar un evento aquí. No reemplaza la máquina de estados; la audita.

## 8. `pedido_mensajes`

### Propósito

- separar chat del estado del pedido

### Columnas clave

- `id`
- `pedido_id` nullable si aún no hay pedido consolidado
- `cliente_id` nullable
- `rol_mensaje`
- `telefono_origen`
- `telefono_destino`
- `contenido`
- `canal`
- `metadata_json`
- `created_at`

### Beneficio

Permite eliminar a futuro la sobrecarga de `public.pedidos` como bitácora de chat.

## 9. `pedido_pagos`

### Propósito

- registrar cobro y liquidación

### Columnas clave

- `id`
- `pedido_id`
- `negocio_id`
- `estado_pago`
- `monto_cobrado_cliente`
- `monto_liquidable_negocio`
- `fecha_cobro`
- `fecha_liquidacion`
- `modalidad_liquidacion`
- `referencia_pago`
- `metadata_json`

### Regla

Un pedido entregado puede seguir en `pendiente` o `cobrado` hasta la liquidación semanal.

## 10. `reportes_semanales`

### Propósito

- snapshot semanal de ventas para administración

### Columnas clave

- `id`
- `fecha_inicio`
- `fecha_fin`
- `total_pedidos`
- `total_entregados`
- `total_cancelados`
- `monto_total_vendido`
- `monto_total_cobrado`
- `monto_total_liquidado`
- `negocios_activos`
- `payload_json`
- `created_at`

## 11. `reporte_movimientos`

### Propósito

- detalle granular por evento contable y operativo

### Columnas clave

- `id`
- `reporte_semanal_id`
- `pedido_id`
- `negocio_id`
- `tipo_movimiento`
- `monto`
- `descripcion`
- `created_at`

## 12. `admin_notificaciones`

### Propósito

- registrar avisos enviados al número administrador

### Columnas clave

- `id`
- `pedido_id` nullable
- `tipo_notificacion`
- `destinatario_telefono`
- `contenido`
- `estado_envio`
- `created_at`

### Tipos de notificación iniciales

- `venta_entregada`
- `resumen_semanal`
- `alerta_operativa`

## Lógica de administrador

El número administrador es:

- `3310184790`

### Notificación inmediata al terminar venta

Disparador:

- transición a `entregado`

Contenido mínimo:

- pedido entregado
- `pedido_id`
- nombre o teléfono del cliente
- negocio que atendió
- total cobrado
- forma de pago

### Resumen semanal automático

Disparador:

- proceso programado semanal

Contenido mínimo:

- total de ventas
- total cobrado
- total liquidado
- negocios con más ventas
- cancelaciones
- pedidos fuera de zona
- incidencias operativas

## Cómo integrar esto sin romper la estabilidad actual

## Estrategia de ejecución por fases

### Fase 7.1 - Diseño y convivencia

Objetivo:

- crear tablas nuevas sin apagar las actuales
- no cambiar aún la fuente primaria del flujo

Acciones:

- crear nuevas migraciones
- agregar relaciones e índices
- no eliminar `public.pedidos` actual todavía

### Fase 7.2 - Sincronización dual

Objetivo:

- hacer que las nuevas órdenes se reflejen también en el modelo nuevo

Acciones:

- cuando se actualice una orden vía `transitionOrderState()`, registrar:
  - evento en `pedido_eventos`
  - actualización en `pedidos` nueva si ya existe
- mantener tabla legacy viva durante transición

### Fase 7.3 - Separación de chat

Objetivo:

- dejar de usar `pedidos` legacy como bitácora conversacional

Acciones:

- escribir mensajes en `pedido_mensajes`
- migrar historial reciente a consultas sobre tabla nueva

### Fase 7.4 - Activar pagos y reportes

Objetivo:

- registrar estados de pago y generar resumen semanal

Acciones:

- alta de `pedido_pagos`
- generación de `reportes_semanales`
- notificación semanal al administrador

### Fase 7.5 - Retiro de legacy

Objetivo:

- retirar seeds de prueba y deuda técnica

Acciones:

- eliminar `001_tienda_prueba.sql`
- eliminar `002_repartidor_prueba.sql`
- reemplazarlos por seeds formales de desarrollo o fixtures no productivos
- eliminar dependencias del flujo a la tabla híbrida antigua

## Limpieza quirúrgica

### Archivos a retirar o sanear

- `supabase/seed/001_tienda_prueba.sql`
- `supabase/seed/002_repartidor_prueba.sql`

### Antes de eliminarlos

Debe existir uno de estos reemplazos:

- seeds de desarrollo con datos de ejemplo marcados como no productivos
- scripts de fixtures separados por ambiente
- documentación clara de cómo crear negocio y repartidor de prueba

### Regla

No eliminar por eliminar. Sustituir por un mecanismo de bootstrap más profesional.

## Compatibilidad con la máquina de estados

El modelo nuevo no debe redefinir estados.

Debe:

- almacenar `estado_flujo` con el catálogo canónico
- permitir que `transitionOrderState()` siga siendo la autoridad
- registrar el resultado en `pedido_eventos`

No debe:

- crear otra máquina de estados en SQL
- introducir aliases nuevos

## Lógica de sustituciones y faltantes

La IA debe poder sugerir sustitutos sin romper el estado.

Eso implica:

- la falta de inventario no cambia `estado_flujo`
- se mantiene en `capturando_pedido` o vuelve ahí si hace falta corrección
- la tienda puede responder con alternativas
- esas alternativas deben poder registrarse en:
  - `sugerencias_sustitucion`
  - `pedido_items.fue_sustituido`
  - `historial_clientes`

## Tablas sugeridas para esto

### `catalogo_productos`

- `id`
- `nombre_canonico`
- `categoria`
- `marca`
- `presentacion`
- `unidad`
- `activo`

### `negocio_productos`

- `id`
- `negocio_id`
- `catalogo_producto_id` nullable
- `nombre_visible`
- `precio_referencia`
- `disponible`
- `prioridad_catalogo`

### `sugerencias_sustitucion`

- `id`
- `pedido_id`
- `pedido_item_id`
- `negocio_id`
- `producto_solicitado`
- `producto_sugerido`
- `motivo`
- `aceptada`
- `created_at`

### Beneficio

Esto permite que la IA aprenda gradualmente qué alternativas son comunes en el mercado mexicano, sin asumir que el inventario de una tienda siempre estará completo.

## Soporte a priorización premium

La priorización de tiendas debe resolverse en `negocios`.

Campos recomendados:

- `premium_activo`
- `prioridad_posicionamiento`
- `categoria`
- `activo`

Regla de negocio:

- la IA y el selector de negocio pueden considerar prioridad más alta para negocios premium, pero nunca deben ignorar:
  - disponibilidad
  - zona
  - tipo de producto
  - reglas operativas

## Riesgos a controlar en ejecución

### Riesgo 1

Migrar demasiado rápido y romper consultas actuales.

Mitigación:

- convivencia dual
- migraciones aditivas primero

### Riesgo 2

Duplicar estados entre app y DB.

Mitigación:

- mantener una sola autoridad en aplicación
- DB como persistencia y auditoría

### Riesgo 3

Intentar usar catálogo de productos como inventario real demasiado pronto.

Mitigación:

- empezar como catálogo de referencia y sustituciones
- no venderlo como inventario en tiempo real hasta que exista soporte operativo

### Riesgo 4

Romper la lógica del administrador con notificaciones no idempotentes.

Mitigación:

- registrar cada notificación en `admin_notificaciones`
- no reenviar si ya existe confirmación de envío

## Orden recomendado de implementación

1. Diseñar migraciones nuevas para tablas relacionales.
2. Definir mapeo de `pedidos` legacy a modelo nuevo.
3. Crear escritura dual controlada para órdenes nuevas.
4. Crear `pedido_eventos` y `pedido_mensajes`.
5. Activar estados de pago.
6. Activar notificación inmediata al administrador al entregar.
7. Activar reporte semanal automático.
8. Retirar seeds legacy y formalizar fixtures.
9. Migrar memoria del cliente.
10. Introducir catálogo de productos y sustituciones.

## Entregables recomendados para ejecutar este bloque

### Documento 1

Diseño SQL de migraciones nuevas:

- creación de tablas
- índices
- foreign keys
- constraints esenciales

### Documento 2

Plan de migración legacy -> nuevo modelo:

- qué se conserva
- qué se replica
- qué se elimina al final

### Documento 3

Contrato de automatizaciones:

- notificación inmediata al administrador
- reporte semanal

## Conclusión

El Bloque 7 no debe verse como “hacer más tablas”. Debe verse como la separación definitiva entre:

- operación
- conversación
- pagos
- analítica
- memoria de cliente

La mejor forma de ejecutarlo sin comprometer estabilidad es con migraciones aditivas, coexistencia temporal y retiro gradual del modelo híbrido actual.
