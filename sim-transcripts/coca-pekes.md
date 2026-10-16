# Quiero una coca en Peke's

Veredicto: **PASA**

Opciones reales de Coca, sin monto ni total. 1278 de 1278 filas de Peke's traen precio null.

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

Mándame cada producto por separado, con marca, tamaño y cuántos.

_Solo es un ejemplo, no está en tu pedido:_

✅ 🥤 *2 Coca-Cola de 600 ml*

✅ 🧴 *1 Pinol de 1 litro*

✅ 🫓 *1 kg de tortillas*

*La tienda cotiza y se suman $35 de envío y servicio.*

Acción interna: `flow_switch_store`

### Turno 4

**Cliente:** quiero una coca

**Mándalo → cliente:**

De coca, ¿cuál de estos?

1. Coca 355ml
2. Coca Cola 1 Litro Vidrio
3. Coca Cola 1 Lt Vidrio
4. Coca Cola 1.250ml
5. Coca Cola 1.750ml

La tienda confirma el precio. Todavía no es un total cerrado.

Acción interna: `order_agent`
