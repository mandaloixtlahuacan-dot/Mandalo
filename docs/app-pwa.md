# App web PWA de Mándalo

Primera versión. Vive en `/app` y `/api/app/*` para no mezclarse con el webhook de WhatsApp. La tienda y el repartidor siguen operando por WhatsApp con los mismos comandos (`#PRECIO`, `#CONFIRMO`, `#RECOGI`, `#ENTREGADO`).

La migración de cuentas y avisos está en `supabase/migrations/20261024_app_pwa_usuarios_push.sql`. **No está aplicada.** Hasta que Víctor la corra, el catálogo se puede ver y el registro responde que falta activar la base. El bot no depende de esas tablas.

## Cómo se arma un pedido

1. El cliente entra por una bienvenida y elige una categoría: Tienda (abarrotes), Restaurantes o Carnicería (`src/lib/app/categories.ts`). En la siguiente pantalla salen las tiendas de esa categoría, con horario y si están abiertas. Recién ahí se entra al menú.
2. El catálogo se lee de `productos_tienda`. Solo tiendas `activa = true`. El horario es el que ya guarda la tienda.
3. En Peke's los ~12,500 productos se agrupan en anaqueles con reglas de palabras clave (`src/lib/app/shelves.ts`): Bebidas, Botanas, Dulces, Lácteos, Panadería, Despensa, Sazonadores, Enlatados, Limpieza, Higiene, Bebés, Mascotas y Otros. No usa OpenAI. Si el nombre no alcanza, usa la `categoria` que ya trae el producto. La columna `categoria_app` está propuesta en `supabase/migrations/20261024_app_pwa_categoria_anaquel.sql` y no está aplicada; el código no la lee.
4. El carrito vive en el teléfono. Los extras (sin cebolla, término, bien cocido) y la salsa solo aplican en restaurantes. En George el campo dice: «Si deseas alguna salsa o condimento especial (BBQ, Buffalo...), indícalo aquí». Abarrotes y carnicería no muestran esos extras.
5. La dirección se escribe en el mapa. Por defecto es Leaflet con teselas de OpenStreetMap y la atribución © OpenStreetMap. La búsqueda pasa por `/api/app/geocode`, que llama a Nominatim con espera de al menos 1 segundo, User-Agent y Referer de Mándalo, y resultados acotados a Ixtlahuacán del Río, Jalisco (`viewbox` del cuadro de la cabecera y `bounded=1`). Ese cuadro no acepta ni rechaza el pedido: eso sigue siendo el radio de 1.5 km. El autocompletado mueve el pin y el cliente lo puede arrastrar. Se guardan la calle y las coordenadas. No hace falta API key. Google solo entra si `NEXT_PUBLIC_MAP_PROVIDER=google` y además hay `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
6. Confirmar exige cuenta (cookie `mandalo_app`, httpOnly). `placeAppOrder` crea el pedido en `confirmacion_cliente`, igual que el SÍ del bot, y luego usa el mismo despacho.

El precio de abarrotes es cotización: `usa_catalogo_fijo` es falso, `total_cliente` nace nulo y la tienda recibe `ORDEN #N PRECIO`. George y La Central (`usa_catalogo_fijo`) confirman con `ORDEN #N CONFIRMO` y el total ya incluye envío y servicio. El corte es esa columna, no el nombre de la categoría.

Cargos, tomados de `src/lib/ordenes.ts` (no los hardcodea la pantalla): envío $15 (`servicio_repartidor`) y servicio $10 (`servicio_mandalo`). `CONTEXTO.md` todavía dice un solo cargo de $35; el código, `ROADMAP.md` y esta app usan $15 + $10.

Si la tienda está cerrada o Mándalo está fuera de 8:00–23:30 (hora de México), el pedido queda en `esperando_apertura_tienda` y el worker que ya existe lo despacha después. Tope de 48 horas, el mismo de siempre.

Si un pedido de catálogo fijo no tiene repartidor en horario, se cancela con el mismo camino del bot. En abarrotes el cliente confirma el total ya cotizado con el botón de la pantalla de seguimiento (`confirmQuotedTotal` → oferta a repartidores).

Los WhatsApp al cliente y a la tienda entran a `admin_notificaciones` (`enqueueOutboundMessage`). Esta app no llama a Whapi directo.

`pedidos.origen` no va en el insert, porque la columna todavía no existe y el insert fallaría. Va en `metadata_json.origen = "app"` y, si la columna ya está, un update aparte. Si la columna falta, ese update se ignora.

## Cobertura

La regla activa es el círculo de 1.5 km alrededor de `IXTLAHUACAN_CENTER` (`src/lib/services/geo.ts`). `PROPOSED_CABECERA_BBOX` está apagado y no acepta ni rechaza.

`zonas_cobertura` es una lista de calles, no un polígono. Sirve cuando no hay pin. Un pin dentro del radio vale aunque la tabla no responda. Un pin fuera se rechaza aunque la calle coincida. El punto 0,0 no cuenta como pin.

## Avisos push

Se mandan desde el mismo lugar donde hoy cambia el estado, sin cambiar el mensaje de WhatsApp:

- `setPedidoEstado` en `pedidoRepositoryV2.ts` (cotización confirmada, programación, cancelaciones que pasan por ahí).
- `writePedidoState` en `stateTransitionService.ts`. `#RECOGI` y `#ENTREGADO` pasan por aquí. `#RECOGI` no guarda `recogiendo`: escribe `en_camino_cliente`.
- El claim directo a `pendiente_tiendas` en `dispatchCotizacionToStore`, porque ese update no usa los dos de arriba.

`en_camino_cliente` manda dos avisos: «Pedido recogido» y «Tu pedido va en camino» (el segundo va destacado). No hay aviso para `repartidor_asignado`.

La lectura de suscripciones y el envío esperan como máximo 3 segundos, para alcanzar a armar el aviso de entregado antes de que la retención borre el pedido, sin congelar el isolate. Si falla el push, el bot sigue. Si las tablas no existen, se calla 5 minutos y reintenta.

Hace falta `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (`mailto:` o una URL https). No hay un subject inventado en el código.

Para generar un par nuevo, sin guardarlo en el repo:

```
npx tsx scripts/gen-vapid.ts
```

En Vercel, proyecto `mandalo1`, target **Preview** (no Production):

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` tipo encrypted
- `VAPID_PRIVATE_KEY` tipo sensitive
- `VAPID_SUBJECT` = `https://mandalo1.vercel.app`

El deployment que ya estaba construido no las toma. Hace falta un deploy nuevo. La clave privada no va en git.

## Qué tocar cuando Víctor cambie algo

| Cambio | Dónde |
|---|---|
| Categorías o el texto de cada una | `src/lib/app/categories.ts` y, si es un nicho nuevo del bot, `CUSTOMER_STORE_NICHES` |
| Envío o servicio | `src/lib/ordenes.ts` (`DELIVERY_FEE`, `MANDALO_SERVICE_FEE`) |
| Extras y salsas | `RESTAURANT_EXTRAS` y `SALSA_SUGERENCIAS` en `src/components/app/cart.tsx`, y `EXTRAS_OK` en `src/lib/app/placeOrder.ts`. Solo cuentan si la tienda es restaurante. |
| Anaqueles de Peke's | `src/lib/app/shelves.ts` |
| Textos del push | `src/lib/app/pushCopy.ts` |
| Pasos de la pantalla de seguimiento | `src/lib/app/tracking.ts` |
| Radio o centro | `src/lib/services/geo.ts` (lo comparte el bot) |
| Mapa | Por defecto OSM en `src/lib/app/geocode.ts` y `src/components/app/OsmMap.tsx`. Google solo con `NEXT_PUBLIC_MAP_PROVIDER=google` y la llave. |

Los extras se pegan al nombre del producto solo si el menú fijo sigue reconociendo el mismo producto. Si no, el nombre queda exacto y la nota sale en un segundo WhatsApp a la tienda. En abarrotes el paréntesis siempre va en el renglón, porque no hay menú fijo que parear. La cantidad va en `cantidad`, no en el nombre.

## Instalarla

Manifest en `/app/manifest.webmanifest`. Íconos con el monograma en `public/icons/`. Service worker en `public/sw.js`: no intercepta `/api/` (el webhook sigue intacto) y solo cachea `/app`, `/icons/` y `/brand/`. Se instala desde el navegador, sin tiendas de apps.

## Variables en Vercel

```
NEXT_PUBLIC_MAP_PROVIDER
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

`NEXT_PUBLIC_MAP_PROVIDER` vacío o `osm` usa OpenStreetMap. No hace falta llave. Google pide las dos: `google` y `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Las pruebas no llaman a Nominatim.

## Cuando Víctor aplique la migración

1. Pegar el SQL en el SQL Editor de Supabase. No hace falta un deploy para crear las tablas.
2. Redeploy (o esperar una instancia nueva) para que el aviso de «tabla ausente» no se quede en caché 5 minutos.
3. Probar registro, un pedido de prueba y un cambio de estado.

## Qué no hace esta versión

- No guarda historial: al llegar a `entregado` o `cancelado` el bot borra el pedido. La pantalla explica el 404 y, si el teléfono lo vio, deja el último estado en `sessionStorage`.
- No hay unidad de kilo aparte de `cantidad`. Un corte por kilo va en la nota.
- No hay límite de intentos de login.
- Conyorch aparece solo si está en `tiendas`, activa, y su categoría o su nombre cae en restaurantes.
- El preview responde 503 en registro, sesión y compra mientras no existan `usuarios_app` y `sesiones_app`. El listado de tiendas no las necesita.
- No se aplicó SQL, no se mandó WhatsApp real y no se envió un push real en las pruebas.
