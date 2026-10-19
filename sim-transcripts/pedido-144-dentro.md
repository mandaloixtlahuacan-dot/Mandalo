# Pedido 144: sí fuera de horario y pin dentro de la cabecera

Veredicto: **PASA**

El sí pidió ubicación y el pin de la cabecera se aceptó.

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

1. *Hamburguesas Hotdogs George* (cerrada, abre hoy a las 7pm)

*El menú trae precio.*

🛵 *Envío: $15*
servicio $10

Si está cerrada, se puede programar: la armamos y se manda cuando abra.

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** George

**Mándalo → cliente (foto):**

⏰ *Hamburguesas Hotdogs George está cerrada ahora* (abre hoy a las 7pm). Horario: 7pm a 12am.

Si quieres, lo armamos y se programa para cuando abra.

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

**Cliente:** 3 dogos de pollo, 2 dogos clásicos, 1 Pepsi y una manzanita

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🌭 *Dogo de Pollo, 3 piezas — $135*

✅ 🌭 *Dogo Clásico, 2 piezas — $70*

✅ 🥤 *Refresco Pepsi, 1 pieza — $20*

✅ 🥤 *Refresco Manzana, 1 pieza — $20*

🛵 *Envío: $15*
servicio $10

*Total: $270*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._

Acción interna: `catalogo_fijo`

### Turno 5

**Cliente:** Si

**Mándalo → cliente:**

⏰ *Hamburguesas Hotdogs George* está cerrada ahora, abre hoy a las 7pm. Tu pedido se programa y te lo mando en cuanto se pueda.

📍 *¿Me compartes tu ubicación por GPS?*

Es lo más fácil y rápido.

Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara (ej. "frente a la tortillería", "casa azul").

Acción interna: `productos_confirmados`

### Turno 6

**Cliente:** [pin GPS]
**Ubicación:** 20.865831, -103.240017

**Mándalo → cliente:**

⏰ *Pedido #13 programado.*

*Hamburguesas Hotdogs George* está cerrada ahora, abre hoy a las 7pm.

Te aviso apenas se mande.

