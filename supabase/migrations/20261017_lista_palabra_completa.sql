-- Búsqueda de Peke's: la palabra completa entra en el tope de 200.
-- Fecha: 2026-10-17
--
-- NO APLICADA. Víctor la corre en el SQL Editor. No hay DROP ni DELETE.
-- No modifica filas. Reemplaza el cuerpo de
-- buscar_lista_productos_tienda_amplia (misma firma). Si no se corre,
-- el bot sigue con la función anterior o, si tampoco existe, con
-- buscar_lista_productos_tienda (tope 80).
--
-- Con 12,865 productos, un LIKE de pedazo puede juntar más de 200 filas
-- (pan 344, cola 264, fresa 255 como palabra exacta). Esta versión
-- puntúa 8 la palabra completa y 2 el pedazo, y ordena primero la
-- palabra exacta. Sanitas, servilleta Pétalo, Hig Pétalo, Coca 600,
-- Zote, Nito y los sinónimos (fuste, pawer, pepe) quedan dentro del
-- tope. Si más de 200 filas traen la misma palabra exacta (fresa),
-- el tope se llena con esas y el resto pide una palabra más.
--
-- No hace falta un índice nuevo. Ya están
-- productos_tienda_tienda_idx (tienda_id, disponible) y, cuando se
-- haya corrido 20261015_productos_lista_trgm.sql, el GIN de
-- mandalo_fold(nombre_producto). El LIKE '%token%' de una tienda
-- usa ese GIN. «600 ml» se compara también pegado («600ml»).
--
-- Los sinónimos los manda el bot en p_tokens. Aquí se repiten fuste
-- y donado por si el SQL se llama sin esa expansión.
-- «algo de limpieza» y «refresco» también mandan la familia
-- (fabuloso, pinol, cloro, coca, sprite, pepsi, mirinda). Esta
-- función no la inventa: solo tiene que no sacarla del tope.

create or replace function public.buscar_lista_productos_tienda_amplia(
  p_tienda_id bigint,
  p_tokens text[],
  p_limit integer default 200
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
  with raw_tokens as (
    select distinct public.mandalo_fold(raw.token) as token
    from unnest(coalesce(p_tokens, array[]::text[])) as raw(token)
    where public.mandalo_fold(raw.token) ~ '^[a-z0-9]{3,40}$'
  ),
  synonym (src, dst) as (
    values
      ('fuste', 'fuze'),
      ('fuste', 'fuzetea'),
      ('fuze', 'fuzetea'),
      ('fuse', 'fuzetea'),
      ('fusi', 'fuzetea'),
      ('pawer', 'powerade'),
      ('pauer', 'powerade'),
      ('pepe', 'pepsi'),
      ('pepesi', 'pepsi'),
      ('donado', 'bonafont'),
      ('bonafon', 'bonafont'),
      ('donafon', 'bonafont'),
      ('donafont', 'bonafont'),
      ('fonafont', 'bonafont'),
      ('vonafont', 'bonafont'),
      ('cocacola', 'coca'),
      ('hall', 'halls')
  ),
  tokens as (
    select token from raw_tokens
    union
    select syn.dst
    from raw_tokens raw
    join synonym syn on syn.src = raw.token
    where syn.dst ~ '^[a-z0-9]{4,40}$'
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
      regexp_replace(public.mandalo_fold(p.nombre_producto), '([0-9])\s+(ml|l|lt|g|gr|kg|pz)\y', '\1\2', 'g') as nombre_pegado,
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
        select coalesce(sum(hit.score), 0)::real
        from (
          select
            case
              when exists (
                select 1 from regexp_split_to_table(b.nombre_fold, '\s+') as word(part)
                where part = t.token
              ) then 8
              when b.nombre_fold like '%' || t.token || '%'
                or b.nombre_pegado like '%' || t.token || '%' then 2
              when length(t.token) >= 4 and exists (
                select 1 from regexp_split_to_table(b.nombre_fold, '\s+') as word(part)
                where part like t.token || '%' or (length(part) >= 4 and t.token like part || '%')
              ) then 3
              when length(t.token) >= 6
                and b.nombre_fold like '%' || left(t.token, 3) || '%'
                and word_similarity(t.token, b.nombre_fold) >= 0.4 then 2
              else 0
            end
            + case
              when b.marca_fold <> '' and exists (
                select 1 from regexp_split_to_table(b.marca_fold, '\s+') as word(part)
                where part = t.token
              ) then 6
              when b.marca_fold <> '' and b.marca_fold like '%' || t.token || '%' then 2
              else 0
            end
            + case
              when b.alias_fold <> '' and exists (
                select 1 from regexp_split_to_table(b.alias_fold, '\s+') as word(part)
                where part = t.token
              ) then 8
              when b.alias_fold <> '' and b.alias_fold like '%' || t.token || '%' then 2
              else 0
            end as score
          from tokens t
        ) as hit
        where hit.score > 0
      ) as rank,
      (
        select count(*)::int
        from tokens t
        where exists (
          select 1
          from regexp_split_to_table(b.nombre_fold, '\s+') as word(part)
          where part = t.token
        )
      ) as exact_words,
      case
        when exists (
          select 1
          from tokens t
          where b.nombre_fold = t.token
            or b.nombre_fold like t.token || ' %'
        ) then 1
        else 0
      end as name_starts,
      (
        select count(*)::real
        from tokens t
        where b.nombre_fold like '%' || t.token || '%'
          or b.nombre_pegado like '%' || t.token || '%'
          or b.marca_fold like '%' || t.token || '%'
          or b.alias_fold like '%' || t.token || '%'
      ) as matched
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
  order by scored.exact_words desc, scored.name_starts desc, scored.matched desc, scored.rank desc, scored.nombre_producto asc, scored.id asc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$$;

comment on function public.buscar_lista_productos_tienda_amplia(bigint, text[], integer) is
  'Hasta 200 productos. La palabra completa (8) gana al pedazo (2). No aplicada hasta que Víctor la corra.';

grant execute on function public.buscar_lista_productos_tienda_amplia(bigint, text[], integer) to service_role;
