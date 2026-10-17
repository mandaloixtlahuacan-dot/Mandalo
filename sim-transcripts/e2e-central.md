# La Central de saludo a entrega, dentro de horario

Veredicto: **PASA**

Llegó a entregado, con un solo aviso por paso.

Simulación en memoria. `ORDER_AGENT=on` solo en este proceso. El modelo es un `AgentModel` mock inyectado en `createOpenAIOrderAgentModel` (lo usa `runOrderAgentTurn`). No hubo llamada de red a OpenAI, Whapi ni Supabase.

Precios del fixture de Peke's: 1278 de 1278 filas con precio null; 0 traen precio. George 56 filas, La Central 19.

## Transcripción

### Turno 1

**Cliente:** hola

**Mándalo → cliente:**

👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*

Acción interna: `flow_greeting`

### Turno 2

**Cliente:** carnicerías

**Mándalo → cliente:**

🏪 *Carnicerías:*

1. *Carnicería La Central*

*El menú trae precio, más $35 de envío y servicio.*

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** La Central

**Mándalo → cliente (foto):**

🥩 *Te paso el menú de Carnicería La Central*

Pídeme lo que se te antoje, como sale en la foto.

*Envío y servicio: $35*, aparte.

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** un kilo de diezmillo

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🥩 *Diezmillo, 1 kilo — $215*

*Envío y servicio: $35*

*Total: $250*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia el carbón a 2 bolsas" o "quita el pastor"._

Acción interna: `catalogo_fijo`

### Turno 5

**Cliente:** sí

**Mándalo → cliente:**

📍 *¿Me compartes tu ubicación por GPS?*

Es lo más fácil y rápido.

Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara (ej. "frente a la tortillería", "casa azul").

Acción interna: `productos_confirmados`

### Turno 6

**Cliente:** [pin GPS]
**Ubicación:** 20.865831, -103.240017

**Mándalo → cliente:**

✅ *Pedido #16 confirmado*

Llegará aproximadamente a las 6:52 p.m..

🛵 Estamos coordinando tu entrega.

Te aviso en cuanto un repartidor confirme.

**Outbox `admin_notificaciones`:**

- negocio / cotizacion_tienda / 5213300000006

🏪 *Nuevo pedido #16*

Ya trae precio del menú. Prepáralo en cuanto puedas.

📍 *Entrega:*
Ubicación compartida por GPS 📍

🛒 *Pedido*

✅ 🥩 *1 Diezmillo, 1 kilo — $215*

- repartidor / dispatch_repartidor / 5213300000011

🛵 *Hola Roberto, tienes un nuevo pedido*

🧾 *Pedido #16*

🏪 *Carnicería La Central*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🥩 *Diezmillo, 1 kilo*

💵 *Cobrar: $250*

*Tel. cliente:* 5213310001202

*Responde con:*
#CONFIRMO 16

*Luego:*
#RECOGI 16

#ENTREGADO 16

- repartidor / dispatch_repartidor / 5213300000012

🛵 *Hola Mateo, tienes un nuevo pedido*

🧾 *Pedido #16*

🏪 *Carnicería La Central*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🥩 *Diezmillo, 1 kilo*

💵 *Cobrar: $250*

*Tel. cliente:* 5213310001202

*Responde con:*
#CONFIRMO 16

*Luego:*
#RECOGI 16

#ENTREGADO 16


### Turno 7

**Cliente:** #CONFIRMO 16

**Mándalo → repartidor:**

✅ *Aceptación registrada*

Pedido *#16*.

**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001202

✅ *Pedido #16*

¡Excelente! *Roberto* aceptó tu pedido.

En cuanto lo recoja, te aviso.

- negocio / cotizacion_tienda / 5213300000006

🛵 *Pedido #16*

Lo tomó el repartidor *Roberto*.

Acción interna: `aceptado`

### Turno 8

**Cliente:** #CONFIRMO 16

**Mándalo → repartidor:**

⚠️ Ya lo tomó otro repartidor. Este pedido ya no es tuyo.

Acción interna: `already_taken`

### Turno 9

**Cliente:** #RECOGI 16

**Mándalo → repartidor:**

✅ *Recogida registrada*

Pedido *#16*.

**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001202

🛵 *Pedido #16*

*Roberto* ya tiene tu pedido y está en camino.

Acción interna: `en_camino`

### Turno 10

**Cliente:** #ENTREGADO 16

**Mándalo → repartidor:**

✅ *Entrega registrada*

Pedido *#16*.

**Outbox `admin_notificaciones`:**

- admin / alerta_operativa / 5213399990000

Pedido entregado

Total: $250
Hora: 2026-10-17T00:32:07.761Z
Repartidor: Roberto

- cliente / notificacion_cliente / 5213310001202

✅ *Pedido #16 entregado.*

¡*Gracias por tu compra y por confiar en nosotros*!

Buen provecho.

Acción interna: `completado`
