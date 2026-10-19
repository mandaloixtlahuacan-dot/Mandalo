# Cancelación antes de despacho

Veredicto: **PASA**

Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones.

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

**Cliente:** leche

**Mándalo → cliente:**

❓ *De leche, ¿cuál de estos?*

1. *Leche 19 Hnos 1lt*
2. *Leche La Granja Bolsa 1lt*
3. *Leche Lala Deslactosada 1lt*

_La tienda confirma el precio. Todavía no es un total cerrado._

_Si es otro tamaño o sabor, escríbelo._

_Responde con el número. Si no es, corrige el producto o escribe cancelar._

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
