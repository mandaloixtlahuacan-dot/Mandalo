# Queja: está mal mi pedido

Veredicto: **PASA**

Ofreció ayuda y opciones, sin avisar al admin.

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

**Cliente:** está mal mi pedido

**Mándalo → cliente:**

Cuéntame qué pasó y lo vemos.

Puedo corregir el pedido, cancelarlo o armar uno nuevo. Dime cuál.

Si vas a pedir, elige: *Abarrotes*, *Restaurantes* o *Carnicerías*.

Acción interna: `queja_atendida`
