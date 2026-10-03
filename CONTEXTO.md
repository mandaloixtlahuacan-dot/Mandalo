# Mándalo — Contexto de estado

Documento de estado del negocio y del bot. Las reglas de arquitectura que cambian poco siguen en `CLAUDE.md`. Lo que está listo, roto o pendiente sigue en `ROADMAP.md`.

## Qué es

Sistema de delivery por WhatsApp para Ixtlahuacán del Río. Un solo número atiende a clientes, tiendas y repartidores; el rol sale de la tabla donde está registrado el teléfono.

## Tarifa de envío y servicio

Víctor lo confirmó en una prueba en vivo el 2026-10-03. Esta confirmación reemplaza cualquier nota anterior de un servicio fijo de $20 o de un envío fijo de $20.

- El cliente paga **$35** en total de envío y servicio.
- De esos $35, **$25** son para el repartidor y **$10** son para Mándalo (Víctor).
- Al cliente ese cargo se muestra junto, en una sola línea de $35 de envío y servicio. El desglose se conserva en la base (`servicio_mandalo` / `servicio_repartidor`) y en los mensajes internos.

El pago del pedido es en efectivo y lo cobra el repartidor.
