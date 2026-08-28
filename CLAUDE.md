# Mándalo — Contexto del Proyecto (leer siempre antes de programar)

> Este archivo es la fuente de verdad del negocio y arquitectura de Mándalo.
> Última actualización: 24 de agosto de 2026
>
> Para saber qué está construido, qué está roto y qué falta ahora mismo, ver
> **`ROADMAP.md`** — ese archivo se actualiza cada ciclo de trabajo; este
> documento describe reglas de negocio y arquitectura, que cambian poco.

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

**Notas de implementación (Fase 2 de la migración, agosto 2026):** columnas/tablas que no pide esta sección pero que se agregaron por necesidad operativa real, detectada al reescribir el código sobre el esquema definitivo:
- `pedidos.metadata_json` (jsonb): guarda detalle operativo del ciclo de vida del repartidor (intentos de asignación, deadlines de confirmación, timestamps de recogida/entrega) que no tiene sentido aplanar en columnas fijas — es el mismo patrón que ya usan otras tablas del esquema (Bloque 7). Desde agosto 2026 también guarda los deadlines/recordatorios de los tres timeouts unificados de 10 min (Sección 8).
- `admin_notificaciones` se amplió como outbox general de mensajes (no solo avisos al administrador): se le agregaron `destinatario_tipo`/`destinatario_id`, y `tipo` pasó de enum cerrado a texto libre. Reaprovecha el mecanismo de claim atómico ya probado (`FOR UPDATE SKIP LOCKED`) en vez de construir una tabla outbox aparte desde cero. Incluye un RPC nuevo, `claim_admin_notificacion_by_id`, para reclamar una notificación puntual (disparo por webhook) además del claim por lote ya existente.
- `clientes.metadata_json` (jsonb): guarda `chat_history` (historial de chat reciente, acotado a las últimas ~30 entradas) — vive en `clientes` y no en `pedidos` porque el cliente puede platicar con el bot (saludo, small talk) sin tener un pedido activo. Se reinicia por completo cuando un pedido cierra (Sección 4, regla de retención) — ver `messages.resetChatHistory` / `pedidoRepositoryV2.finalizePedidoRetention`.

## 5. Reglas de oro (innegociables)

1. **Cobertura geográfica:** solo Ixtlahuacán del Río. Se valida por radio de distancia (Haversine) desde un punto central del pueblo, usando SIEMPRE ubicación GPS compartida por WhatsApp (no texto libre). Si está fuera del radio, se cancela antes de crear cualquier registro. *(Radio a calibrar con direcciones reales del pueblo — pendiente de definir el valor exacto en km).*
2. **Precio:**
   `total_cliente = Σ subtotal_tienda + $10 (Mándalo) + servicio_repartidor`
   `servicio_repartidor = $25 + $15 × (número de tiendas adicionales más allá de la primera)`
   *(Ajustado agosto 2026: antes $20/$35 — Mándalo $10 + repartidor $25 = $35 de cargos fijos, en vez de $55.)*
3. **Pago:** solo efectivo, cobrado por el repartidor directamente al cliente.
4. **Roles fijos por número:** un número registrado como tienda o repartidor NO puede pedir como cliente desde ese mismo número — se comunica manualmente a cada empleado que use un número distinto para pedidos personales. Cualquier número no registrado se trata como cliente.
5. **Confirmación de productos:** la IA siempre repite/confirma el producto entendido antes de mandarlo a la tienda, para corregir errores de escritura del cliente.
6. **Horario de atención:** el bot platica y arma pedidos 24/7 (no hay horario de "cierre de conversación"). El **reparto** sí tiene ventana fija: por ahora Mándalo entrega de **3pm a 9pm** (horario real del repartidor, reintroducido agosto 2026 tras la fase 24/7 — antes de esto era 24/7 sin ninguna ventana; antes de eso, 8am-8pm; ajustado de 3pm-8pm a 3pm-9pm el 27 de agosto de 2026). Se comunica siempre como algo vigente por ahora, no como una limitación permanente — el bot nunca lo presenta como una regla fija para siempre. Cada tienda mantiene además su propio horario (`hora_apertura`/`hora_cierre`). Si el cliente pide fuera de la ventana de Mándalo, o de una tienda cerrada en ese momento (o ambas cosas), el pedido se arma normal y se programa para dispararse automáticamente en cuanto se pueda repartir de verdad — mismo mecanismo para las dos condiciones (ver Sección 7, estado `esperando_apertura_tienda`, y Sección 8).
7. **Cancelación gratuita:** el cliente puede cancelar sin costo mientras **él mismo** no haya confirmado el precio final con un SÍ — esto incluye el tramo en que la tienda ya cotizó y se le muestra el total (`confirmado_tiendas`), no solo antes de que la tienda responda. A partir de que el cliente confirma (`dispatch_repartidor_pendiente` en adelante, con repartidor ya involucrado), cancelar deja de ser autoservicio: se escala al administrador. *(Corregido agosto 2026 — antes el corte se ponía en cuanto la tienda cotizaba, no en cuanto el cliente confirmaba; un "No" del cliente al precio final dejaba el pedido atorado sin cancelarse.)*

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
esperando_apertura_tienda
```

`esperando_apertura_tienda` (agosto 2026): el cliente ya confirmó su pedido, pero no se puede despachar todavía — la tienda elegida está cerrada, o Mándalo está fuera de su ventana de reparto (por ahora 3pm-9pm), o ambas cosas. El pedido espera aquí hasta que las dos condiciones se cumplan a la vez, momento en el que se dispara automáticamente la cotización y el pedido pasa a `pendiente_tiendas`, exactamente como un pedido normal a partir de ahí. Se alcanza desde `confirmacion_cliente` (en vez de `pendiente_tiendas` directo) cuando cualquiera de las dos condiciones falla en el momento de la confirmación. Sigue dentro de la ventana de cancelación gratuita (Sección 5 regla 7: la tienda todavía no ha visto el pedido) — ver Sección 8 sobre el límite de 48h de espera.

## 8. Timeouts y casos límite (definidos)

Timeouts **unificados a 10 minutos, con recordatorio a los 5**, en los tres puntos de espera del flujo (redefinido agosto 2026 — reemplaza los 7 minutos que este documento pedía antes para tienda; confirmado con Víctor que el brief manda sobre esta sección):

| Caso | Regla |
|---|---|
| Tienda no responde a la cotización | 10 minutos (recordatorio a los 5) → se cancela el pedido; se informa al cliente que puede pedir de otra tienda; se avisa a la tienda que ya no es necesario cotizar |
| Cliente no confirma el precio final | 10 minutos (recordatorio a los 5) → se cancela el pedido; se notifica al cliente y a la tienda involucrada |
| Ningún repartidor acepta el pedido dentro del plazo (asignación inicial) | 10 minutos (recordatorio a los 5) → se cancela el pedido directo (**no** se reintenta con otro repartidor en cadena — simplificación confirmada con Víctor en agosto 2026); se avisa al cliente que no hay repartidores disponibles por ahora y a la tienda que ya no es necesario prepararlo |
| Repartidor no puede completar a medio pedido (ya había aceptado) | Caso distinto al de arriba — aquí el repartidor SÍ había aceptado. Repartidor original cancela con comando de cambio de repartidor (nombre exacto pendiente); sistema reasigna a otro repartidor activo; cliente recibe aviso de que "hubo un cambio pero su pedido sigue en pie"; los repartidores se coordinan la entrega física entre ellos, fuera del sistema |
| Pedido multi-tienda, confirmaciones asíncronas | El repartidor NO recibe el pedido hasta que **todas** las tiendas hayan confirmado precio/disponibilidad — evita confusión sobre cuánto cobrar |
| Cliente no responde a un ajuste de producto | 10 minutos → se cancela el pedido automáticamente y se notifica al cliente y a la(s) tienda(s) que ya no esperen confirmación |
| Varios repartidores confirman casi al mismo tiempo | El primero en confirmar se queda con el pedido; a los demás se les avisa "pedido ya tomado". **Nota técnica para implementación:** la asignación debe ser atómica (evitar que dos repartidores queden asignados al mismo pedido por una confirmación simultánea) |
| Tienda fuera de horario | Se valida automáticamente contra `hora_apertura`/`hora_cierre`. Al listar tiendas disponibles, una cerrada no aparece como opción. Si el cliente la nombra explícitamente de todos modos, el pedido se programa (estado `esperando_apertura_tienda`, Sección 7) en vez de rechazarse — el cliente se entera en el resumen de confirmación, antes de decir SÍ |
| Pedido fuera de la ventana de reparto de Mándalo (por ahora 3pm-9pm) | Mismo mecanismo que una tienda cerrada — se valida con `checkMandaloSchedule` además de `checkTiendaSchedule`, y el pedido se programa (`esperando_apertura_tienda`) si cualquiera de las dos falla. El cliente se entera en el resumen de confirmación, antes de decir SÍ |
| Tienda/horario de Mándalo programado que nunca abre a la vez | 48 horas desde que el cliente confirmó sin que se cumplan ambas condiciones → se cancela automáticamente, se notifica al cliente y se avisa al admin. Reusa `stateTransitionService.handleOrderTimeoutExpired` (mismo mecanismo que los tres timeouts de 10 min, con un plazo distinto) |
| Error de escritura del cliente en productos | La IA confirma siempre el producto entendido antes de continuar |

**Notas técnicas de implementación (no son reglas de negocio nuevas, son detalles que Claude Code debe resolver bien al programar):**
- Al cancelar por cualquiera de los tres timeouts de 10 min en un pedido multi-tienda, notificar también a las demás tiendas involucradas para que no dejen apartado el producto sin saberlo que se canceló.
- La asignación de repartidor (cuando varios confirman casi al mismo tiempo) debe ser atómica a nivel de base de datos (`UPDATE ... WHERE estado = ...` condicional, no un read-then-write) para evitar que dos repartidores queden asignados al mismo pedido.
- Los tres timeouts de 10 min no se pueden disparar por un Database Webhook (nada cambia en la BD cuando "pasa el tiempo sin respuesta") — se implementan con un job de `pg_cron` dentro de Supabase corriendo cada minuto, no con un Cron Job de Vercel (el plan Hobby limita esos a 1/día). Ver `orderTimeoutWorker.ts` y la migración `20260812_order_timeout_worker_cron.sql`.

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

Decisiones de negocio que le tocan a Víctor. Para el estado de ingeniería
(bugs conocidos, qué falta construir), ver `ROADMAP.md` — no se duplica aquí.

- [ ] Valor exacto del radio de cobertura en km (calibrar con direcciones reales de Ixtlahuacán del Río)
- [ ] Nombre exacto del comando de "cambio de repartidor"
- [x] ~~Migración de datos existentes desde el esquema anterior de Supabase al nuevo~~ — resuelto: Fases 1-3 completas (agosto 2026), datos maestros migrados con Fase 1, sin pedidos reales que conservar.
- [x] ~~`PedidoSnapshot` no persiste tienda/dirección/productos entre turnos~~ — arreglado y mergeado a `main` (commit `5809027`, agosto 2026); pendiente de validar en vivo por Víctor vía WhatsApp real antes de darlo por cerrado del todo (ver `ROADMAP.md`).
