# 3 dogos en George

Veredicto: **PASA**

Anotó 3 dogos y mostró la lista para confirmar.

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

*El menú trae precio.*

🛵 *Envío: $15*
servicio $10

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** George

**Mándalo → cliente (foto):**

🍔 *Te paso el menú de Hamburguesas Hotdogs George*

Pídeme lo que se te antoje, como sale en la foto.

Te armo el mandado producto por producto. Si quieres, también puedes mandarme varios juntos.

*Cómo pedir:* el nombre del menú y cuántos.
_Ejemplo: "2 hamburguesas sencillas"_

*Cómo agregar:* "agrega 1 refresco"

*Cómo quitar:* "quita las papas"

*Cómo corregir:* "cambia la hamburguesa a grande"

🛵 *Envío: $15*
servicio $10

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** 3 dogos

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🌭 *Dogo Clásico, 3 piezas — $105*

🛵 *Envío: $15*
servicio $10

*Total: $130*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._

Acción interna: `catalogo_fijo`
