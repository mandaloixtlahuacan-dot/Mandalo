-- Búsqueda de la lista de abarrotes por encima del tope de 1000 filas.
-- Fecha: 2026-10-15
--
-- NO APLICADA. Víctor la corre en el SQL Editor.
-- Depende de supabase/migrations/20261009_productos_lista_abarrotes.sql
-- (columnas marca, presentacion, alias). No modifica filas.
-- No hay DROP ni DELETE. Solo extensión, función e índices.
--
-- PostgREST corta un select sin paginar en 1000 filas. Mini Super Peke's
-- (tienda 7) tiene ~12,865 productos, así que el matcher no veía el resto.
-- La función devuelve como máximo 80 candidatos ya ordenados.
--
-- Latencia esperada en esa tienda, con el índice (tienda_id, disponible)
-- que ya existe:
--   contar disponibles: 1–5 ms
--   esta función: 20–60 ms. El LIKE recorre solo esa tienda. El parecido
--   (word_similarity) solo corre si la palabra tiene 6+ letras y las
--   primeras 3 ya aparecen en la fila, así que un typo no compara las 12 mil.
--   ida y vuelta desde Vercel, caso normal: unos 50–80 ms
-- No bajan las 12 mil filas por la red. La respuesta son a lo más 80.

create extension if not exists pg_trgm with schema extensions;

-- Minúsculas y sin acento, para que "atún" pegue con "atun".
-- Los dos argumentos de translate miden 79: 26 acentos en mayúscula,
-- 27 en minúscula (ý y ÿ) y 26 letras A-Z.
create or replace function public.mandalo_fold(value text)
returns text
language sql
immutable
parallel safe
as $$
  select translate(
    coalesce(value, ''),
    'ÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÝÑÇáàäâãåéèëêíìïîóòöôõúùüûýÿñçABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'aaaaaaeeeeiiiiooooouuuuyncaaaaaaeeeeiiiiooooouuuuyyncabcdefghijklmnopqrstuvwxyz'
  );
$$;

comment on function public.mandalo_fold(text) is
  'Minúsculas y sin acento español, para buscar la lista de abarrotes.';

-- gin_trgm_ops puede vivir en extensions (Supabase) o en public.
-- El índice pedido es el de nombre_producto. El segundo es la misma
-- columna ya doblada, para que el LIKE sin acento también use GIN.
do $$
declare
  ext_schema text;
  opclass text;
begin
  select n.nspname into ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';

  if ext_schema is null then
    raise exception 'pg_trgm no quedó instalado';
  end if;

  opclass := format('%I.gin_trgm_ops', ext_schema);

  execute format(
    'create index if not exists productos_tienda_nombre_trgm_idx on public.productos_tienda using gin (nombre_producto %s)',
    opclass
  );

  execute format(
    'create index if not exists productos_tienda_nombre_fold_trgm_idx on public.productos_tienda using gin (public.mandalo_fold(nombre_producto) %s)',
    opclass
  );
end $$;

-- security invoker: corre con el service_role del bot, que ya brinca el RLS.
-- anon no ve filas (productos_tienda tiene RLS y no tiene policies).
-- search_path incluye extensions porque ahí vive pg_trgm en Supabase.
create or replace function public.buscar_lista_productos_tienda(
  p_tienda_id bigint,
  p_tokens text[],
  p_limit integer default 80
)
returns table (
  id bigint,
  nombre_producto text,
  precio numeric,
  categoria text,
  marca text,
  presentacion text,
  alias text[],
  rank real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with tokens as (
    select distinct public.mandalo_fold(raw.token) as token
    from unnest(coalesce(p_tokens, array[]::text[])) as raw(token)
    where public.mandalo_fold(raw.token) ~ '^[a-z0-9]{3,40}$'
  ),
  base as (
    select
      p.id,
      p.nombre_producto,
      p.precio,
      p.categoria,
      p.marca,
      p.presentacion,
      p.alias,
      public.mandalo_fold(p.nombre_producto) as nombre_fold,
      public.mandalo_fold(coalesce(p.marca, '')) as marca_fold,
      public.mandalo_fold(coalesce(p.presentacion, '')) as presentacion_fold,
      public.mandalo_fold(array_to_string(coalesce(p.alias, array[]::text[]), ' ')) as alias_fold
    from public.productos_tienda p
    where p.tienda_id = p_tienda_id
      and p.disponible = true
      and exists (select 1 from tokens)
  ),
  scored as (
    select
      b.id,
      b.nombre_producto,
      b.precio,
      b.categoria,
      b.marca,
      b.presentacion,
      b.alias,
      (
        select coalesce(sum(
          case
            when b.nombre_fold like '%' || t.token || '%' then 4
            when length(t.token) >= 6
              and b.nombre_fold like '%' || left(t.token, 3) || '%'
              and word_similarity(t.token, b.nombre_fold) >= 0.4 then 2
            else 0
          end
          + case
            when b.marca_fold <> '' and b.marca_fold like '%' || t.token || '%' then 3
            when b.marca_fold <> ''
              and length(t.token) >= 6
              and b.marca_fold like '%' || left(t.token, 3) || '%'
              and word_similarity(t.token, b.marca_fold) >= 0.4 then 1
            else 0
          end
          + case
            when b.alias_fold <> '' and b.alias_fold like '%' || t.token || '%' then 4
            when b.alias_fold <> ''
              and length(t.token) >= 6
              and b.alias_fold like '%' || left(t.token, 3) || '%'
              and word_similarity(t.token, b.alias_fold) >= 0.4 then 2
            else 0
          end
          + case
            when b.presentacion_fold <> '' and b.presentacion_fold like '%' || t.token || '%' then 1
            else 0
          end
        ), 0)::real
        from tokens t
      ) as rank
    from base b
  )
  select
    scored.id,
    scored.nombre_producto,
    scored.precio,
    scored.categoria,
    scored.marca,
    scored.presentacion,
    scored.alias,
    scored.rank
  from scored
  where scored.rank > 0
  order by scored.rank desc, scored.nombre_producto asc, scored.id asc
  limit least(greatest(coalesce(p_limit, 80), 1), 80);
$$;

comment on function public.buscar_lista_productos_tienda(bigint, text[], integer) is
  'Hasta 80 productos disponibles de una tienda que pegan con los tokens del mensaje. Evita el tope de 1000 filas de PostgREST.';

grant execute on function public.buscar_lista_productos_tienda(bigint, text[], integer) to service_role;
