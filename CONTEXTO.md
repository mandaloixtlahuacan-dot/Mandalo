# Mándalo — Contexto de estado

Documento de estado del negocio y del bot. Las reglas de arquitectura que cambian poco siguen en `CLAUDE.md`. Lo que está listo, roto o pendiente sigue en `ROADMAP.md`.

## Qué es

Sistema de delivery por WhatsApp para Ixtlahuacán del Río. Un solo número atiende a clientes, tiendas y repartidores; el rol sale de la tabla donde está registrado el teléfono.

## Tarifa de envío y servicio

Víctor lo cambió el 2026-10-15. Esta tarifa reemplaza el cargo de $25 vigente desde el 2026-10-05.

- El cliente paga **$35** en total de envío y servicio.
- De esos $35, **$35** son para el repartidor y **$0** son para Mándalo.
- Al cliente ese cargo se muestra junto, en una sola línea de $35 de envío y servicio. En la base, `servicio_mandalo` (0) y `servicio_repartidor` (35) suman lo mismo.

El pago del pedido es en efectivo y lo cobra el repartidor.
