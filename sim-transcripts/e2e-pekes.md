# Peke's por cotización, de saludo a entrega

Veredicto: **PASA**

Cotizó, el cliente confirmó y se entregó.

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

**Cliente:** abarrotes

**Mándalo → cliente:**

🏪 *Tiendas de abarrotes:*

1. *Mini Super Peke's*

*La tienda cotiza tus productos, más $35 de envío y servicio.*

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** Peke's

**Mándalo → cliente:**

🏪 *Va, de Mini Super Peke's.*

Mándame lo que se te antoje, todo en un mensaje: marca, tamaño y cuántos.

_Solo es un ejemplo, no está en tu pedido:_

✅ 🥤 *2 Coca-Cola de 600 ml*

✅ 🧴 *1 Pinol de 1 litro*

✅ 🫓 *1 kg de tortillas*

*La tienda cotiza y se suman $35 de envío y servicio.*

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** quiero una coca

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🥤 *Coca 355ml, 1 pieza*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia la leche Lala a 2 litros" o "quita la leche"._

*La tienda cotiza tus productos, más $35 de envío y servicio.*

Acción interna: `order_agent`

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

🧾 *Pedido #17*

Ya va para *Mini Super Peke's*.

Te aviso en cuanto la tienda confirme el precio.

**Outbox `admin_notificaciones`:**

- negocio / cotizacion_tienda / 5213300000007

🏪 *Cotizar. ORDEN #17*

📍 *Entrega:*
Ubicación compartida por GPS 📍

🛒 *Pedido*

✅ 🥤 *Coca 355ml, 1 pieza*

*Responde así:*
ORDEN #17 PRECIO 150

¿Te falta algún producto?

*Responde:*
ORDEN #17 NO_DISPONIBLE nombre del producto


### Turno 7

**Cliente:** ORDEN #17 PRECIO 48

**Mándalo → tienda:**

✅ *Recibido, gracias.*

Ya le avisé al cliente el total del pedido *#17*.

**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001203

🧾 *Este es el total de tu pedido en Mini Super Peke's*

*Pedido #17*

🛒 *Tu pedido*

✅ 🥤 *Coca 355ml, 1 pieza*

*Subtotal: $48*

*Envío y servicio: $35*

💵 *Total a pagar: $83*

¿Confirmas tu pedido? Responde *SÍ*


### Turno 8

**Cliente:** sí

**Mándalo → cliente:**

✅ *Pedido #17 confirmado*

Llegará aproximadamente a las 6:52 p.m..

🛵 Estamos coordinando tu entrega.

Te aviso en cuanto un repartidor confirme.

**Outbox `admin_notificaciones`:**

- repartidor / dispatch_repartidor / 5213300000011

🛵 *Hola Roberto, tienes un nuevo pedido*

🧾 *Pedido #17*

🏪 *Mini Super Peke's*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🥤 *Coca 355ml, 1 pieza*

💵 *Cobrar: $83*

*Tel. cliente:* 5213310001203

*Responde con:*
#CONFIRMO 17

*Luego:*
#RECOGI 17

#ENTREGADO 17

- repartidor / dispatch_repartidor / 5213300000012

🛵 *Hola Mateo, tienes un nuevo pedido*

🧾 *Pedido #17*

🏪 *Mini Super Peke's*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🥤 *Coca 355ml, 1 pieza*

💵 *Cobrar: $83*

*Tel. cliente:* 5213310001203

*Responde con:*
#CONFIRMO 17

*Luego:*
#RECOGI 17

#ENTREGADO 17


### Turno 9

**Cliente:** #CONFIRMO 17

**Mándalo → repartidor:**

✅ *Aceptación registrada*

Pedido *#17*.

**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001203

✅ *Pedido #17*

¡Excelente! *Roberto* aceptó tu pedido.

En cuanto lo recoja, te aviso.

- negocio / cotizacion_tienda / 5213300000007

🛵 *Pedido #17*

Lo tomó el repartidor *Roberto*.

Acción interna: `aceptado`

### Turno 10

**Cliente:** #CONFIRMO 17

**Mándalo → repartidor:**

⚠️ Ya lo tomó otro repartidor. Este pedido ya no es tuyo.

Acción interna: `already_taken`

### Turno 11

**Cliente:** #RECOGI 17

**Mándalo → repartidor:**

✅ *Recogida registrada*

Pedido *#17*.

**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001203

🛵 *Pedido #17*

*Roberto* ya tiene tu pedido y está en camino.

Acción interna: `en_camino`

### Turno 12

**Cliente:** #ENTREGADO 17

**Mándalo → repartidor:**

✅ *Entrega registrada*

Pedido *#17*.

**Outbox `admin_notificaciones`:**

- admin / alerta_operativa / 5213399990000

Pedido entregado

Total: $83
Hora: 2026-10-17T00:32:08.277Z
Repartidor: Roberto

- cliente / notificacion_cliente / 5213310001203

✅ *Pedido #17 entregado.*

¡*Gracias por tu compra y por confiar en nosotros*!

Buen provecho.

Acción interna: `completado`
