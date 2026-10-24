# App web PWA de Mándalo

Primera versión. Vive en `/app` y `/api/app/*` para no mezclarse con el webhook de WhatsApp. La tienda y el repartidor siguen operando por WhatsApp con los mismos comandos (`#PRECIO`, `#CONFIRMO`, `#RECOGI`, `#ENTREGADO`).

La migración de cuentas y avisos está en `supabase/migrations/20261024_app_pwa_usuarios_push.sql`. **No está aplicada.** Hasta que Víctor la corra, el catálogo se puede ver y el registro responde que falta activar la base. El bot no depende de esas tablas.

## Cómo se arma un pedido

1. El cliente elige una de tres categorías fijas: Abarrotes, Carnicería, Restaurantes (`src/lib/app/categories.ts`). El nombre de la tienda sale de `tiendas`. Si `categoria` viene vacía, se reconoce por el nombre (Peke's, La Central, George o Conyorch).
2. El catálogo se lee de `productos_tienda`. Solo tiendas `activa = true`. El horario es el que ya guarda la tienda (`hora_apertura`, `hora_cierre`, `horario_por_dia`, `dias_cerrado`).
3. Abarrotes (`usa_lista_productos` o la categoría abarrotes) no vuelca los ~12,500 productos: hay que escribir al menos 2 letras y la búsqueda es del servidor, 20 por página (`src/lib/app/catalog.ts`).
4. El carrito vive en el teléfono (`localStorage`). Cada línea puede llevar extras de una lista cerrada y una nota de 120 caracteres.
5. La dirección es un pin. Si no hay `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, la pantalla pide latitud, longitud o una calle.
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

Hace falta `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (`mailto:` o una URL https). No hay un subject inventado.

## Qué tocar cuando Víctor cambie algo

| Cambio | Dónde |
|---|---|
| Categorías o el texto de cada una | `src/lib/app/categories.ts` y, si es un nicho nuevo del bot, `CUSTOMER_STORE_NICHES` |
| Envío o servicio | `src/lib/ordenes.ts` (`DELIVERY_FEE`, `MANDALO_SERVICE_FEE`) |
| Extras permitidos | `EXTRAS` en `src/components/app/cart.tsx` y `EXTRAS_OK` en `src/lib/app/placeOrder.ts` (tienen que coincidir) |
| Textos del push | `src/lib/app/pushCopy.ts` |
| Pasos de la pantalla de seguimiento | `src/lib/app/tracking.ts` |
| Radio o centro | `src/lib/services/geo.ts` (lo comparte el bot) |

Los extras se pegan al nombre del producto solo si el menú fijo sigue reconociendo el mismo producto. Si no, el nombre queda exacto y la nota sale en un segundo WhatsApp a la tienda. En abarrotes el paréntesis siempre va en el renglón, porque no hay menú fijo que parear. La cantidad va en `cantidad`, no en el nombre.

## Instalarla

Manifest en `/app/manifest.webmanifest`. Íconos con el monograma en `public/icons/`. Service worker en `public/sw.js`: no intercepta `/api/` (el webhook sigue intacto) y solo cachea `/app`, `/icons/` y `/brand/`. Se instala desde el navegador, sin tiendas de apps.

## Variables en Vercel

```
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

La llave de Maps es pública. Restríngela por referrer del preview y del dominio. Sin ella el pin se degrada a coordenadas escritas.

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
