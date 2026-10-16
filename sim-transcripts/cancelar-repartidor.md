# Cancelación con repartidor asignado

Veredicto: **PASA**

Pedido sembrado en repartidor_asignado (no es un despacho en vivo). Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones.

Simulación en memoria. `ORDER_AGENT=on` solo en este proceso. El modelo es un `AgentModel` mock inyectado en `createOpenAIOrderAgentModel` (lo usa `runOrderAgentTurn`). No hubo llamada de red a OpenAI, Whapi ni Supabase.

Precios del fixture de Peke's: 1278 de 1278 filas con precio null; 0 traen precio. George 56 filas, La Central 19.

## Transcripción

### Turno 1

**Cliente:** cancela

**Mándalo → cliente:**

¿Quieres cancelar el pedido? Sí o No

Acción interna: `flow_confirm_cancel`

### Turno 2

**Cliente:** sí

**Mándalo → tienda:**

🏪 *Pedido #11*

Este pedido se canceló. Ya no hace falta que le des seguimiento.

**Mándalo → repartidor:**

🛵 *Pedido #11*

Este pedido se canceló. Ya no hace falta entregarlo.

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
