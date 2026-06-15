# Diagnóstico Inicial Mándalo - Fase 1

Fecha: 2026-06-08

## Objetivo

Mapear la estructura actual del proyecto, identificar zonas de conflicto y proponer un orden de trabajo para estabilizar el flujo de pedidos sin modificar código.

## Mapa actual del proyecto

### App y API

- `mandalo/src/app/api/webhook/route.ts`
  - Único endpoint operativo.
  - Normaliza payload de WhatsApp y delega todo a `processMandaloWebhook`.

### Núcleo de negocio

- `mandalo/src/lib/mandaloFlow.ts`
  - Archivo central del sistema.
  - Contiene:
    - parsing de entrada
    - construcción de contexto para IA
    - lectura y escritura a Supabase
    - orquestación de estados
    - envío a tienda
    - envío a repartidor
    - respuestas al cliente
    - lógica de fallback
    - heurísticas conversacionales
    - recuperación de dirección y items
    - control de sesión en memoria

- `mandalo/src/lib/ordenes.ts`
  - Helpers CRUD mínimos sobre `pedidos`.
  - La abstracción es débil porque realmente depende de la estructura ambigua de `pedidos`.

- `mandalo/src/lib/roles.ts`
  - Detecta actor por teléfono usando Supabase.
  - Tiene caché en memoria de 60 segundos.

### Infraestructura

- `mandalo/src/lib/supabaseAdmin.ts`
  - Cliente admin con service role.

- `mandalo/src/lib/env.ts`
  - Validación lazy de variables de entorno.

- `mandalo/src/lib/openaiClient.ts`
  - Cliente OpenAI singleton.

- `mandalo/src/lib/ultramsg.ts`
  - Integración de salida a WhatsApp por UltraMsg.

### IA

- `mandalo/src/lib/mandaloPrompt.ts`
  - Prompt del sistema.

- `mandalo/src/lib/llmResponseSchema.ts`
  - Contrato esperado de respuesta LLM.

### Base de datos

- `mandalo/supabase/migrations/20260514_init.sql`
  - Crea `negocios`, `repartidores`, `pedidos`.

- `mandalo/supabase/migrations/20260514_roles_y_ordenes.sql`
  - Solo agrega índice sobre `pedidos.estado`.

## Hallazgos críticos

### 1. El sistema tiene un "God File"

`mandaloFlow.ts` concentra demasiadas responsabilidades. Esto provoca:

- alto acoplamiento
- refactors peligrosos
- dificultad para probar por partes
- mezcla de reglas de negocio con detalles técnicos
- rutas de ejecución difíciles de razonar

Conclusión:

Un cambio pequeño en actor, estado, IA o DB puede romper múltiples ramas del flujo.

### 2. La tabla `pedidos` está sobrecargada

Hoy `pedidos` funciona simultáneamente como:

- bitácora de mensajes cliente/bot/tienda/repartidor
- máquina de estados del pedido
- almacenamiento de snapshot JSON del pedido
- cola implícita de trabajo

Eso vuelve ambiguo el significado de cada fila.

Ejemplos observados:

- estados de chat: `cliente`, `bot`, `tienda`, `repartidor`, `sistema`
- estados de pedido: `collecting`, `esperando_confirmacion`, `awaiting_quote`, `awaiting_confirm`, `en_proceso`, `repartidor_asignado`, `llegado`, `completado`, `cancelado`

Riesgo:

Las consultas filtran por texto de `estado` para distinguir mensajes vs pedidos. Si alguien agrega, renombra o mezcla estados, rompe detección de pendientes, historial o transiciones.

### 3. Inconsistencia severa de estados

Conviven nombres en español e inglés para el mismo proceso.

Ejemplos:

- `esperando_confirmacion` vs `awaiting_confirmation`
- `awaiting_confirm`
- `awaiting_quote`
- `en_proceso`
- `repartidor_asignado`
- `completado`

Riesgo:

- consultas que no encuentran la fila correcta
- dobles transiciones
- pedidos "fantasma"
- ramas muertas o medias activas

### 4. Dependencia excesiva de JSON embebido en `detalle_pedido`

El campo `detalle_pedido` se usa para:

- texto plano
- resumen del pedido
- mensaje de chat
- JSON serializado del estado de la orden
- dirección detectada

Riesgo:

- parsing frágil
- imposibilidad de validar esquema en DB
- consultas SQL pobres
- errores silenciosos si el JSON cambia o viene incompleto

### 5. Uso de memoria efímera como soporte funcional

`sessionFlags` en memoria se usa para controlar comportamiento de conversación.

Riesgo:

- en serverless no hay persistencia garantizada
- el sistema se comporta distinto entre reinicios
- se producen bucles intermitentes difíciles de reproducir

### 6. Fallbacks agresivos enmascaran problemas reales

Hay varios patrones tipo:

- probar tablas con nombres alternativos: `El repartidor`, `el repartidor`, `repartidores`, `repartidor`
- seguir operando aunque el parseo de IA falle
- hacer fallback por últimos 10 dígitos
- intentar actualizar columnas que quizá no existan

Riesgo:

- el sistema "parece funcionar" pero en realidad está corrigiendo una arquitectura inconsistente
- se esconden errores estructurales de datos
- aumenta la entropía técnica

### 7. Hay datos de negocio hardcodeados

Se encontraron textos fijos como:

- `Abarrotes Agua Santa`
- `Dani`

Riesgo:

- comportamientos incorrectos al cambiar de tienda o repartidor
- mensajes engañosos al cliente
- imposibilidad de escalar multi-negocio

### 8. Calidad estática baja aunque el build compila

Resultado observado:

- `npm run build`: compila bien
- `npm run lint`: falla con 90 errores y 1 warning

Interpretación:

El proyecto "corre", pero no está sano para una evolución segura. Compilar no equivale a estar listo para producción.

### 9. Estado Git inmaduro

`git status --short` muestra gran parte del proyecto como `A`, `AM` o `??`.

Riesgo:

- no hay línea base confiable
- rollback difícil
- auditoría de cambios casi imposible

## Diagnóstico de Supabase

### Lo bueno

- esquema mínimo simple
- índices básicos presentes en `whatsapp`, `activo`, `telefono_cliente`, `estado`

### Lo peligroso

- `pedidos` no modela adecuadamente una orden real
- no hay separación entre conversación y pedido
- `estado` es texto libre sin catálogo
- `detalle_pedido` es texto libre para múltiples propósitos
- no se observan constraints de dominio
- no se observan foreign keys entre pedido, negocio y repartidor
- no se observan triggers o validaciones de transición
- no se observan tablas de eventos o timeline

### Conclusión de Supabase

La base actual permite iterar rápido, pero no soporta estabilidad de producción. El principal origen de inestabilidad no parece ser Supabase como plataforma, sino el modelo de datos demasiado ambiguo.

## Zonas de conflicto

### Zona Roja - tocar al final de la preparación, primero aislar

- `mandalo/src/lib/mandaloFlow.ts`
- `public.pedidos`

### Zona Naranja - estabilizar antes de refactor pesado

- `mandalo/src/lib/roles.ts`
- `mandalo/src/lib/ordenes.ts`
- `mandalo/src/lib/mandaloPrompt.ts`
- `mandalo/src/lib/llmResponseSchema.ts`

### Zona Amarilla - infraestructura relativamente sana

- `mandalo/src/lib/env.ts`
- `mandalo/src/lib/openaiClient.ts`
- `mandalo/src/lib/supabaseAdmin.ts`
- `mandalo/src/lib/ultramsg.ts`
- `mandalo/src/app/api/webhook/route.ts`

## Orden de trabajo recomendado

### Fase 1 - Congelar contrato actual

Objetivo:

Definir el flujo real vigente antes de mover piezas.

Acciones:

- inventariar todos los estados actuales de `pedidos.estado`
- listar todas las consultas SQL que dependen de esos estados
- dibujar la máquina de estados real cliente -> tienda -> cliente -> repartidor -> cliente
- identificar qué ramas ya no se usan

### Fase 2 - Separar responsabilidades conceptualmente

Objetivo:

Diseñar el nuevo modelo sin tocar aún el runtime.

Acciones:

- separar conversación de pedido
- definir entidad `orders`
- definir entidad `messages`
- definir entidad `order_events`
- definir catálogo único de estados

### Fase 3 - Crear capa de dominio

Objetivo:

Sacar lógica de negocio de `mandaloFlow.ts`.

Acciones:

- crear router por actor
- crear state machine de órdenes
- encapsular repositorios Supabase
- encapsular servicios externos OpenAI y UltraMsg

### Fase 4 - Quitar hardcodes y fallbacks tóxicos

Objetivo:

Eliminar comportamiento impredecible.

Acciones:

- remover nombres fijos de tienda y repartidor
- usar tablas únicas y nombres canónicos
- centralizar normalización telefónica
- eliminar lógica que prueba múltiples nombres de tabla

### Fase 5 - Endurecer la base de datos

Objetivo:

Convertir la DB en guardián de integridad.

Acciones:

- tablas nuevas o refactor controlado
- foreign keys
- constraints de estado
- índices por patrones reales de consulta
- migración de datos

### Fase 6 - Observabilidad y pruebas

Objetivo:

Detectar antes de romper.

Acciones:

- logging estructurado por `order_id`
- pruebas unitarias de transiciones
- pruebas de integración para webhook
- fixtures para tienda, cliente y repartidor

## Primera prioridad absoluta

Antes de cualquier mejora funcional o "inteligencia" del asistente:

1. Congelar y normalizar la máquina de estados.
2. Separar chat de pedido en el modelo de datos.
3. Desarmar `mandaloFlow.ts` en módulos pequeños.

Si eso no se hace primero, cualquier mejora de IA, inventario o cotización seguirá rompiendo partes del sistema.

## Mensaje listo para el chat de ejecución

Copia y pega esto en tu entorno de ejecución cuando quieran arrancar la siguiente fase:

```text
Quiero que trabajes en modo cirujano y sin improvisar. NO agregues funciones nuevas todavía. Primero analiza el proyecto y prepara una refactorización segura del flujo de pedidos.

Objetivo inmediato:
1. Inventaria todos los estados usados en `src/lib/mandaloFlow.ts`, `src/lib/ordenes.ts` y consultas a Supabase.
2. Enumera cada transición real del pedido: cliente -> tienda -> cliente -> repartidor -> entrega.
3. Detecta estados duplicados o equivalentes en español/inglés.
4. Señala consultas que hoy dependen de `pedidos.estado` para distinguir mensajes de chat vs pedidos reales.
5. No modifiques aún Supabase ni el comportamiento productivo.

Entregable:
- un reporte técnico con:
  - catálogo actual de estados
  - transiciones válidas
  - inconsistencias
  - propuesta de estado canónico único
  - lista de archivos a refactorizar en orden

Restricción:
- no borres nada
- no cambies nombres todavía
- no hagas refactor masivo todavía
- primero documenta, luego propones el parche exacto
```
