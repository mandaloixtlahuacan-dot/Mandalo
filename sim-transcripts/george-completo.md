# Pedido George hasta ubicación y confirmación

Veredicto: **FALLA**

Pidió el pin, pero al recibirlo lo rechazó (location_early): la fase guardada sigue en pedido, así que el GPS no cuenta todavía.

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

**Cliente:** un dogo clásico

**Mándalo → cliente:**

De un dogo clasico, ¿cuál de estos?

1. Dogo Clásico
2. Dogo Arrachera
3. Dogo Cubano
4. Dogo de Camarón
5. Dogo de Pollo

Acción interna: `catalogo_fijo`

### Turno 5

**Cliente:** sí

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🌭 *Dogo Clásico, 1 pieza — $35*

*Envío y servicio: $35*

*Total: $70*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._

Acción interna: `catalogo_fijo`

### Turno 6

**Cliente:** sí

**Mándalo → cliente:**

📍 *¿Me compartes tu ubicación por GPS?*

Es lo más fácil y rápido.

Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara (ej. "frente a la tortillería", "casa azul").

Acción interna: `productos_confirmados`

### Turno 7

**Cliente:** [pin GPS]
**Ubicación:** 20.865831, -103.240017

**Mándalo → cliente:**

La ubicación la anoto para la entrega, cuando ya esté armado el pedido. Ahí vale el pin o la dirección escrita.

🍔 *Te paso el menú de Hamburguesas Hotdogs George*

Pídeme lo que se te antoje, como sale en la foto.

*Envío y servicio: $35*, aparte.

Acción interna: `flow_location_early`
