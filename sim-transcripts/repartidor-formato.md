# Comandos de repartidor mal formados

Veredicto: **PASA**

Minúsculas, sin # y sin número reciben la ayuda con el formato.

Simulación en memoria. `ORDER_AGENT=on` solo en este proceso. El modelo es un `AgentModel` mock inyectado en `createOpenAIOrderAgentModel` (lo usa `runOrderAgentTurn`). No hubo llamada de red a OpenAI, Whapi ni Supabase.

Precios del fixture de Peke's: 1278 de 1278 filas con precio null; 0 traen precio. George 56 filas, La Central 19.

## Transcripción

### Turno 1

**Cliente:** confirmo 12

**Mándalo → repartidor:**

🛵 No entendí «confirmo 12».

🛵 *Así se registra el paso.*

Mayúsculas, con # y el número del pedido:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123

Acción interna: `invalid`

### Turno 2

**Cliente:** #CONFIRMO

**Mándalo → repartidor:**

🛵 No entendí «#CONFIRMO».

🛵 *Así se registra el paso.*

Mayúsculas, con # y el número del pedido:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123

Acción interna: `invalid`

### Turno 3

**Cliente:** #CONFIRMO 99999

**Mándalo → repartidor:**

⚠️ No encontré el pedido 99999. Verifica el ID e intenta de nuevo.

Acción interna: `invalid`

### Turno 4

**Cliente:** #RECOGI

**Mándalo → repartidor:**

🛵 No entendí «#RECOGI».

🛵 *Así se registra el paso.*

Mayúsculas, con # y el número del pedido:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123

Acción interna: `invalid`
