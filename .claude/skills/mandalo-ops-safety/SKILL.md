---
name: mandalo-ops-safety
description: Reglas operativas para tocar Mándalo en producción — correr SQL en Supabase, hacer commits/push/merges, tocar variables de entorno o secretos, y borrar datos. Úsalo antes de cualquier cambio que afecte producción, no solo cuando el usuario lo pida explícitamente.
---

# Reglas operativas de Mándalo

Aprendidas en las sesiones de migración de esquema (agosto 2026). No son reglas
de negocio (esas viven en `CLAUDE.md`) — son convenciones de CÓMO trabajar en
este proyecto sin romper producción ni hacerle perder tiempo a Víctor.

## SQL / Supabase

- **Claude no tiene acceso de ejecución DDL.** Nunca asumas que puedes correr
  una migración directamente — el patrón de este proyecto es: Claude escribe
  el SQL, Víctor lo corre él mismo en el SQL Editor de Supabase.
- Antes de cualquier `DELETE`/`UPDATE`/`ALTER` en producción, **primero un
  `SELECT` de verificación** (dry-run) para que Víctor confirme qué se va a
  tocar, con nombres/IDs exactos — nunca borres "todo lo que parezca de
  prueba" sin que él vea la lista primero.
- Antes de borrar filas, revisa el comportamiento de FKs (`on delete cascade`
  vs `restrict`) para saber qué se lleva entre manos — dilo explícitamente
  ("esto también borra pedido_tiendas/pedido_items/pedido_eventos por
  cascada").
- Para migraciones de esquema (rename, cutover, cambios estructurales):
  confirma las precondiciones explícitamente antes de dar luz verde (ej. "no
  hay pedidos activos en curso") — no lo des por hecho de una sesión a otra,
  vuelve a verificar.
- Cambios estructurales importantes (borrar tablas, cambiar arquitectura,
  modificar reglas de precio) se proponen primero y se ejecutan solo con
  aprobación explícita de Víctor (regla ya está en `CLAUDE.md` Sección 13,
  punto 10 — repetida aquí porque es la que más se olvida bajo presión).

## Git / GitHub

- **Este entorno no tiene credenciales de GitHub configuradas.** Nunca
  intentes `git push` — siempre va a fallar con
  `could not read Username for 'https://github.com'`. Prepara el commit
  localmente y pide a Víctor que lo pushee desde su propia terminal
  (`! git push ...`).
- No commitees ni pushees sin autorización explícita **para ese cambio
  específico** — una autorización anterior ("sí, adelante con el commit") no
  cubre el siguiente batch de cambios, aunque sea en el mismo tema.
- Para cambios de lógica de negocio no triviales, usa una rama nueva y prueba
  en un Preview Deployment de Vercel antes de tocar `main`. Cambios triviales
  de documentación/config pueden ir directo a `main` si Víctor lo prefiere así
  — pregúntale, no lo asumas.
- Si te piden el diff completo antes de un merge, dalo literal
  (`git diff main...rama`, con tres puntos para comparar contra el ancestro
  común) — no lo resumas ni lo recortes, archivo por archivo.
- Al hacer `git add`, agrega archivos específicos por nombre — nunca
  `git add -A`/`git add .` a ciegas. Si hay cambios sin relación mezclados en
  el working tree (ej. un cleanup de código junto con una nota de
  documentación), sepáralos en commits distintos.

## Secretos y variables de entorno

- `CRON_SECRET` (workers internos, header `Authorization: Bearer`) y
  `MANDALO_WEBHOOK_SECRET` (webhook público, header
  `x-mandalo-webhook-secret` o `?secret=`) son **dos secretos distintos** — no
  los confundas al armar un `curl` de prueba.
- Las variables de entorno de Vercel están separadas por
  Production/Preview/Development. Un cambio en un scope no se refleja en otro,
  y un cambio de valor **no toma efecto en un deployment ya existente** hasta
  que se redespliega. Si algo sigue fallando después de cambiar una variable,
  lo primero que hay que preguntar es "¿ya redesplegaste?".
- Nunca le pidas a Víctor que pegue un secreto real en el chat. Si sucede de
  todos modos (por ejemplo, dentro de un comando `curl` que copió y pegó),
  avísale de inmediato para que lo rote — no lo dejes pasar en silencio.
- Si falta una API key, credencial o acceso que no esté ya configurado,
  pídesela directamente a Víctor. Nunca asumas, inventes, o dejes un
  placeholder sin avisar explícitamente (regla base en `CLAUDE.md` Sección 12).

## Alcance y honestidad

- Si durante una tarea descubres un bug o hueco fuera del alcance original
  (como pasó con la fusión de `items` durante la prueba del fix
  conversacional), no lo arregles silenciosamente ni lo ignores: documéntalo
  en `ROADMAP.md` y pregúntale a Víctor si quiere atenderlo ahora o como su
  propio ciclo de trabajo aparte.
- Comunica cualquier riesgo técnico o ineficiencia de inmediato, sin
  ocultarlo — es el pacto de honestidad de este proyecto (`CLAUDE.md` Sección
  2), y aplica tanto a bugs que tú causaste como a los que ya estaban ahí.

## Datos de prueba en producción

- Este proyecto no tiene ambiente de staging real (el que se creía staging
  resultó ser el mismo proyecto de producción). Cualquier prueba end-to-end
  toca datos reales.
- Antes de correr una prueba, verifica si hay pedidos de prueba viejos que
  puedan interferir (`getOpenPedidoByCustomerPhone` no filtra por estado, así
  que un pedido de prueba viejo sin cerrar se puede "colar" como si fuera el
  pedido activo del siguiente intento — ver `ROADMAP.md`).
- Después de una ronda de pruebas, ofrece limpiar lo que se generó (pedidos,
  chat_history) antes de dar la tarea por cerrada, en vez de dejarlo para que
  Víctor se tropiece con eso después.

## Mantener la documentación viva

- `CLAUDE.md` = reglas de negocio y arquitectura (cambia poco).
  `ROADMAP.md` = estado operativo: qué está listo, qué está roto, qué falta
  (cambia cada ciclo de trabajo). No dupliques contenido entre los dos — si
  algo es "estado", va en `ROADMAP.md`; si es "regla", va en `CLAUDE.md`.
- Al cerrar un ciclo de trabajo (una fase, un fix, una feature), actualiza
  `ROADMAP.md` antes de terminar la sesión.
