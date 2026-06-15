# Informe Técnico - Fase 1

## Congelación Y Normalización De La Máquina De Estados De Mándalo

Fecha: 2026-06-08

## Objetivo

Congelar el estado real del sistema actual para preparar una refactorización segura, sin modificar código todavía.

Este informe integra además 3 reglas de negocio que deben influir en el diseño de la máquina de estados futura:

- Mándalo opera solo en `Ixtlahuacán del Río`.
- La IA debe proponer alternativas si el inventario es insuficiente; eso es comportamiento conversacional, no una razón para romper el flujo.
- El repartidor debe recibir automáticamente Google Maps y contacto del cliente al momento correcto del flujo.

## Alcance Del Análisis

Se revisaron estas fuentes:

- `mandalo/src/lib/mandaloFlow.ts`
- `mandalo/src/lib/ordenes.ts`
- `mandalo/src/lib/llmResponseSchema.ts`
- consultas a `Supabase` sobre `public.pedidos`
- migraciones SQL en `mandalo/supabase/migrations`

## Hallazgo Principal

Hoy no existe una sola máquina de estados.

Existen al menos 4 catálogos distintos superpuestos:

1. Estados de chat persistidos en `pedidos.estado`
2. Estados de orden persistidos en `pedidos.estado`
3. Estados legacy definidos en helpers
4. Estados que la IA puede emitir en `order_state.stage`

Eso significa que una misma orden puede quedar conceptualmente en un estado y técnicamente ser interpretada como otro.

## Inventario Completo De Estados Detectados

### A. Estados de chat persistidos en `public.pedidos`

Estos no representan el ciclo de vida de una orden; representan mensajes o bitácora:

- `cliente`
- `bot`
- `tienda`
- `repartidor`
- `sistema`

Observación:

`guardarMensajeChat()` solo inserta `cliente` y `bot`, pero las consultas excluyen también `tienda`, `repartidor` y `sistema`, así que el sistema asume que esas filas existen o podrían existir.

### B. Estados de orden persistidos u operados realmente por `mandaloFlow.ts`

Estados detectados como parte del flujo vivo:

- `collecting`
- `esperando_confirmacion`
- `awaiting_confirmation`
- `awaiting_quote`
- `awaiting_confirm`
- `en_proceso`
- `repartidor_asignado`
- `en_camino`
- `llegado`
- `completado`
- `cancelado`

### C. Estados legacy detectados en `ordenes.ts`

Estados definidos o usados por helpers, pero no alineados con el flujo principal:

- `cotizando`
- `esperando_confirmacion`
- `asignado`
- `en_camino`
- `entregado`
- `cancelado`

Observación:

`buscarOrdenActivaCliente()` usa:

- `cotizando`
- `esperando_confirmacion`
- `asignado`
- `en_camino`

Pero el flujo principal de `mandaloFlow.ts` no opera principalmente con `cotizando` ni `asignado`; usa `awaiting_quote`, `awaiting_confirm`, `en_proceso` y `repartidor_asignado`.

### D. Estados que la IA puede emitir en `llmResponseSchema.ts`

Estados permitidos en `order_state.stage`:

- `lead`
- `collecting`
- `ready_to_quote`
- `awaiting_quote_confirm`
- `awaiting_confirmation`
- `awaiting_quote`
- `cotizando`
- `awaiting_confirm`
- `confirmado`
- `cancelado`
- `delivering`

Observación:

La IA puede devolver varios estados que el runtime no persiste ni procesa explícitamente.

### E. Estados documentados en SQL o comentarios, pero no alineados

En migración inicial se documenta:

- `cliente`
- `bot`
- `pendiente`

Observación:

`pendiente` no participa realmente en el flujo actual. Es un estado huérfano documental.

## Clasificación Por Tipo

### 1. Estados de conversación

No deben vivir en la misma columna que los estados de pedido:

- `cliente`
- `bot`
- `tienda`
- `repartidor`
- `sistema`

### 2. Estados reales de pedido hoy en producción lógica

- `collecting`
- `esperando_confirmacion`
- `awaiting_quote`
- `awaiting_confirm`
- `en_proceso`
- `repartidor_asignado`
- `en_camino`
- `llegado`
- `completado`
- `cancelado`

### 3. Estados legacy o ambiguos

- `awaiting_confirmation`
- `cotizando`
- `asignado`
- `entregado`
- `pendiente`

### 4. Estados fantasma potenciales emitibles por IA

- `lead`
- `ready_to_quote`
- `awaiting_quote_confirm`
- `confirmado`
- `delivering`

## Máquina De Estados Real Del Pedido Hoy

Este es el ciclo de vida real observado, con el punto exacto donde aparece cada estado.

### Etapa 0. Conversación previa y levantamiento del pedido

El cliente escribe.

Se generan filas de bitácora:

- `cliente`
- `bot`

Todavía puede no existir una orden real. En esta fase la IA conversa, califica productos, pide dirección y pide selección de tienda.

### Etapa 1. Reinicio explícito o recolección activa

Cuando el usuario pide reiniciar o crear un pedido nuevo, el flujo crea una orden con:

- `collecting`

Significado real:

- hay pedido abierto
- todavía faltan datos
- la conversación sigue recolectando productos, tienda o dirección

Observación:

`collecting` hoy es híbrido. A veces significa “pedido nuevo” y a veces solo “estado conversacional”.

### Etapa 2. Pedido estructurado y esperando confirmación del cliente

Cuando la IA llena `dispatch.business_message` y el sistema logra resolver el negocio en base de datos, se crea una orden con:

- `esperando_confirmacion`

Significado real:

- ya hay tienda candidata
- ya hay productos
- ya hay un resumen que el cliente debe aprobar
- todavía NO se ha enviado a la tienda

Consulta asociada:

El sistema también busca:

- `awaiting_confirmation`

Pero ese estado no se persiste ahí mismo; solo se usa como alias de consulta.

### Etapa 3. Pedido enviado a tienda para cotización

Cuando el cliente responde afirmativamente en la etapa anterior, se manda el pedido a la tienda y la orden pasa a:

- `awaiting_quote`

Significado real:

- pedido enviado a la tienda
- sistema esperando precio

### Etapa 4. Tienda responde precio, esperando confirmación final del cliente

Cuando la tienda responde `ORDEN #X PRECIO N`, la orden cambia a:

- `awaiting_confirm`

Significado real:

- ya existe precio final
- cliente debe aprobar total

### Etapa 5. Sistema notifica al repartidor antes de aceptación formal

Cuando el cliente confirma el total, el sistema notifica a un repartidor activo y marca la orden como:

- `en_proceso`

Significado real hoy:

- pedido ya fue enviado al repartidor
- pero el repartidor aún no necesariamente aceptó

Riesgo:

Este es uno de los puntos más frágiles del sistema. `en_proceso` sugiere que el repartidor ya está ejecutando el servicio, pero en realidad la aceptación todavía no está confirmada.

### Etapa 6. Repartidor acepta el servicio

Cuando el repartidor responde afirmativamente, la orden pasa a:

- `repartidor_asignado`

Significado real:

- repartidor aceptó
- cliente es notificado
- tienda puede ser notificada

Conflicto:

Semánticamente, este estado debería ocurrir antes de cualquier estado que implique “en proceso”.

### Etapa 7. Repartidor recogió pedido

Cuando el repartidor responde `YA RECOGÍ`, la orden pasa a:

- `en_camino`

Significado real:

- pedido recogido
- pedido va hacia el cliente

### Etapa 8. Repartidor llegó al domicilio

Cuando el repartidor responde `YA LLEGUÉ`, la orden pasa a:

- `llegado`

Significado real:

- repartidor está en el punto de entrega

### Etapa 9. Entrega cerrada

Cuando el repartidor responde `ENTREGADO`, la orden pasa a:

- `completado`

Significado real:

- ciclo cerrado

### Estado lateral. Cancelación

La orden puede pasar a:

- `cancelado`

Esto ocurre por reinicio, hard reset o cancelación de orden activa.

## Conflictos Detectados

### 1. Estados redundantes por idioma

Duplicidad clara:

- `esperando_confirmacion` vs `awaiting_confirmation`
- `cotizando` vs `awaiting_quote`
- `entregado` vs `completado`
- `asignado` vs `repartidor_asignado`

Riesgo:

Una consulta puede considerar una orden activa y otra consulta ignorarla, aunque conceptualmente hablen del mismo paso del flujo.

### 2. Estados redundantes por nivel de abstracción

Ejemplos:

- `en_proceso`
- `repartidor_asignado`

Problema:

`en_proceso` se usa antes de la aceptación formal del repartidor, mientras que `repartidor_asignado` aparece después. La cronología semántica está invertida.

### 3. Estados fantasma por desalineación entre IA y runtime

La IA puede emitir:

- `lead`
- `ready_to_quote`
- `awaiting_quote_confirm`
- `confirmado`
- `delivering`

Pero el backend no tiene transiciones oficiales ni queries robustas para esos valores.

Riesgo:

- órdenes guardadas con estados que nadie lee
- ramas muertas
- errores silenciosos
- decisiones de negocio tomadas sobre datos no canónicos

### 4. Estados fantasma documentales

Estados mencionados en SQL o helpers pero sin vida real estable:

- `pendiente`
- `cotizando`
- `asignado`
- `entregado`

Riesgo:

Si un desarrollador nuevo usa esos nombres por leer los archivos “equivocados”, introducirá inconsistencias nuevas.

### 5. Colisión entre “estado de mensaje” y “estado de orden”

El mismo campo `pedidos.estado` guarda:

- tipo de mensaje
- etapa del pedido

Riesgo:

El sistema tiene que estar excluyendo manualmente `cliente`, `bot`, `tienda`, `repartidor`, `sistema` en varias consultas para “adivinar” qué fila sí es una orden.

Esto es una fuente clásica de:

- pedidos invisibles
- resultados incompletos
- estados duplicados
- errores difíciles de reproducir

## Riesgos De Estado Fantasma Más Serios

Los estados con mayor probabilidad de producir comportamiento inconsistente son:

- `awaiting_confirmation`
  - se consulta, pero no es el nombre principal persistido

- `cotizando`
  - vive en helper y schema, pero no gobierna el flujo principal

- `asignado`
  - existe en `ordenes.ts`, pero el flujo real usa `repartidor_asignado`

- `entregado`
  - existe como helper, pero el flujo real cierra con `completado`

- `lead`
- `ready_to_quote`
- `awaiting_quote_confirm`
- `confirmado`
- `delivering`
  - la IA podría producirlos, pero el backend no está orquestado para reconocerlos como etapas oficiales

## Implicaciones Del Negocio Sobre La Máquina De Estados Futura

### Zona de servicio: Ixtlahuacán del Río

La validación geográfica debe entrar antes de enviar a tienda y antes de enviar a repartidor.

No debe modelarse como texto libre ni como simple mensaje conversacional.

Debe existir un estado canónico de rechazo de negocio:

- pedido fuera de zona
- pedido detenido por política territorial

### IA con mentalidad propia

La falta de inventario NO debe cambiar la orden a error técnico.

Debe manejarse como parte de la fase de construcción del pedido:

- sugerencia de sustitutos
- propuesta de marca equivalente
- propuesta de comercio alternativo dentro de Ixtlahuacán del Río

Conclusión:

La “inteligencia” no necesita más estados finales; necesita una fase robusta de recolección y reformulación dentro del pedido.

### Logística inteligente

El envío de Google Maps y datos del cliente no define un estado independiente.

Debe ser una acción obligatoria al entrar en la fase de asignación logística.

Conclusión:

El cambio de estado correcto debe disparar una validación:

- existe dirección legible
- existe link de Maps
- existe teléfono del cliente

Si faltan, el pedido no debería avanzar al repartidor.

## Propuesta Canónica De Estados

Esta propuesta busca un solo catálogo, en español, alineado al negocio real de Ixtlahuacán del Río y listo para producción.

### Regla base

Separar completamente:

- `tipo de mensaje`
- `estado de pedido`

Los mensajes ya no deben vivir como estados del pedido.

### Catálogo canónico propuesto para pedidos

- `capturando_pedido`
  - el sistema está recolectando productos, comercio, dirección y restricciones

- `rechazado_fuera_de_zona`
  - la dirección está fuera de Ixtlahuacán del Río

- `pendiente_confirmacion_cliente`
  - el sistema ya estructuró el pedido y espera validación del cliente antes de contactar a la tienda

- `pendiente_cotizacion_tienda`
  - el pedido ya fue enviado a la tienda y falta precio

- `pendiente_aprobacion_total`
  - la tienda respondió precio y el cliente debe aprobar total

- `pendiente_aceptacion_repartidor`
  - el pedido ya fue enviado al repartidor con Maps y contacto, pero aún no acepta

- `repartidor_confirmado`
  - el repartidor aceptó el servicio

- `pedido_recogido`
  - el repartidor ya recogió el pedido del negocio

- `repartidor_en_destino`
  - el repartidor ya llegó con el cliente

- `entregado`
  - el pedido fue completado con éxito

- `cancelado`
  - el pedido fue cancelado por usuario, sistema o negocio

- `bloqueado_operativamente`
  - estado de contingencia para casos reales donde faltan datos logísticos obligatorios o hay inconsistencia grave recuperable sin perder trazabilidad

## Mapeo Del Estado Actual Hacia El Catálogo Canónico

- `collecting` -> `capturando_pedido`
- `esperando_confirmacion` -> `pendiente_confirmacion_cliente`
- `awaiting_confirmation` -> `pendiente_confirmacion_cliente`
- `awaiting_quote` -> `pendiente_cotizacion_tienda`
- `awaiting_confirm` -> `pendiente_aprobacion_total`
- `en_proceso` -> `pendiente_aceptacion_repartidor`
- `repartidor_asignado` -> `repartidor_confirmado`
- `en_camino` -> `pedido_recogido`
- `llegado` -> `repartidor_en_destino`
- `completado` -> `entregado`
- `cancelado` -> `cancelado`
- `cotizando` -> `pendiente_cotizacion_tienda`
- `asignado` -> `repartidor_confirmado`
- `entregado` -> `entregado`

## Recomendaciones Arquitectónicas Para La Fase 2

### Prioridad 1

Congelar un solo catálogo oficial de estados y prohibir nuevos aliases.

### Prioridad 2

Separar `messages` de `orders`. Aunque todavía no se implemente, debe quedar definido como decisión arquitectónica.

### Prioridad 3

Definir transiciones válidas estrictas:

- no se puede pasar a repartidor sin dirección válida
- no se puede pasar a tienda si no hay negocio seleccionado
- no se puede salir de `rechazado_fuera_de_zona` salvo reinicio o nueva dirección

### Prioridad 4

Hacer que la IA solo pueda emitir estados pertenecientes al catálogo canónico.

### Prioridad 5

Definir side effects por transición, no por heurísticas sueltas:

- al entrar en `pendiente_cotizacion_tienda`, se envía mensaje a tienda
- al entrar en `pendiente_aceptacion_repartidor`, se valida Maps + contacto y se envía notificación
- al entrar en `repartidor_confirmado`, se notifica al cliente

## Conclusión Ejecutiva

El sistema actual no falla solo por tener muchos estados; falla porque mezcla:

- estados de mensaje
- estados de orden
- nombres en 2 idiomas
- aliases legacy
- estados emitibles por IA que no gobiernan el runtime

La Fase 2 debe convertir esta ambigüedad en un contrato único.

Sin ese contrato, cualquier refactor volverá a romper el flujo de pedidos.
