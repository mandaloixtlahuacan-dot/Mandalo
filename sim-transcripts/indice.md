# Simulador de cliente

Peke's: 1278/1278 precios null.

| Escenario | Resultado |
| --- | --- |
| coca-pekes | PASA. Opciones reales de Coca, sin monto ni total. 1278 de 1278 filas de Peke's traen precio null. |
| dogos-george | PASA. Anotó 3 dogos y mostró la lista para confirmar. |
| nito-caja | PASA. Eligió la caja de Nito y la dejó en la lista. |
| nito-pieza | PASA. Preguntó presentación (pieza, Duo o caja) y no cerró solo. |
| leche-pekes | PASA. Mostró leches reales y dejó elegir. |
| kilo-central | PASA. Anotó diezmillo por kilo, con el precio del menú si ya se puede mostrar. |
| george-completo | PASA. Pidió la ubicación y, con el pin dentro de Ixtlahuacán, siguió la confirmación. |
| sin-sentido | PASA. Contestó sin armar un pedido inventado. |
| recomendacion | PASA. Contestó sin inventar un pedido. |
| cancelar-a-medias | PASA. Preguntó, con sí volvió al saludo y no avisó al admin. |
| queja-pedido | PASA. Ofreció ayuda y opciones, sin avisar al admin. |
| hablar-con-alguien | PASA. Ofreció ayuda y opciones, sin avisar al admin. |
| cancelar-antes-despacho | PASA. Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-tienda | PASA. Pedido sembrado en pendiente_tiendas (no es un despacho en vivo). Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-repartidor | PASA. Pedido sembrado en repartidor_asignado (no es un despacho en vivo). Preguntó, canceló con sí, avisó solo a quien ya tenía el pedido y no escribió admin_notificaciones. |
| cancelar-no | PASA. Con no siguió el pedido y no avisó al admin. |
| pedido-144-dentro | PASA. El sí pidió ubicación y el pin de la cabecera se aceptó. |
| pedido-144-fuera | PASA. Pin de afuera, se quedó en ubicación y cancelar preguntó sí o no. |
| e2e-george | PASA. Llegó a entregado, con un solo aviso por paso. |
| e2e-central | PASA. Llegó a entregado, con un solo aviso por paso. |
| e2e-pekes | PASA. Cotizó, el cliente confirmó y se entregó. |
| repartidor-formato | PASA. Minúsculas, sin # y sin número reciben la ayuda con el formato. |
| pedido-144-parse | PASA. 0,0 con grados, e7 y el link se aceptan; un pin vacío no dice fuera de zona. |
| repartidor-nadie | PASA. Comando en otro paso se explica, y si nadie acepta se avisa una vez. |
