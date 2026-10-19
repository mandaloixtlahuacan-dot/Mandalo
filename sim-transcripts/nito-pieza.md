# Un Nito en Peke's

Veredicto: **PASA**

Anotó Nito 62g, la pieza estándar, y cerró la lista.

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

*La tienda cotiza tus productos.*

🛵 *Envío: $15*
servicio $10

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** Peke's

**Mándalo → cliente:**

🏪 *Va, de Mini Super Peke's.*

Te armo el mandado producto por producto. Si quieres, también puedes mandarme varios juntos.

*Cómo pedir:* marca, tamaño y cuántos.
_Ejemplo: "2 Coca-Cola de 600 ml"_

*Cómo agregar:* "agrega 1 Pinol de 1 litro"

*Cómo quitar:* "quita la leche"

*Cómo corregir:* "cambia la leche Lala a 2 litros"

_Solo es un ejemplo, no está en tu pedido:_

✅ 🥤 *2 Coca-Cola de 600 ml*

✅ 🧴 *1 Pinol de 1 litro*

✅ 🫓 *1 kg de tortillas*

*La tienda cotiza tus productos.*

🛵 *Envío: $15*
servicio $10

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** un Nito

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🛍️ *Nito 62g, 1 pieza*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia la leche Lala a 2 litros" o "quita la leche"._

*La tienda cotiza tus productos.*

🛵 *Envío: $15*
servicio $10

Acción interna: `order_agent`
