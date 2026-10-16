# Comando en otro paso y nadie acepta

Veredicto: **PASA**

Comando en otro paso se explica, y si nadie acepta se avisa una vez.

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

**Cliente:** restaurantes

**Mándalo → cliente:**

🏪 *Restaurantes:*

1. *Hamburguesas Hotdogs George*

*El menú trae precio, más $35 de envío y servicio.*

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** George

**Mándalo → cliente (foto):**

🍔 *Te paso el menú de Hamburguesas Hotdogs George*

Pídeme lo que se te antoje, como sale en la foto.

*Envío y servicio: $35*, aparte.

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** 3 dogos

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🌭 *Dogo Clásico, 3 piezas — $105*

*Envío y servicio: $35*

*Total: $140*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._

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

✅ *Pedido #22 confirmado*

Llegará aproximadamente a las 5:26 p.m..

🛵 Estamos coordinando tu entrega.

Te aviso en cuanto un repartidor confirme.

**Outbox `admin_notificaciones`:**

- negocio / cotizacion_tienda / 5213300000005

🏪 *Nuevo pedido #22*

Ya trae precio del menú. Prepáralo en cuanto puedas.

📍 *Entrega:*
Ubicación compartida por GPS 📍

🛒 *Pedido*

✅ 🌭 *3 Dogo Clásico, 3 pzs — $105*

- repartidor / dispatch_repartidor / 5213300000011

🛵 *Hola Roberto, tienes un nuevo pedido*

🧾 *Pedido #22*

🏪 *Hamburguesas Hotdogs George*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🌭 *Dogo Clásico, 3 pzs*

💵 *Cobrar: $140*

*Tel. cliente:* 5213310001107

*Responde con:*
#CONFIRMO 22

*Luego:*
#RECOGI 22

#ENTREGADO 22

- repartidor / dispatch_repartidor / 5213300000012

🛵 *Hola Mateo, tienes un nuevo pedido*

🧾 *Pedido #22*

🏪 *Hamburguesas Hotdogs George*

📍 *Recoger en:*
Ixtlahuacán del Río

📍 *Entregar en:*
Ubicación compartida por GPS 📍
https://www.google.com/maps?q=20.865831,-103.240017

🛒 *Productos:*

✅ 🌭 *Dogo Clásico, 3 pzs*

💵 *Cobrar: $140*

*Tel. cliente:* 5213310001107

*Responde con:*
#CONFIRMO 22

*Luego:*
#RECOGI 22

#ENTREGADO 22


### Turno 7

**Cliente:** #RECOGI 22

**Mándalo → repartidor:**

⚠️ El pedido 22 no está en el paso de *#RECOGI*.

Estado actual: *dispatch_repartidor_pendiente*.

🛵 *Así se registra el paso.*

Mayúsculas, con # y el número del pedido:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123

Acción interna: `stale_state`

### Turno 8

**Cliente:** #ENTREGADO 22

**Mándalo → repartidor:**

⚠️ El pedido 22 no está en el paso de *#ENTREGADO*.

Estado actual: *dispatch_repartidor_pendiente*.

🛵 *Así se registra el paso.*

Mayúsculas, con # y el número del pedido:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123

Acción interna: `stale_state`

### Turno 9

**Cliente:** (timeout de repartidor)

**Mándalo:** (sin WhatsApp saliente)
**Outbox `admin_notificaciones`:**

- cliente / notificacion_cliente / 5213310001107

🛵 *Pedido #22*

Por ahora no tenemos repartidores disponibles, así que lo cancelamos.

En cuanto haya uno libre, puedes volver a pedir.

👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*

- negocio / cotizacion_tienda / 5213300000005

🏪 *Pedido #22*

Se canceló: no hubo repartidor disponible a tiempo. Ya no es necesario prepararlo.

- repartidor / dispatch_repartidor / 5213300000011

🛵 *Pedido #22*

Se canceló. Ya no hace falta que lo recojas.

- repartidor / dispatch_repartidor / 5213300000012

🛵 *Pedido #22*

Se canceló. Ya no hace falta que lo recojas.

- admin / alerta_operativa / 5213399990000

Timeout de repartidor.

Pedido: 22
Ningún repartidor confirmó en 10 min. Pedido cancelado.

