# Lista de productos de abarrotes

La tienda sigue cotizando. Esta lista solo sirve para preguntar menos: si la tienda tiene dos leches Lala, se pregunta cuál de esas dos, no los litros de memoria. No prende `usa_catalogo_fijo` y no muestra precios.

Hoy no hay lista cargada. Sin filas, o con `usa_lista_productos = false`, el bot sigue el flujo de aclaraciones de siempre.

## 1. Migración (todavía no está aplicada)

En el SQL Editor de Supabase, corre `supabase/migrations/20261009_productos_lista_abarrotes.sql`. Agrega:

- `tiendas.usa_lista_productos` (default false)
- `productos_tienda.marca`, `presentacion`, `alias`
- un índice único por tienda + nombre + marca + presentación

## 2. Archivo

CSV con encabezado:

```text
nombre,marca,presentacion,categoria,alias
Leche,Lala,entera 1 L,lacteos,lala entera|leche lala
Leche,Lala,deslactosada 1 L,lacteos,lala deslactosada
```

`alias` se separa con `|` o `;`. `precio` no va: si el CSV no trae precio, queda null.

Texto plano, un producto por línea:

```text
Leche
Pan Bimbo
```

O con barras: `nombre | marca | presentacion | categoria`

Las líneas que empiezan con `#` se ignoran. Si el mismo nombre, marca y presentación se repite, se queda una.

Hay una plantilla comentada en `supabase/seed/003_lista_productos_abarrotes.sql` por si se pega directo en el SQL Editor.

## 3. Importar

Primero un ensayo, no escribe nada:

```bash
npx tsx scripts/import-store-products.ts 1 ./lista.csv
```

El `1` es el id de la tienda (Agua Santa es 1, ZAGU es 4). Cuando el ensayo se vea bien:

```bash
npx tsx scripts/import-store-products.ts 1 ./lista.csv --apply
```

`--apply` inserta o actualiza filas y pone `usa_lista_productos = true` en esa tienda. Hace falta la migración y las llaves de Supabase en el entorno.

## 4. Listas de más de 1000 productos

PostgREST corta un `select` sin paginar en 1000 filas. Mini Super Peke's (tienda 7) tiene unos 12,865, así que un select de toda la lista escondía casi todo y el matcher podía elegir otra marca o otro tamaño.

Antes de desplegar el código que busca, corre `supabase/migrations/20261015_productos_lista_trgm.sql` en el SQL Editor. No borra filas. Crea `pg_trgm` si no está, un índice GIN de trigramas en `productos_tienda(nombre_producto)`, otro en el nombre ya sin acentos, y la función `buscar_lista_productos_tienda`.

Con 1000 productos o menos (Agua Santa) se sigue trayendo la lista completa. Con más, se buscan a lo más 80 candidatos con las palabras del mensaje —sin acentos, sin “quiero”, sin “2 litros”— en el nombre, la marca, el alias y la presentación. Después corre el mismo `matchLista` de siempre. En un turno se consulta una vez y se reusa.

Si esa función todavía no existe, una tienda grande se queda sin lista en ese turno (no se usan las primeras 1000 al azar). Hay que correr el SQL antes de desplegar.

## 5. Qué hace el bot con la lista

- Si el cliente dice algo que pega con una sola fila, se anota esa y solo se pregunta la cantidad si falta.
- Si hay varias (entera y deslactosada, por ejemplo), se ofrecen esas opciones numeradas, máximo 5. No se ofrecen tamaños que la tienda no tiene.
- Si no está en la lista, se anota tal cual lo dijo el cliente y, una vez, `_Lo anoto así y la tienda confirma._` Nunca se dice que no lo manejan.
- A la IA solo se le mandan los nombres que pegan con el mensaje, sin precios.
