# Mensajes de WhatsApp — vista previa

Solo presentación. El pedido, los precios y el cargo de **$25 de envío y servicio** no cambian.

Cómo se lee: un asterisco abre y cierra la negrita de WhatsApp (`*así*`). Cada producto va en su línea, con una línea en blanco antes del siguiente. La palomita marca lo confirmado y el emoji dice qué es. En el ticket, cada renglón trae cantidad, producto y precio. Los comandos de tienda y repartidor (`ORDEN #…`, `#CONFIRMO`, `#RECOGI`, `#ENTREGADO`) van sin negrita, para copiarlos igual.

El mismo texto, sin formato de esta página, está en `docs/mensajes-muestra.txt`.

```text
================================================================
ABARROTES — saludo
================================================================

👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*


================================================================
ABARROTES — lista de tiendas
================================================================

🏪 *Tiendas de abarrotes:*

1. *ZAGU*

2. *Abarrotes Agua Santa* (cerrada, abre mañana a las 8am)

*La tienda cotiza tus productos, más $25 de envío y servicio.*

*¿De cuál te hago el mandado?*


================================================================
ABARROTES — pedido, con ejemplo
================================================================

🏪 *Va, de ZAGU.*

Mándame cada producto por separado, con marca, tamaño y cuántos.

*Ejemplo:*

✅ 🥤 *2 Coca-Cola de 600 ml*

✅ 🧴 *1 Pinol de 1 litro*

✅ 🫓 *1 kg de tortillas*

*La tienda cotiza y se suman $25 de envío y servicio.*


================================================================
ABARROTES — tienda cerrada, se programa
================================================================

🏪 *Va, de Abarrotes Agua Santa.*

Mándame cada producto por separado, con marca, tamaño y cuántos.

*Ejemplo:*

✅ 🥤 *2 Coca-Cola de 600 ml*

✅ 🧴 *1 Pinol de 1 litro*

✅ 🫓 *1 kg de tortillas*

⏰ Ojo: está cerrada ahora (abre mañana a las 8am).

Lo armamos igual y se manda en cuanto abra.

*La tienda cotiza y se suman $25 de envío y servicio.*


================================================================
ABARROTES — falta marca o tamaño
================================================================

🥛 *Va. La leche, ¿de qué marca, de cuál (entera, deslactosada o light) y de cuántos litros?*

Por ejemplo Lala, Alpura o Santa Clara.

Con eso ya la anoto y seguimos el mandado.


================================================================
ABARROTES — OK, pediste
================================================================

OK, pediste:

🛒 *Tu pedido*

✅ 🥤 *Coca-Cola, 2 litros, 2 piezas*

✅ 🍜 *Sopa, Maruchan, habanero, 1 pieza*

✅ 🧴 *Pinol, 1 litro, 1 pieza*

✅ 🫓 *Tortillas, de maíz, 1 kilo*

*¿Están bien estos productos?*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia la leche Lala a 2 litros" o "quita la leche"._


================================================================
ABARROTES — corrección que no movió la lista
================================================================

No pude cambiar tu lista. Escríbeme cuál producto está mal y qué cambio quieres.

_Solo es un ejemplo, no está en tu pedido:_
_"quita la leche"_
_"cambia la leche Lala a 2 litros"_
_"agrega 1 leche Lala de 1 litro"_

Cada producto va aparte, con marca, tamaño y cuántos.

Si la lista ya está bien, responde *sí*.


================================================================
ABARROTES — segunda corrección, ya dice reiniciar
================================================================

No pude cambiar tu lista. Escríbeme cuál producto está mal y qué cambio quieres.

_Solo es un ejemplo, no está en tu pedido:_
_"quita la leche"_
_"cambia la leche Lala a 2 litros"_
_"agrega 1 leche Lala de 1 litro"_

Cada producto va aparte, con marca, tamaño y cuántos.

Si la lista ya está bien, responde *sí*.

Si seguimos atorados, escribe *reiniciar* o *cancelar* y armamos el pedido de nuevo.


================================================================
ABARROTES — ubicación
================================================================

📍 *¿Me compartes tu ubicación por GPS?*

Es lo más fácil y rápido.

Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara (ej. "frente a la tortillería", "casa azul").


================================================================
ABARROTES — resumen antes del SÍ final
================================================================

🧾 *Este es tu pedido:*

🏪 *Tienda: ZAGU*

🛒 *Tu pedido*

✅ 🥤 *Coca-Cola, 2 litros, 2 piezas*

✅ 🍜 *Sopa, Maruchan, habanero, 1 pieza*

✅ 🧴 *Pinol, 1 litro, 1 pieza*

✅ 🫓 *Tortillas, de maíz, 1 kilo*

*La tienda cotiza tus productos, más $25 de envío y servicio.*

📍 *Entrega:*
Calle Hidalgo 12, frente a la tortillería

Si todo está correcto, responde: *SÍ*


================================================================
ABARROTES — pedido registrado
================================================================

🧾 *Pedido #102*

Ya va para *ZAGU*.

Te aviso en cuanto la tienda confirme el precio.


================================================================
ABARROTES — ticket cuando la tienda ya cotizó
================================================================

🧾 *Este es el total de tu pedido en ZAGU*

*Pedido #102*

🛒 *Tu pedido*

✅ 🥤 *2 Coca-Cola de 2 litros — $36*

✅ 🍜 *1 sopa Maruchan de habanero — $15*

✅ 🧴 *1 Pinol de 1 litro — $28*

✅ 🫓 *1 kg de tortillas — $18*

*Subtotal: $97*

*Envío y servicio: $25*

💵 *Total a pagar: $122*

¿Confirmas tu pedido? Responde *SÍ*


================================================================
ABARROTES — se mandó al abrir
================================================================

🧾 *Pedido #102*

Ya se envió a *ZAGU*.

Te aviso en cuanto confirme el precio.


================================================================
ABARROTES — no abrió en 48 horas
================================================================

⏰ *Pedido #102*

Se canceló: *ZAGU* no abrió a tiempo.

Cuando quieras, puedes hacer un nuevo pedido.


================================================================
ABARROTES — fuera de cobertura
================================================================

📍 *Por ahora Mándalo solo cubre entregas dentro de Ixtlahuacán del Río.*

Tu ubicación quedó fuera de esa zona.

En cuanto ampliemos la cobertura te avisamos. ¡Gracias por tu interés!


================================================================
ABARROTES — producto que la tienda no tiene
================================================================

🏪 *ZAGU* no tiene disponible:

*"Pinol 1 litro"*

¿Quieres continuar tu pedido sin este producto, o prefieres cambiarlo por otro?

Responde *"sin él"* para quitarlo, o dime el producto por el que lo cambias.


================================================================
ABARROTES — cancelar
================================================================

✅ *Listo, cancelé tu pedido.*

Cuando quieras hacer uno nuevo, aquí estoy.


================================================================
ABARROTES — reiniciar
================================================================

✅ *Pedido anterior cancelado.*

👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*


================================================================
ESTADO — aceptado, en camino, entregado
================================================================

🛵 *Pedido #102*

*Luis* ya tiene tu pedido y está en camino.

---

🛵 *Tu pedido ya va con el repartidor*, en camino a recogerlo.

---

🛵 *El repartidor ya recogió tu pedido* y va en camino.

---

✅ *Pedido #102 entregado.*

¡*Gracias por tu compra y por confiar en nosotros*!

Buen provecho.


================================================================
ERRORES Y TIEMPOS
================================================================

🧾 *Pedido #102*

Se canceló porque la tienda no respondió a tiempo.

¿Quieres pedir de otro negocio?

---

⏰ *Pedido #102*

Está por vencer.

Responde *SÍ* en los próximos *5 minutos* para confirmarlo, o se cancelará.

---

🛵 *Pedido #102*

Por ahora no tenemos repartidores disponibles, así que lo cancelamos.

En cuanto haya uno libre, puedes volver a pedir.

---

🧾 *Pedido #102*

Ya está en proceso avanzado, así que no puedo cancelarlo yo solo.

Ya avisé a nuestro equipo. Te van a contactar directo.


================================================================
GEORGE — lista de restaurantes
================================================================

🏪 *Restaurantes:*

1. *Hamburguesas Hotdogs George*

*El menú trae precio, más $25 de envío y servicio.*

*¿De cuál te hago el mandado?*


================================================================
GEORGE — categorías
================================================================

🏪 *Va, de Hamburguesas Hotdogs George.*

Te armo el mandado.

*¿Cuál categoría te late?*

1. *Hamburguesas*

2. *Hot dogs*

3. *Papas*

4. *Bebidas*

*Envío y servicio: $25*, aparte del menú.


================================================================
GEORGE — menú
================================================================

🍔 *Te paso el menú de Hamburguesas Hotdogs George*

Pídeme lo que se te antoje, como sale en la foto.

*Envío y servicio: $25*, aparte.


================================================================
GEORGE — lo que anotó
================================================================

🛒 *Anoto:*

✅ 🍔 *Hamburguesa de Res Chica — 1 pieza*

✅ 🌭 *Dogo clásico — 1 pieza*

✅ 🍟 *Papas Gajo 315g — 1 pieza*


================================================================
GEORGE — OK, pediste
================================================================

OK, pediste:

🛒 *Tu pedido*

✅ 🍔 *Hamburguesa de Res Chica, x1*

✅ 🌭 *Dogo clásico, x1*

✅ 🍟 *Papas Gajo 315g, x1*

*¿Están bien estos productos?*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._


================================================================
GEORGE — corrección que no movió la lista
================================================================

No pude cambiar tu lista. Escríbeme cuál producto está mal y qué cambio quieres.

_Solo es un ejemplo, no está en tu pedido:_
_"quita las papas"_
_"cambia la hamburguesa a grande"_
_"agrega 1 refresco"_

Pídelo con el nombre del menú y cuántos.

Si la lista ya está bien, responde *sí*.


================================================================
GEORGE — ticket
================================================================

🧾 *Pedido #85*

🏪 *Tienda: Hamburguesas Hotdogs George*

🛒 *Tu pedido*

✅ 🍔 *1 Hamburguesa de Res Chica — $75*

✅ 🌭 *1 Dogo clásico — $40*

✅ 🍟 *1 Papas Gajo 315g — $45*

*Envío y servicio: $25*

*Total: $185*

📍 *Entrega:*
Calle Hidalgo 12, frente a la tortillería

¿Es correcto? Responde *SÍ* para confirmar.


================================================================
GEORGE — pedido registrado
================================================================

🧾 *Pedido #85*

Ya quedó con *Hamburguesas Hotdogs George*.

Te mando el total para que lo confirmes con un SÍ.


================================================================
GEORGE — fuera del menú
================================================================

🛒 *Anoto:*

✅ 🍔 *Hamburguesa de Res Chica — 1 pieza*

🛍️ *Sushi* no lo manejamos.


================================================================
LA CENTRAL — lista
================================================================

🏪 *Carnicerías:*

1. *Carnicería La Central* (cerrada, abre mañana a las 8am)

*El menú trae precio, más $25 de envío y servicio.*

*¿De cuál te hago el mandado?*


================================================================
LA CENTRAL — menú, cerrada
================================================================

🥩 *Te paso el menú de Carnicería La Central*

Pídeme lo que se te antoje, como sale en la foto.

⏰ Ojo: está cerrada ahora (abre mañana a las 8am).

Lo armamos y se manda en cuanto abra.

*Envío y servicio: $25*, aparte.


================================================================
LA CENTRAL — lo que anotó
================================================================

🛒 *Anoto:*

✅ 🥩 *Chorizo — 1 kilo*

✅ 🥩 *Arrachera Marinada — 0.5 kilos*


================================================================
LA CENTRAL — OK, pediste
================================================================

OK, pediste:

🛒 *Tu pedido*

✅ 🥩 *Chorizo, 1 kilo*

✅ 🥩 *Arrachera Marinada, 0.5 kilos*

*¿Están bien estos productos?*

_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._

_Solo es un ejemplo, no está en tu pedido: "cambia el carbón a 2 bolsas" o "quita el pastor"._


================================================================
LA CENTRAL — corrección que no movió la lista
================================================================

No pude cambiar tu lista. Escríbeme cuál producto está mal y qué cambio quieres.

_Solo es un ejemplo, no está en tu pedido:_
_"quita el pastor"_
_"cambia el carbón a 2 bolsas"_
_"agrega 1 kilo de carne"_

Pídelo con el corte y los kilos (o cuántos pesos).

Si la lista ya está bien, responde *sí*.


================================================================
LA CENTRAL — ticket
================================================================

🧾 *Pedido #90*

🏪 *Tienda: Carnicería La Central*

🛒 *Tu pedido*

✅ 🥩 *1 kg Chorizo — $115*

✅ 🥩 *0.5 kg Arrachera Marinada — $140*

*Envío y servicio: $25*

*Total: $280*

📍 *Entrega:*
Calle Hidalgo 12, frente a la tortillería

¿Es correcto? Responde *SÍ* para confirmar.


================================================================
TIENDA — cotizar
================================================================

🏪 *Cotizar. ORDEN #102*

📍 *Entrega:*
Calle Hidalgo 12, frente a la tortillería

🛒 *Pedido*

✅ 🥤 *Coca-Cola 2 litros x2*

✅ 🍜 *Sopa Maruchan habanero x1*

✅ 🧴 *Pinol 1 litro x1*

✅ 🫓 *Tortillas x1*

*Responde así:*
ORDEN #102 PRECIO 150

¿Te falta algún producto?

*Responde:*
ORDEN #102 NO_DISPONIBLE nombre del producto


================================================================
TIENDA — recordatorio
================================================================

⏰ *Recordatorio*

El pedido #102 sigue esperando tu precio.

🛒 *Pedido*

✅ 🥤 *Coca-Cola 2 litros x2*

✅ 🍜 *Sopa Maruchan habanero x1*

✅ 🧴 *Pinol 1 litro x1*

✅ 🫓 *Tortillas x1*

Tienes *5 minutos* antes de que se cancele.

*Responde así:*
ORDEN #102 PRECIO 150

¿Te falta algún producto?

*Responde:*
ORDEN #102 NO_DISPONIBLE nombre del producto


================================================================
TIENDA — producto no encontrado
================================================================

🏪 *No encontré "kétchup" en el pedido #102.*

🛒 *Pedido*

✅ 🥤 *Coca-Cola 2 litros x2*

✅ 🍜 *Sopa Maruchan habanero x1*

✅ 🧴 *Pinol 1 litro x1*

✅ 🫓 *Tortillas x1*

*Escribe el nombre tal como aparece arriba.*

ORDEN #102 NO_DISPONIBLE Pinol 1 litro


================================================================
TIENDA — ya no hace falta cotizar
================================================================

🏪 *Pedido #102*

Se canceló por falta de respuesta a tiempo. Ya no es necesario cotizarlo.


================================================================
REPARTIDOR — pedido nuevo
================================================================

🛵 *Hola Luis, tienes un nuevo pedido*

🧾 *Pedido #102*

🏪 *ZAGU*

📍 *Recoger en:*
Calle Hidalgo 20

📍 *Entregar en:*
Calle Hidalgo 12, frente a la tortillería
https://maps.google.com/?q=20.86,-103.24

🛒 *Productos:*

✅ 🥤 *Coca-Cola 2 litros x2*

✅ 🍜 *Sopa Maruchan habanero x1*

✅ 🧴 *Pinol 1 litro x1*

✅ 🫓 *Tortillas x1*

💵 *Cobrar: $122*

*Tel. cliente:* 5213312345678

*Responde con:*
#CONFIRMO 102

*Luego:*
#RECOGI 102

#ENTREGADO 102


================================================================
REPARTIDOR — aceptado, recogido, entregado
================================================================

✅ *Aceptación registrada*

Pedido *#102*.

---

🛵 *Pedido #102*

Lo tomó el repartidor *Luis*.

---

⏰ *Pedido #102*

Tienes *5 minutos* más para aceptarlo, o se cancelará.

*Responde:*
#CONFIRMO 102


================================================================
REPARTIDOR — comando inválido
================================================================

🛵 *Comando inválido.*

Usa uno de estos formatos:

#CONFIRMO 123

#RECOGI 123

#ENTREGADO 123
```
