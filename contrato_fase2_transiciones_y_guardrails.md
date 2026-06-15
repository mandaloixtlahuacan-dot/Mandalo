# Contrato De Comportamiento - Fase 2

## Diseño De Transiciones Válidas Y Matriz De Reglas Por Estado

Fecha: 2026-06-08

## Objetivo

Definir la lógica de control oficial de Mándalo para la Fase 3 de ejecución:

- transiciones válidas
- guardrails obligatorios
- manejo de faltantes dentro de `capturando_pedido`
- prevención de transiciones ilegales que hoy generan inestabilidad

Este documento asume como aprobado el catálogo canónico de estados definido en Fase 1.

## Catálogo Canónico A Controlar

- `capturando_pedido`
- `rechazado_fuera_de_zona`
- `pendiente_confirmacion_cliente`
- `pendiente_cotizacion_tienda`
- `pendiente_aprobacion_total`
- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`
- `cancelado`
- `bloqueado_operativamente`

## Principios Rectores

### 1. Ningún estado se cambia por intuición

Toda transición debe dispararse por:

- evento claro
- validaciones aprobadas
- side effects definidos

### 2. La IA conversa, pero no rompe el flujo

La IA puede:

- preguntar
- completar contexto
- sugerir sustitutos
- proponer negocio alternativo

La IA no puede:

- saltarse validaciones
- inventar confirmaciones
- mover el pedido a logística sin datos obligatorios

### 3. Ixtlahuacán del Río es una restricción estructural

La zona de servicio no es un detalle de copy. Es una regla de control.

### 4. Side effects y estado no son lo mismo

Ejemplo:

- mandar Google Maps al repartidor no es un estado
- es un side effect obligatorio al entrar en `pendiente_aceptacion_repartidor`

## Eventos Del Dominio

Para controlar transiciones, conviene pensar en eventos de negocio, no en mensajes libres:

- `pedido_iniciado`
- `direccion_capturada`
- `direccion_fuera_de_zona`
- `direccion_dentro_de_zona`
- `negocio_seleccionado`
- `pedido_calificado`
- `cliente_confirma_resumen`
- `cliente_rechaza_resumen`
- `tienda_cotiza`
- `cliente_confirma_total`
- `cliente_rechaza_total`
- `repartidor_notificado`
- `repartidor_acepta`
- `repartidor_recoge`
- `repartidor_llega`
- `repartidor_entrega`
- `cancelacion_solicitada`
- `falla_operativa_recuperable`

## Matriz De Transiciones Válidas

### `capturando_pedido`

Puede transicionar a:

- `capturando_pedido`
- `rechazado_fuera_de_zona`
- `pendiente_confirmacion_cliente`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `pendiente_cotizacion_tienda`
- `pendiente_aprobacion_total`
- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`

### `rechazado_fuera_de_zona`

Puede transicionar a:

- `capturando_pedido`
- `cancelado`

No puede transicionar directamente a:

- cualquier fase comercial o logística

Condición de salida:

- el cliente proporciona una nueva dirección
- la nueva dirección es validada dentro de Ixtlahuacán del Río

### `pendiente_confirmacion_cliente`

Puede transicionar a:

- `capturando_pedido`
- `pendiente_cotizacion_tienda`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `pendiente_aprobacion_total`
- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `entregado`

### `pendiente_cotizacion_tienda`

Puede transicionar a:

- `pendiente_aprobacion_total`
- `capturando_pedido`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `pedido_recogido`
- `entregado`

### `pendiente_aprobacion_total`

Puede transicionar a:

- `capturando_pedido`
- `pendiente_aceptacion_repartidor`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `repartidor_confirmado`
- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`

### `pendiente_aceptacion_repartidor`

Puede transicionar a:

- `repartidor_confirmado`
- `pendiente_aprobacion_total`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`

### `repartidor_confirmado`

Puede transicionar a:

- `pedido_recogido`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `capturando_pedido`
- `pendiente_cotizacion_tienda`
- `entregado`

### `pedido_recogido`

Puede transicionar a:

- `repartidor_en_destino`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `capturando_pedido`
- `pendiente_aprobacion_total`

### `repartidor_en_destino`

Puede transicionar a:

- `entregado`
- `cancelado`
- `bloqueado_operativamente`

No puede transicionar directamente a:

- `capturando_pedido`
- `pendiente_cotizacion_tienda`

### `entregado`

Puede transicionar a:

- ninguno

Es estado terminal.

### `cancelado`

Puede transicionar a:

- ninguno

Es estado terminal.

### `bloqueado_operativamente`

Puede transicionar a:

- `capturando_pedido`
- `pendiente_confirmacion_cliente`
- `pendiente_cotizacion_tienda`
- `pendiente_aprobacion_total`
- `pendiente_aceptacion_repartidor`
- `cancelado`

Regla:

Solo puede salir con intervención explícita del sistema o recuperación validada, nunca por mensaje ambiguo.

## Matriz De Guardrails Por Transición

## Desde `capturando_pedido`

### `capturando_pedido -> rechazado_fuera_de_zona`

Validaciones obligatorias:

- existe dirección o referencia territorial suficiente
- la dirección fue evaluada contra la zona oficial de servicio
- la evaluación dio resultado fuera de Ixtlahuacán del Río

Side effects:

- informar al cliente que Mándalo solo opera en Ixtlahuacán del Río
- pedir nueva dirección solo si el usuario desea corregir

### `capturando_pedido -> pendiente_confirmacion_cliente`

Validaciones obligatorias:

- existe al menos 1 producto válido
- cada producto tiene detalle suficiente para compra
- existe negocio seleccionado y resoluble en base de datos
- existe dirección dentro de Ixtlahuacán del Río
- no existe conflicto de datos críticos
- el pedido quedó “limpio”, es decir:
  - sin ambigüedad de marca o presentación crítica
  - sin tienda indefinida
  - sin dirección incompleta

Side effects:

- construir resumen canónico para cliente
- congelar snapshot del pedido
- solicitar confirmación explícita del resumen

### `capturando_pedido -> cancelado`

Validaciones obligatorias:

- intención clara del cliente de cancelar o reiniciar

Side effects:

- cerrar orden actual
- evitar reutilizar contexto ambiguo en la siguiente conversación

### `capturando_pedido -> bloqueado_operativamente`

Validaciones obligatorias:

- inconsistencia técnica recuperable

Ejemplos:

- negocio seleccionado ya no existe en DB
- snapshot corrupto
- conflicto de múltiples órdenes activas

## Desde `rechazado_fuera_de_zona`

### `rechazado_fuera_de_zona -> capturando_pedido`

Validaciones obligatorias:

- nueva dirección capturada
- dirección revalidada dentro de Ixtlahuacán del Río

## Desde `pendiente_confirmacion_cliente`

### `pendiente_confirmacion_cliente -> pendiente_cotizacion_tienda`

Validaciones obligatorias:

- confirmación explícita del cliente
- negocio con WhatsApp resoluble
- dirección dentro de zona
- items congelados y no vacíos
- resumen no corrupto

Side effects:

- enviar pedido a tienda
- registrar timestamp de envío
- registrar negocio destinatario

### `pendiente_confirmacion_cliente -> capturando_pedido`

Validaciones obligatorias:

- el cliente corrige productos, dirección o negocio

Side effects:

- invalidar snapshot previo
- regresar a recolección sin perder trazabilidad

## Desde `pendiente_cotizacion_tienda`

### `pendiente_cotizacion_tienda -> pendiente_aprobacion_total`

Validaciones obligatorias:

- la cotización proviene de la tienda correcta o de una tienda identificable
- existe `order_id` inequívoco
- existe precio válido numérico mayor a 0
- el pedido sigue vigente y no fue cancelado

Side effects:

- calcular total final
- persistir desglose tienda + envío + comisión
- pedir confirmación explícita del total al cliente

### `pendiente_cotizacion_tienda -> capturando_pedido`

Validaciones obligatorias:

- el cliente pide modificar el pedido antes de aprobar cotización

Regla:

El regreso a `capturando_pedido` debe invalidar la cotización previa.

## Desde `pendiente_aprobacion_total`

### `pendiente_aprobacion_total -> pendiente_aceptacion_repartidor`

Validaciones obligatorias:

- confirmación explícita del cliente
- existe teléfono del cliente
- existe dirección legible
- existe link de Google Maps derivado de la dirección
- existe repartidor activo seleccionable
- el pedido tiene items válidos y no vacíos
- el total fue persistido
- la dirección sigue dentro de Ixtlahuacán del Río

Side effects:

- seleccionar repartidor
- enviar al repartidor:
  - nombre del cliente
  - teléfono del cliente
  - dirección
  - link de Google Maps
  - detalle del pedido
  - total si aplica
- registrar timestamp de notificación al repartidor

### `pendiente_aprobacion_total -> capturando_pedido`

Validaciones obligatorias:

- el cliente rechaza el total o pide cambiar pedido

Regla:

Si cambia el pedido, la cotización previa deja de ser válida.

## Desde `pendiente_aceptacion_repartidor`

### `pendiente_aceptacion_repartidor -> repartidor_confirmado`

Validaciones obligatorias:

- aceptación explícita del repartidor
- el repartidor que responde coincide con el repartidor notificado
- la orden sigue abierta

Side effects:

- notificar al cliente
- notificar a tienda si corresponde
- sellar asignación logística

### `pendiente_aceptacion_repartidor -> pendiente_aprobacion_total`

Validaciones obligatorias:

- no hay repartidor disponible o el repartidor rechaza

Regla:

Este rollback debe existir para evitar pedidos atrapados.

## Desde `repartidor_confirmado`

### `repartidor_confirmado -> pedido_recogido`

Validaciones obligatorias:

- el mismo repartidor asignado reporta recogida
- el mensaje está ligado a la orden correcta

Side effects:

- notificar al cliente que el pedido ya fue recogido

## Desde `pedido_recogido`

### `pedido_recogido -> repartidor_en_destino`

Validaciones obligatorias:

- el mismo repartidor asignado reporta llegada
- la orden sigue abierta

Side effects:

- notificar al cliente que el repartidor está en destino

## Desde `repartidor_en_destino`

### `repartidor_en_destino -> entregado`

Validaciones obligatorias:

- el mismo repartidor asignado reporta entrega

Side effects:

- cerrar orden
- notificar al cliente

## Reglas Globales Innegociables

Estas reglas aplican en cualquier etapa:

### Regla 1. No se permiten saltos terminales

Nunca:

- `capturando_pedido -> entregado`
- `pendiente_confirmacion_cliente -> entregado`
- `pendiente_cotizacion_tienda -> entregado`

### Regla 2. No se avanza a logística sin dirección válida

Para cualquier transición hacia:

- `pendiente_aceptacion_repartidor`
- `repartidor_confirmado`
- `pedido_recogido`
- `repartidor_en_destino`
- `entregado`

Debe existir:

- dirección legible
- dirección dentro de Ixtlahuacán del Río
- Google Maps generable
- teléfono del cliente

### Regla 3. No se avanza a tienda sin negocio válido

Para pasar a `pendiente_cotizacion_tienda`:

- negocio seleccionado
- negocio existente en base de datos
- canal de contacto válido

### Regla 4. No se avanza con pedido ambiguo

No se puede salir de `capturando_pedido` si:

- faltan cantidades relevantes
- falta presentación o tamaño en productos sensibles
- no está claro qué tienda atenderá
- la dirección no es usable

### Regla 5. Los side effects deben ser idempotentes

No reenviar:

- a tienda
- a repartidor
- al cliente

si la transición ya fue registrada.

## Gestión De Faltantes Dentro De `capturando_pedido`

La “mentalidad propia” de la IA vive aquí, y solo aquí.

## Objetivo De La IA En Esta Etapa

Convertir una intención de compra ambigua en un pedido limpio y ejecutable.

## La IA sí puede hacer

- pedir aclaración de marca, tamaño o cantidad
- proponer sustitutos compatibles
- sugerir marcas populares
- sugerir negocio adecuado dentro de Ixtlahuacán del Río
- consolidar items dispersos en una lista estructurada
- reconducir una petición vaga a una compra concreta

Ejemplos permitidos:

- “No encuentro Coca de 2L, te ofrezco Pepsi 2L o Coca de 600 ml”
- “Si esa taquería no tiene gringa, puedo sugerirte tacos al pastor o quesadilla”
- “No me dijiste en qué tienda quieres comprarlo; puedo pedírtelo en un abarrotes disponible de Ixtlahuacán”

## La IA no puede hacer

- asumir dirección no confirmada
- inventar disponibilidad real
- inventar un negocio inexistente en DB
- avanzar a confirmación si el pedido sigue ambiguo
- mandar a cotizar “por probar”

## Criterio De Pedido Limpio

Un pedido está limpio solo si cumple todo:

- al menos un item válido
- cantidades suficientes o razonables
- detalles comerciales suficientes
- dirección dentro de zona
- negocio seleccionado y válido
- sin contradicciones internas

Mientras falte cualquiera de esos puntos, el estado sigue siendo:

- `capturando_pedido`

## Estrategia De Conversación Recomendada Para La IA

Orden de prioridad:

1. detectar intención principal
2. estructurar lista de productos
3. cerrar ambigüedades críticas
4. validar dirección y zona
5. resolver negocio
6. preparar resumen final

Regla:

Una sola pregunta clara a la vez cuando haya bloqueo crítico.

## Prevención De Crasheos

## Transiciones Ilegales Que Hoy El Código Permite

### 1. Se notifica al repartidor antes de que exista aceptación logística real

Comportamiento actual:

- después de `awaiting_confirm`, al confirmar el cliente, el sistema manda mensaje al repartidor
- inmediatamente marca la orden como `en_proceso`
- luego espera que el repartidor diga “sí” y recién después pone `repartidor_asignado`

Problema:

- la cronología está invertida
- `en_proceso` significa algo más avanzado que `repartidor_asignado`

Contrato correcto:

- `pendiente_aprobacion_total -> pendiente_aceptacion_repartidor -> repartidor_confirmado`

No:

- `pendiente_aprobacion_total -> en_proceso -> repartidor_asignado`

### 2. El repartidor puede operar sobre una orden incorrecta si no manda `ORDEN #id`

Comportamiento actual:

- si el repartidor no manda `ORDEN #id`, el sistema toma la última orden en curso
- incluso busca entre estados mezclados como `repartidor_asignado`, `en_camino`, `llegado`, `awaiting_confirm`, `awaiting_quote`

Problema:

- un mensaje de un repartidor puede afectar la orden equivocada
- puede mover una orden no asignada o aún no lista

Contrato correcto:

- ningún update de repartidor debe ocurrir sin `order_id` inequívoco o vínculo formal con orden asignada

### 3. El flujo logístico puede avanzar sin Maps obligatorio

Comportamiento actual:

- el link de Maps se arma si hay dirección
- si no hay dirección, igual se notifica al repartidor con “(sin dirección)”

Problema:

- el sistema entra a logística con información incompleta

Contrato correcto:

- sin dirección válida y Maps generable, no se entra a `pendiente_aceptacion_repartidor`

### 4. La transición a tienda puede ocurrir con snapshot ambiguo

Comportamiento actual:

- cuando la IA devuelve `dispatch.business_message`, se crea orden en `esperando_confirmacion`
- se usa `address_text` si existe, o dirección guardada previa

Problema:

- podría reciclarse dirección antigua sin validación fuerte
- el resumen puede quedar semánticamente mezclado con contexto viejo

Contrato correcto:

- el snapshot que pasa a confirmación debe estar ligado al pedido actual, no a recuperación oportunista de conversaciones anteriores

### 5. La aceptación del repartidor no valida estrictamente que él sea el asignado

Comportamiento actual:

- el sistema intenta identificar al repartidor por teléfono
- pero el fallback de orden puede tomar cualquier orden “en curso”

Problema:

- un repartidor puede aceptar o mover una orden que no le correspondía

Contrato correcto:

- la orden debe tener un repartidor destinatario ya registrado
- solo ese repartidor puede confirmar recogida, llegada o entrega

### 6. El sistema usa estados mixed-language y legacy en consultas activas

Comportamiento actual:

- consulta `esperando_confirmacion` y `awaiting_confirmation`
- helpers usan `cotizando`, `asignado`, `entregado`
- runtime usa `awaiting_quote`, `awaiting_confirm`, `completado`

Problema:

- una orden puede existir, pero no ser considerada por otra parte del sistema

Contrato correcto:

- un solo nombre oficial por etapa

### 7. El sistema mezcla mensajes de chat con órdenes en el mismo campo de estado

Comportamiento actual:

- para encontrar órdenes activas se excluyen manualmente `cliente`, `bot`, `tienda`, `repartidor`, `sistema`

Problema:

- esta estrategia permite errores de clasificación
- puede ocultar órdenes o tomar mensajes como si fueran entidades de flujo

Contrato correcto:

- mensajes y órdenes deben separarse conceptualmente y luego físicamente

### 8. La validación territorial de Ixtlahuacán del Río no bloquea formalmente el flujo

Comportamiento actual:

- la dirección puede influir en el mensaje, pero no existe estado formal de rechazo por zona

Problema:

- el pedido puede seguir vivo aunque la dirección no sea servible

Contrato correcto:

- toda dirección fuera de zona mueve la orden a `rechazado_fuera_de_zona`

## Reglas De Recuperación

Para evitar órdenes muertas:

### Caso 1. Falla de snapshot o items vacíos

Transición:

- `pendiente_aprobacion_total -> bloqueado_operativamente`

No debe:

- quedarse en silencio
- intentar logística incompleta

### Caso 2. No hay repartidor activo

Transición recomendada:

- mantener `pendiente_aprobacion_total` o pasar a `bloqueado_operativamente`

Pero nunca:

- marcar como si ya estuviera en proceso logístico

### Caso 3. Negocio no resoluble

Transición:

- volver a `capturando_pedido`

Con mensaje:

- pedir selección válida de negocio

## Matriz Resumida Para Ejecución

- `capturando_pedido` -> `pendiente_confirmacion_cliente`
  - requiere pedido limpio, negocio válido, dirección válida dentro de zona

- `capturando_pedido` -> `rechazado_fuera_de_zona`
  - requiere dirección fuera de Ixtlahuacán

- `pendiente_confirmacion_cliente` -> `pendiente_cotizacion_tienda`
  - requiere confirmación del cliente y snapshot íntegro

- `pendiente_cotizacion_tienda` -> `pendiente_aprobacion_total`
  - requiere cotización válida de la tienda correcta

- `pendiente_aprobacion_total` -> `pendiente_aceptacion_repartidor`
  - requiere confirmación del cliente, dirección válida, Maps, teléfono y repartidor disponible

- `pendiente_aceptacion_repartidor` -> `repartidor_confirmado`
  - requiere aceptación explícita del repartidor asignado

- `repartidor_confirmado` -> `pedido_recogido`
  - requiere confirmación de recogida del repartidor asignado

- `pedido_recogido` -> `repartidor_en_destino`
  - requiere confirmación de llegada del repartidor asignado

- `repartidor_en_destino` -> `entregado`
  - requiere confirmación de entrega del repartidor asignado

## Conclusión Ejecutiva

La Fase 3 no debe limitarse a “refactorizar código”.

Debe implementar un sistema donde:

- cada estado tenga significado único
- cada transición tenga precondiciones obligatorias
- la IA ayude dentro de `capturando_pedido` sin mover el flujo ilegalmente
- la logística solo se active con datos completos
- las rutas ilegales actuales queden explícitamente bloqueadas

Este documento constituye el contrato de comportamiento base para la ejecución segura de la reingeniería.
