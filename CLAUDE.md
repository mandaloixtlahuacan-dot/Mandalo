# Mándalo — Contexto del Proyecto (leer siempre antes de programar)

> Este archivo es la fuente de verdad del negocio y arquitectura de Mándalo.
> Última actualización: 04 de agosto de 2026

## 1. Qué es Mándalo

Sistema de delivery automatizado por WhatsApp para **Ixtlahuacán del Río**. Un solo número de WhatsApp atiende a tres tipos de usuarios (clientes, tiendas, repartidores); el sistema distingue el rol de quien escribe según en qué tabla está registrado su número de teléfono. No hay tabla de "usuarios" genérica — cada tabla de rol define su propio comportamiento.

## 2. Roles y gobernanza

- **Víctor (Arquitecto):** define visión, valida cambios, administrador central.
- **Claude Code (Arquitecto Jefe y Codificador):** audita el código, detecta fallas, optimiza lógica, implementa los cambios, y cuida que ninguna implementación viole las reglas de este documento. Es la única herramienta de desarrollo del proyecto — Trae AI ya no se usa.

**Pacto de honestidad:** cualquier riesgo técnico o ineficiencia se comunica de inmediato, sin ocultarlo.

## 3. Stack tecnológico

- **NLP:** OpenAI GPT-4-turbo, fallback GPT-3.5-turbo
- **Canal:** WhatsApp vía Whapi.cloud (+52 33 1169 2798)
- **Base de datos:** Supabase (única fuente de verdad)
- **Hosting:** Vercel, plan Hobby → **arquitectura event-driven** (sin cron jobs frecuentes), workers reactivos activados por Webhooks de Supabase

## 4. Esquema de base de datos (definitivo, desde cero)

### `clientes`
- `telefono` (PK)
- `nombre`
- `direccion_entrega` (debe ser PIN de GPS, no texto libre)
- `created_at`

### `tiendas`
- `id` (PK)
- `nombre`
- `telefono` (recibe notificaciones de pedidos)
- `direccion`
- `activa` (bool)
- `hora_apertura`
- `hora_cierre`

### `repartidores`
- `id` (PK)
- `nombre`
- `telefono`
- `disponible` (bool)
- `activo` (bool)

### `productos_tienda` (opcional por tienda)
- `id` (PK)
- `tienda_id` (FK)
- `nombre_producto`
- `precio`
- `disponible`

> Si una tienda no tiene catálogo cargado aquí, el bot usa inferencia genérica de productos comunes de tiendita (IA), pidiendo siempre confirmación del producto exacto al cliente.

### `pedidos` (pedido general, puede incluir varias tiendas)
- `id` (PK)
- `cliente_telefono` (FK)
- `repartidor_id` (FK, nulo hasta asignar)
- `estado` (ver máquina de estados)
- `direccion_entrega` (coordenadas GPS)
- `servicio_mandalo` (fijo: $20)
- `servicio_repartidor` (calculado: ver regla financiera)
- `total_cliente`
- `created_at`

### `pedido_tiendas` (una fila por tienda dentro de un pedido)
- `id` (PK)
- `pedido_id` (FK)
- `tienda_id` (FK)
- `subtotal_tienda`
- `estado_tienda` (`pendiente`, `confirmado`, `ajuste_producto`, `cancelado`)

### `pedido_items`
- `id` (PK)
- `pedido_tienda_id` (FK)
- `nombre_producto`
- `cantidad`
- `disponible`

**Retención:** solo se conservan pedidos activos. Al llegar a `entregado` o `cancelado`, el registro se elimina (no se guarda historial).

**Notas de implementación (Fase 2 de la migración, agosto 2026):** dos columnas/tablas que no pide esta sección pero que se agregaron por necesidad operativa real, detectada al reescribir el código sobre el esquema definitivo:
- `pedidos.metadata_json` (jsonb): guarda detalle operativo del ciclo de vida del repartidor (intentos de asignación, deadlines de confirmación, timestamps de recogida/entrega) que no tiene sentido aplanar en columnas fijas — es el mismo patrón que ya usan otras tablas del esquema (Bloque 7).
- `admin_notificaciones` se amplió como outbox general de mensajes (no solo avisos al administrador): se le agregaron `destinatario_tipo`/`destinatario_id`, y `tipo` pasó de enum cerrado a texto libre. Reaprovecha el mecanismo de claim atómico ya probado (`FOR UPDATE SKIP LOCKED`) en vez de construir una tabla outbox aparte desde cero. Incluye un RPC nuevo, `claim_admin_notificacion_by_id`, para reclamar una notificación puntual (disparo por webhook) además del claim por lote ya existente.

## 5. Reglas de oro (innegociables)

1. **Cobertura geográfica:** solo Ixtlahuacán del Río. Se valida por radio de distancia (Haversine) desde un punto central del pueblo, usando SIEMPRE ubicación GPS compartida por WhatsApp (no texto libre). Si está fuera del radio, se cancela antes de crear cualquier registro. *(Radio a calibrar con direcciones reales del pueblo — pendiente de definir el valor exacto en km).*
2. **Precio:**
   `total_cliente = Σ subtotal_tienda + $20 (Mándalo) + servicio_repartidor`
   `servicio_repartidor = $35 + $15 × (número de tiendas adicionales más allá de la primera)`
3. **Pago:** solo efectivo, cobrado por el repartidor directamente al cliente.
4. **Roles fijos por número:** un número registrado como tienda o repartidor NO puede pedir como cliente desde ese mismo número — se comunica manualmente a cada empleado que use un número distinto para pedidos personales. Cualquier número no registrado se trata como cliente.
5. **Confirmación de productos:** la IA siempre repite/confirma el producto entendido antes de mandarlo a la tienda, para corregir errores de escritura del cliente.

## 6. Flujo del pedido (paso a paso)

1. Cliente comparte ubicación (PIN GPS) y pide productos (puede ser de varias tiendas)
2. Bot valida cobertura geográfica → si está fuera, cancela ahí mismo
3. Cliente confirma el pedido completo
4. Cada tienda involucrada recibe notificación de su parte del pedido
5. Tienda revisa inventario:
   - Si tiene todo → confirma precio y disponibilidad
   - Si falta algo → reporta al bot → bot le pregunta al cliente si cambia o cancela ese producto
6. Cuando **todas** las tiendas confirman, se calcula `total_cliente` y se busca repartidor
7. Se asigna repartidor (ver regla de asignación abajo) con todos los datos: cliente, dirección, tiendas a visitar, monto a cobrar
8. Repartidor visita cada tienda, marca `#RECOGI`
9. Repartidor entrega, marca `#ENTREGADO`
10. Cliente recibe notificaciones en cada paso: pedido en camino, recogido, entregado — "gracias por tu compra y por confiar en nosotros"

## 7. Máquina de estados (`pedidos.estado`)

```
seleccion_productos
confirmacion_cliente
pendiente_tiendas
ajuste_producto
confirmado_tiendas
dispatch_repartidor_pendiente
repartidor_asignado
recogiendo
en_camino_cliente
entregado
cancelado
```

## 8. Timeouts y casos límite (definidos)

| Caso | Regla |
|---|---|
| Tienda no responde | 7 minutos → se cancela esa parte del pedido; se avisa a las demás tiendas del mismo pedido que ya no preparen nada |
| Repartidor no puede completar a medio pedido | Repartidor original cancela con comando de cambio de repartidor; sistema reasigna a otro repartidor activo; cliente recibe aviso de que "hubo un cambio pero su pedido sigue en pie"; los repartidores se coordinan la entrega física entre ellos, fuera del sistema |
| Pedido multi-tienda, confirmaciones asíncronas | El repartidor NO recibe el pedido hasta que **todas** las tiendas hayan confirmado precio/disponibilidad — evita confusión sobre cuánto cobrar |
| Cliente no responde a un ajuste de producto | 10 minutos → se cancela el pedido automáticamente y se notifica al cliente y a la(s) tienda(s) que ya no esperen confirmación |
| Varios repartidores disponibles | Se notifica a todos los repartidores activos; el primero en confirmar se queda con el pedido; a los demás se les avisa "pedido ya tomado". **Nota técnica para implementación:** la asignación debe ser atómica (evitar que dos repartidores queden asignados al mismo pedido por una confirmación simultánea) |
| Tienda fuera de horario | Se valida automáticamente contra `hora_apertura`/`hora_cierre`; si está cerrada, no aparece como opción para el cliente en ese momento |
| Error de escritura del cliente en productos | La IA confirma siempre el producto entendido antes de continuar |

**Notas técnicas de implementación (no son reglas de negocio nuevas, son detalles que Claude Code debe resolver bien al programar):**
- Al cancelar por timeout de tienda (7 min) o de cliente (10 min) en un pedido multi-tienda, notificar también a las demás tiendas involucradas para que no dejen apartado el producto sin saberlo que se canceló.
- La asignación de repartidor (cuando varios confirman casi al mismo tiempo) debe ser atómica a nivel de base de datos (ej. actualización condicional o transacción) para evitar que dos repartidores queden asignados al mismo pedido.

## 9. Tono y atención al cliente del bot

- Saluda siempre al inicio de la conversación, de forma cálida y personal (no un menú frío de opciones).
- Lenguaje simple y sin fricción: debe poder usarlo tanto un abuelo como un adolescente sin confundirse. Evitar jerga técnica, mensajes largos, o pasos innecesarios.
- Concreto pero amable: mensajes cortos y claros, pero con calidez — el cliente debe sentir confianza de que su pedido va a llegar bien.
- Confirmar siempre lo que se entendió (dirección, productos) antes de avanzar, en lenguaje natural, no como formulario.
- Cierre de cada pedido con agradecimiento genuino ("gracias por tu compra y por confiar en nosotros").

## 10. Seguridad

- Autorización interna entre procesos/workers: header `Authorization: Bearer skvictor` (basado en `CRON_SECRET`)
- Comandos de repartidor/tienda en mayúsculas: `#PRECIO`, `#CONFIRMO`, `#RECOGI`, `#ENTREGADO` (y comando de cambio de repartidor, pendiente de nombre exacto)

## 12. Contexto de la transición (por qué llegamos aquí)

El proyecto se desarrolló originalmente en **Trae AI** (modelo GPT-5.5 Pro), con subida manual por terminal a GitHub y despliegue automático en Vercel. El flujo se volvió difícil de mantener: el contexto del proyecto vivía disperso entre Trae, un rol de "Arquitecto Jefe" en NotebookLM (que daba respuestas inconsistentes), y la memoria de Víctor. La base de datos en Supabase quedó desordenada tras varias iteraciones (columnas de trazabilidad como `legacy_pedido_id` sugieren migraciones a medias). Víctor decidió dejar Trae y NotebookLM por completo y consolidar todo el desarrollo en Claude Code, con este documento como única fuente de verdad del contexto — sin tener que re-explicarlo en cada sesión.

**Regla para Claude Code:** si en cualquier momento hace falta una API key, credencial, o acceso que no esté ya configurado en el proyecto (Supabase, Whapi.cloud, OpenAI, GitHub, Vercel), pedirla directamente a Víctor. Nunca asumir, inventar, o dejar un placeholder sin avisar explícitamente.

## 13. Guía de tareas al recibir el proyecto (para Claude Code)

Cuando Víctor suba la carpeta del proyecto actual (desarrollado antes en Trae) y active esta sesión, seguir este orden. **La base de datos de Supabase está desordenada y es prioridad atenderla primero**, antes de tocar lógica de negocio o el prompt del bot:

1. **Diagnóstico primero, cambios después.** Analizar todo el proyecto y compararlo contra este documento. Reportar a Víctor qué coincide, qué no, y qué está roto o incompleto, antes de tocar código.
2. **Base de datos (prioridad #1):** revisar el esquema actual de Supabase (tablas `pedidos_v2`, `repartidores`, `negocio_productos` u otras que existan) contra el esquema definitivo de la Sección 4. Esta base de datos está desordenada por iteraciones previas — proponer la migración completa a las tablas nuevas (`clientes`, `tiendas`, `repartidores`, `productos_tienda`, `pedidos`, `pedido_tiendas`, `pedido_items`) y ejecutarla solo con aprobación explícita de Víctor, ya que implica borrar datos existentes.
3. **Conexión Supabase ↔ código:** verificar que las variables de entorno y el cliente de Supabase en el código apunten correctamente al proyecto y a las tablas nuevas, sin fallas de conexión.
4. **Webhook de WhatsApp (Whapi.cloud):** revisar que las llaves de Whapi estén configuradas correctamente (el proyecto migró de UltraMSG a Whapi — verificar que no queden referencias o configuración residual de UltraMSG). Confirmar que el webhook reciba y enrute mensajes correctamente.
5. **Prompt del agente de IA:** revisar el prompt actual contra la Sección 9 (tono y atención al cliente) y las reglas de negocio de la Sección 5. Ajustar para que cumpla ambas.
6. **Lógica de roles y ruteo:** verificar que el código distinga correctamente entre cliente, tienda y repartidor según el número de teléfono, conforme a la Sección 1.
7. **Ubicación GPS y radio de cobertura:** implementar la validación de PIN de GPS contra el radio de cobertura (Sección 5, regla 1). El valor exacto del radio se define junto con Víctor usando direcciones reales del pueblo.
8. **Despliegue en Vercel:** confirmar que el proyecto siga desplegando correctamente tras los cambios, sin romper la integración con GitHub.
9. **Limpieza general:** eliminar código muerto, referencias a arquitectura anterior, y simplificar donde sea posible — priorizando siempre la opción más simple que cumpla las reglas de negocio, no la más sofisticada.
10. **Cualquier cambio estructural importante** (borrar tablas, cambiar arquitectura, modificar reglas de precio) se propone primero y se ejecuta solo con aprobación de Víctor.

## 14. Pendientes por definir

- [ ] Valor exacto del radio de cobertura en km (calibrar con direcciones reales de Ixtlahuacán del Río)
- [ ] Nombre exacto del comando de "cambio de repartidor"
- [ ] Migración de datos existentes (si aplica) desde el esquema anterior de Supabase al nuevo
- [ ] `PedidoSnapshot` no guarda los productos capturados entre turnos — la IA depende solo del historial de chat en texto plano para "recordar" qué se pidió. Si el cliente aclara un producto sin repetir el nombre completo, se pierde. Detectado en la prueba de punta a punta de la Fase 2 (agosto 2026) contra el Preview real de Vercel. Arreglo: agregar `items` al snapshot y pasarlo de vuelta a la IA como contexto explícito, no solo como historial de chat.
