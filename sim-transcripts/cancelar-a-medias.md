# Cancelación a media orden

Veredicto: **PASA**

Preguntó, con sí volvió al saludo y no avisó al admin.

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

**Cliente:** leche

**Mándalo → cliente:**

De leche, ¿cuál de estos?

1. Leche 19 Hnos 1lt
2. Leche 19 Hns Ligera
3. Leche 19hns 1.89ml
4. Leche 19hns 1lt
5. Leche 3ltr Bolsa 19hns

Acción interna: `order_agent`

### Turno 5

**Cliente:** cancela

**Mándalo → cliente:**

¿Quieres cancelar el pedido? Sí o No

Acción interna: `flow_confirm_cancel`

### Turno 6

**Cliente:** sí

**Mándalo → cliente:**

✅ *Listo, cancelé tu pedido.*

Cuando quieras hacer uno nuevo, aquí estoy.

👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*

Acción interna: `flow_cancel`
