# Un kilo en Carnicería La Central

Veredicto: **PASA**

Anotó diezmillo por kilo, con el precio del menú si ya se puede mostrar.

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

*El menú trae precio.*

🛵 *Envío: $15*
servicio $10

*¿De cuál te hago el mandado?*

Acción interna: `flow_show_niche`

### Turno 3

**Cliente:** La Central

**Mándalo → cliente (foto):**

🥩 *Te paso el menú de Carnicería La Central*

Pídeme lo que se te antoje, como sale en la foto.

Te armo el mandado producto por producto. Si quieres, también puedes mandarme varios juntos.

*Cómo pedir:* el corte y los kilos, o cuántos pesos.
_Ejemplo: "1 kg de chorizo"_

*Cómo agregar:* "agrega 1 kilo de carne"

*Cómo quitar:* "quita el pastor"

*Cómo corregir:* "cambia el carbón a 2 bolsas"

🛵 *Envío: $15*
servicio $10

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** un kilo de diezmillo

**Mándalo → cliente:**

OK, pediste:

🛒 *Tu pedido*

✅ 🥩 *Diezmillo, 1 kilo — $215*

🛵 *Envío: $15*
servicio $10

*Total: $240*

*¿Están bien estos productos?*

*Si tu pedido está bien, responde sí.*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia el carbón a 2 bolsas" o "quita el pastor"._

Acción interna: `catalogo_fijo`
