# Auditoría técnica Mándalo

## Flujo, entrega a tienda y plan de corrección

Fecha: 2026-06-15

## Resumen ejecutivo

Mándalo ya recibe mensajes por WhatsApp, clasifica actores y llega hasta la preparación del pedido, pero el flujo todavía tiene dos problemas estructurales:

1. El agente conversacional pierde demasiado contexto operativo y por eso repite preguntas o vuelve a pedir confirmaciones que ya estaban implícitas.
2. El dispatch a tienda puede romperse justo en el momento de la confirmación porque el backend resuelve el negocio únicamente por nombre, ignorando el `business_id` que ya había resuelto antes.

La consecuencia es esta:

- el cliente sí siente que el pedido fue levantado
- el pedido se guarda
- pero en algunos casos nunca se envía al WhatsApp de la tienda registrada en Supabase

## Diagnóstico del flujo conversacional

### Problema 1: el LLM no recibe el estado actual real del pedido

En `src/lib/mandaloFlow.ts`, las llamadas a `getLLMResponse()` siguen mandando:

- `currentOrderState: {}`

Eso ocurre en dos puntos:

- en la rama de conversación libre
- en la rama principal antes de llamar a la IA

Impacto:

- la IA depende casi por completo del historial de chat
- no recibe un snapshot estructurado del pedido actual
- puede volver a preguntar tienda, dirección o productos aunque ya existan en una orden activa

### Problema 2: el sistema mezcla “flujo pendiente” con “modo conversación”

El orden de evaluación en `handleClienteMessage()` provoca varias rutas redundantes:

- primero revisa si hay `esperando_confirmacion`
- luego revisa si hay pedido pendiente
- luego `awaiting_confirm`
- luego `awaiting_quote`
- solo después entra a IA libre

Esto hace que cualquier mensaje fuera del patrón esperado termine en:

- “¿continuar o nuevo?”
- “responde SÍ”
- “estoy esperando el precio”

Aunque el usuario ya haya dado información útil.

### Problema 3: recuperación de dirección poco confiable

La función `fetchDireccionGuardadaDesdePedidos()` busca la dirección en la fila más reciente de `pedidos`, pero esa tabla aún mezcla:

- órdenes
- mensajes
- estados híbridos

Eso hace que el backend tome contexto incompleto o viejo.

## Diagnóstico de la falla de entrega a tienda

## Causa principal

La falla más crítica está en `src/lib/mandaloFlow.ts` durante la confirmación del cliente en estado `esperando_confirmacion`.

### Flujo actual detectado

1. La IA construye `dispatch.business_message`.
2. El backend resuelve el negocio correctamente usando `resolveNegocioFromDb({ id, nombre, whatsapp })`.
3. Crea la orden con:
   - `business_id`
   - `business_name`
   - `business_phone`
   - estado `esperando_confirmacion`
4. Cuando el cliente responde `SÍ`, el backend ya no usa `resolveNegocioFromDb`.
5. En lugar de eso, usa solo:
   - `resolveBusinessWhatsappStrictByName(tiendaNombre)`

### Riesgo exacto

Si el nombre guardado en `business_name`:

- no coincide exactamente con `negocios.nombre`
- viene con variación ligera
- viene truncado o estilizado por la IA

entonces esta línea falla:

- no encuentra `whatsapp`
- no despacha a la tienda

Y el flujo queda atorado aunque el `business_id` ya existía.

## Causa secundaria

El mensaje a tienda sí se intenta enviar por Waapi:

- `waapiSendText({ to: negocio.whatsapp, body: ... })`

El formateo del número parece razonablemente correcto:

- `ensureMxWhatsappIntl(...)`
- `toWaapiChatId(...)`

Por eso, hoy la hipótesis principal NO es el proveedor.

La hipótesis principal es:

- el negocio deja de resolverse bien antes del envío

## Causa terciaria

En `handleTiendaMessage()`, el sistema solo procesa mensajes de tienda si vienen así:

- `ORDEN #123 PRECIO 150`

Si la tienda responde con cualquier otro formato, el backend ignora el mensaje.

Esto no explica que el pedido no llegue a tienda, pero sí explica por qué el flujo puede sentirse roto después.

## Qué revisar en Supabase

### Tabla `negocios`

Validar estas columnas y datos:

- `id`
- `nombre`
- `whatsapp`

Verificar:

- que `business_id` realmente corresponda a una fila existente
- que `whatsapp` esté lleno y bien normalizado
- que no haya nombres ambiguos o duplicados

### Tabla `repartidores`

La consulta ya está saneada para usar solo:

- `public.repartidores`

Pero igual conviene revisar:

- `id`
- `nombre`
- `whatsapp`
- `activo`

## Protocolo correcto del mensaje a tienda

El mensaje que llega a la tienda debe ser único, claro y procesable.

Formato recomendado:

```text
COTIZAR. ORDEN #{{order_id}}
Cliente: {{customer_name}}
Dirección: {{address_text}}
Pedido:
- {{qty}} {{item_1}} ({{details_1}})
- {{qty}} {{item_2}} ({{details_2}})

Notas:
{{pending_business_message opcional}}

Responde así: ORDEN #{{order_id}} PRECIO 150
```

Reglas:

- incluir siempre `ORDEN #id`
- incluir nombre del cliente si existe
- incluir dirección
- incluir lista exacta de productos
- incluir notas solo si existen
- no inventar tienda ni productos

## Protocolo correcto del mensaje a repartidor

Formato recomendado:

```text
Hola {{repartidor_nombre}}, tienes un nuevo servicio. 📦

🧾 ORDEN #{{order_id}}
👤 Cliente: {{customer_name}}
📞 Tel cliente: {{customer_phone}}
📍 Dirección: {{address_text}}
🗺️ Mapa: {{maps_link}}
💰 Total: ${{total}}

Productos:
• {{qty}} {{item_1}} ({{details_1}})
• {{qty}} {{item_2}} ({{details_2}})

¿Aceptas el servicio? Responde SÍ para confirmar.
Para actualizar, responde:
ORDEN #{{order_id}} YA RECOGÍ
ORDEN #{{order_id}} YA LLEGUÉ
ORDEN #{{order_id}} ENTREGADO
```

## Plan técnico para Solo Ejecutivo

## Prioridad 1 — Corregir el dispatch a tienda

### Archivo

- `src/lib/mandaloFlow.ts`

### Cambio obligatorio

En la rama donde existe `esperando_confirmacion` y el cliente responde `SÍ`:

- dejar de resolver el negocio solo con `resolveBusinessWhatsappStrictByName(tiendaNombre)`
- resolverlo con prioridad:
  1. `business_id`
  2. `business_phone`
  3. `business_name`

Usar directamente:

- `resolveNegocioFromDb({ id: state.business_id, nombre: state.business_name, whatsapp: state.business_phone })`

Solo si eso falla, usar fallback por nombre.

### Motivo

El `business_id` ya es la fuente más confiable y hoy se está ignorando justo en el momento crítico.

## Prioridad 2 — Crear un helper único de resolución de negocio

### Archivo

- `src/lib/mandaloFlow.ts`

### Cambio obligatorio

Crear una sola función interna, por ejemplo:

- `resolveBusinessForDispatch(state)`

Debe:

1. leer `business_id`, `business_phone`, `business_name`
2. resolver por ese orden
3. devolver `{ id, nombre, whatsapp }`
4. loguear por qué falló si no encuentra negocio

Luego usarla en:

- confirmación cliente -> envío a tienda
- aviso a tienda cuando no hay repartidor
- cualquier mensaje a tienda desde flujo logístico

## Prioridad 3 — Dejar de mandar `{}` como `currentOrderState`

### Archivo

- `src/lib/mandaloFlow.ts`

### Cambio obligatorio

Antes de llamar a `getLLMResponse()`, resolver si hay una orden activa reciente del cliente y pasar su snapshot real como:

- `currentOrderState`

No mandar siempre `{}`.

Fuente sugerida:

- `getActiveOrderByCustomerPhone(telefono)`

o, si ya existe snapshot recuperado:

- usar `recoverLatestOrderStateWithItems(telefono)`

### Motivo

Esto reduce repeticiones y hace al agente más proactivo porque ya sabe:

- qué tienda se eligió
- qué productos hay
- qué dirección se guardó

## Prioridad 4 — Reducir preguntas redundantes

### Archivo

- `src/lib/mandaloFlow.ts`
- `src/lib/mandaloPrompt.ts`

### Cambio obligatorio

No pedir nuevamente tienda o dirección si ya existen en el snapshot actual y siguen siendo válidas.

En el prompt:

- reforzar que si `order_state` ya contiene `business_name` y `address_text`, la IA debe avanzar sobre eso y solo preguntar si hay ambigüedad crítica

En el backend:

- si el pedido activo ya está en `capturando_pedido` con dirección válida, no mandar al usuario a “continuar o nuevo” por un mensaje adicional que sí aporta contexto

## Prioridad 5 — Fortalecer logs del dispatch

### Archivo

- `src/lib/mandaloFlow.ts`
- `src/lib/waapi.ts`

### Cambio obligatorio

Antes del envío a tienda, loguear una sola línea estructurada con:

- `orderId`
- `business_id`
- `business_name`
- `business_phone`
- `to`
- `bodyPreview`

Si falla Waapi:

- loguear `status`, `statusText`, `rawText`

### Motivo

Hoy sí hay logs, pero están dispersos y todavía mezclan etiquetas viejas como “ULTRA MSG”.

## Prioridad 6 — Tolerar mejor respuestas de tienda

### Archivo

- `src/lib/ordenes.ts`
- `src/lib/mandaloFlow.ts`

### Cambio obligatorio

Mantener el formato ideal:

- `ORDEN #123 PRECIO 150`

Pero aceptar también variantes comunes:

- `#123 precio 150`
- `orden 123 total 150`
- `123 precio: 150`

Siempre que exista:

- `order_id`
- monto válido

## Prioridad 7 — Evitar que `saveChatMessage` contamine la recuperación de dirección

### Archivo

- `src/lib/messages.ts`
- `src/lib/mandaloFlow.ts`

### Cambio obligatorio

La recuperación de dirección no debe basarse simplemente en “la última fila de `pedidos`”.

Debe basarse en:

- la última orden no-chat
- o el snapshot estructurado más reciente

## Instrucción final para ejecución

Solo Ejecutivo debe corregir primero el dispatch a tienda y la inyección de `currentOrderState`, luego volver a probar este flujo completo:

1. Cliente pide producto.
2. Cliente elige tienda.
3. Cliente da dirección.
4. Bot resume.
5. Cliente responde `SÍ`.
6. Confirmar en logs:
   - negocio resuelto por `id/phone/name`
   - mensaje enviado a la tienda
7. Tienda responde precio.
8. Cliente confirma total.
9. Repartidor recibe mensaje completo con:
   - nombre cliente
   - producto exacto
   - dirección
   - total
   - ID único

## Pregunta opcional para cerrar al 100%

Si después de aplicar esta corrección sigue sin salir el pedido a tienda, lo siguiente que habría que validar contigo no es arquitectura sino datos:

- un ejemplo real de fila en `public.negocios` (`id`, `nombre`, `whatsapp`)
- y un payload real que llegue desde Whapi cuando el usuario confirma

Con eso se podría cerrar cualquier diferencia de formato residual en el mismo día.
