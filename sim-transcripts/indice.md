# Simulador de cliente

Peke's: 1278/1278 precios null.

| Escenario | Resultado |
| --- | --- |
| coca-pekes | FALLA. no muestra precio. En el fixture, 1278 de 1278 filas de Peke's traen precio null (0 con precio) |
| dogos-george | PASA. Anotó 3 dogos y mostró la lista para confirmar. |
| nito-caja | PASA. Eligió la caja de Nito y la dejó en la lista. |
| nito-pieza | PASA. Preguntó presentación (pieza, Duo o caja) y no cerró solo. |
| leche-pekes | PASA. Mostró leches reales y dejó elegir. |
| kilo-central | PASA. Anotó diezmillo por kilo, con el precio del menú si ya se puede mostrar. |
| george-completo | FALLA. Pidió el pin, pero al recibirlo lo rechazó (location_early): la fase guardada sigue en pedido, así que el GPS no cuenta todavía. |
| sin-sentido | PASA. Contestó sin armar un pedido inventado. |
| recomendacion | PASA. Contestó sin inventar un pedido. |
| cancelar-a-medias | PASA. Preguntó, con sí volvió al saludo y no avisó al admin. |
| queja-pedido | PASA. Ofreció ayuda y opciones, sin avisar al admin. |
| hablar-con-alguien | PASA. Ofreció ayuda y opciones, sin avisar al admin. |
| cancelar-antes-despacho | PASA. Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-tienda | PASA. Pedido sembrado en pendiente_tiendas (no es un despacho en vivo). Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-repartidor | PASA. Pedido sembrado en repartidor_asignado (no es un despacho en vivo). Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-no | PASA. Con no siguió el pedido y no avisó al admin. |
