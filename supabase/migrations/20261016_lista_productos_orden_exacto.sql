-- Orden de la búsqueda amplia: palabra exacta y nombre que empieza
-- ganan al pedazo ("nito" en Nito 62g antes que en cariñitos).
-- Fecha: 2026-10-16
--
-- NO APLICADA. Víctor la corre en el SQL Editor. El bot ya reordena
-- igual en TypeScript (rankListaCandidates). Si esta función no existe,
-- sigue el orden de 20261016_lista_productos_busqueda_amplia.sql.
--
-- No hay DROP ni DELETE. No modifica filas. Misma firma: solo cambia
-- el ORDER BY. El filtro rank > 0 sigue igual, así que salen las mismas
-- filas. Depende de public.mandalo_fold.

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
        select coalesce(sum(hit.score), 0)::real
        from (
          select
            case
              when b.nombre_fold like '%' || t.token || '%' then 4
              when length(t.token) >= 3 and exists (
                select 1 from regexp_split_to_table(b.nombre_fold, '\s+') as word(part)
                where part like t.token || '%' or (length(part) >= 4 and t.token like part || '%')
              ) then 3
              when length(t.token) >= 6
                and b.nombre_fold like '%' || left(t.token, 3) || '%'
                and word_similarity(t.token, b.nombre_fold) >= 0.4 then 2
              else 0
            end
            + case
              when b.marca_fold <> '' and b.marca_fold like '%' || t.token || '%' then 3
              when b.marca_fold <> '' and length(t.token) >= 3 and exists (
                select 1 from regexp_split_to_table(b.marca_fold, '\s+') as word(part)
                where part like t.token || '%' or (length(part) >= 4 and t.token like part || '%')
              ) then 2
              when b.marca_fold <> ''
                and length(t.token) >= 6
                and b.marca_fold like '%' || left(t.token, 3) || '%'
                and word_similarity(t.token, b.marca_fold) >= 0.4 then 1
              else 0
            end
            + case
              when b.alias_fold <> '' and b.alias_fold like '%' || t.token || '%' then 4
              when b.alias_fold <> '' and length(t.token) >= 3 and exists (
                select 1 from regexp_split_to_table(b.alias_fold, '\s+') as word(part)
                where part like t.token || '%' or (length(part) >= 4 and t.token like part || '%')
              ) then 3
              else 0
            end
            + case
              when b.presentacion_fold <> '' and (
                b.presentacion_fold like '%' || t.token || '%'
                or exists (
                  select 1 from regexp_split_to_table(b.presentacion_fold, '\s+') as word(part)
                  where part like t.token || '%'
                )
              ) then 1
              else 0
            end as score
          from tokens t
        ) as hit
        where hit.score > 0
      ) as rank,
      (
        select count(*)::real
        from tokens t
        where b.nombre_fold like '%' || t.token || '%'
          or b.marca_fold like '%' || t.token || '%'
          or b.alias_fold like '%' || t.token || '%'
          or b.presentacion_fold like '%' || t.token || '%'
          or exists (
            select 1
            from regexp_split_to_table(
              b.nombre_fold || ' ' || b.marca_fold || ' ' || b.alias_fold || ' ' || b.presentacion_fold,
              '\s+'
            ) as word(part)
            where length(t.token) >= 3 and (part like t.token || '%' or (length(part) >= 4 and t.token like part || '%'))
          )
      ) as matched,
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
      end as name_starts
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
    (scored.rank + scored.matched * 3) as rank
  from scored
  where scored.rank > 0
  order by scored.exact_words desc, scored.name_starts desc, scored.matched desc, scored.rank desc, scored.nombre_producto asc, scored.id asc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$$;

comment on function public.buscar_lista_productos_tienda_amplia(bigint, text[], integer) is
  'Hasta 200 productos. Mismas filas que la búsqueda amplia; primero la palabra exacta y el nombre que empieza así. No aplicada hasta que Víctor la corra.';

grant execute on function public.buscar_lista_productos_tienda_amplia(bigint, text[], integer) to service_role;
