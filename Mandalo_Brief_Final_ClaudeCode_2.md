# Mándalo — Brief final para Claude Code
Documento único y definitivo. Reemplaza y consolida todo lo discutido antes. Está escrito para que Claude Code lo lea una vez y se ponga a construir sin tener que preguntar nada de negocio — todas las decisiones ya están tomadas.

---

## 0. Modo de trabajo (léelo primero, Claude Code)

- Todas las reglas de negocio y casos límite de este documento ya están **decididos y autorizados**. No se pregunta nada de negocio — se implementa.
- Trabaja en una rama de feature, no en `main`. Avanza por pasos, pero sin pausar a pedir confirmación de diseño — solo pausa si encuentras una contradicción real entre este documento y el código existente.
- **Cambios de código:** autónomo, sin pedir aprobación línea por línea.
- **Cambios de base de datos (Supabase):** no los ejecutes tú directo contra producción. Genera el SQL como archivo versionado (con verificación previa de qué va a tocar, como ya quedó establecido en `.claude/skills/mandalo-ops-safety/SKILL.md`), y el dueño del proyecto lo corre él mismo en el SQL Editor. Esto no es falta de confianza — es la misma regla que ya se estableció después del incidente de producción anterior, y sigue aplicando.
- **`git push` a `main`:** siempre lo hace el dueño del proyecto manualmente, nunca Claude Code, tal como ya está en el Skill de seguridad.
- Cuando termines un bloque de trabajo, dejas el resumen de qué cambiaste y qué falta — no te detienes a preguntar "¿procedo?".

---

## 1. Qué es Mándalo

Sistema de delivery por WhatsApp para Ixtlahuacán del Río, Jalisco (pueblo pequeño). Un solo número de WhatsApp atiende tres roles según el teléfono que escribe: **cliente**, **tienda**, **repartidor**. No hay app — todo es conversación de WhatsApp.

## 2. Personalidad del bot ("superagente" de pueblo, no chatbot genérico)

El bot se comporta como el encargado de confianza de una tienda de pueblo: cálido y directo con el cliente, operativo y al grano con la tienda, breve y accionable con el repartidor. Nunca suena a IA genérica.

**Reglas de estilo para el prompt:**
- Frases cortas, una idea por mensaje. Nunca párrafos largos.
- Cero muletillas de IA ("¡Como asistente virtual...!", exceso de exclamaciones/emoji).
- Resúmenes (pedido, dirección, precio) en formato de lista corta, como un recibo — nunca prosa corrida.
- Nunca menciona ser un modelo de lenguaje ni explica limitaciones técnicas; si algo falla, se disculpa en tono humano y ofrece una salida.
- **Conocimiento de mercado mexicano:** reconoce sinónimos regionales (refresco/refa/coca, garrafón/bidón, tortilla de harina vs. maíz), marcas comunes de abarrote (Bimbo, Lala, Coca-Cola, Barcel, La Costeña, Jumex, etc.) y unidades típicas (kilo, litro, paquete, pieza) — para saber qué preguntar cuando falta un dato, sin inventar el dato.
- Ejemplo de tono correcto: *"Buenas tardes, soy Mándalo. ¿Qué se te antoja hoy — mandado de tienda o comida preparada?"*

## 3. Reglas de negocio (definitivas)

| Regla | Valor |
|---|---|
| Cobertura | Radio de 1.5 km desde centro (20.865831, -103.240017), validado por GPS (Haversine). Fuera del radio = **rechazo automático**. |
| Precio | Subtotal de tienda(s) + $20 fijo (Mándalo) + $35 repartidor (+$15 por tienda adicional si aplica) |
| Pago | Solo efectivo, contra entrega al repartidor |
| Identidad de cliente | Solo por número de WhatsApp. Nunca se pide nombre. |
| Historial | No se guarda nada del cliente entre pedidos — al cerrar un pedido, el chat se reinicia por completo |
| Cancelación | Gratuita solo **antes de que la tienda confirme el precio**. Después de eso, ya no se puede cancelar sin problema. |
| Horario de Mándalo | 8:00am – 8:00pm. Fuera de ese rango: se le dice al cliente que está cerrado y se informa el horario. |
| Horario de tienda/repartidor | Cada uno tiene su propio horario en base de datos, validado por el bot antes de asignar. |
| Alta de tiendas/repartidores | Manual, la hace el dueño del proyecto directamente en la base de datos (no hay autoregistro por ahora). |
| Timeouts | Unificados a **10 minutos** en los tres casos: tienda sin responder cotización, cliente sin confirmar precio final, ningún repartidor acepta el pedido. Recordatorio a los 5 minutos antes de cada timeout ("está por vencer"). |
| Multi-tienda | El esquema lo soporta, pero el bot NO lo procesa como un solo pedido todavía. Si el cliente pide de dos tiendas, el bot separa la conversación en dos pedidos consecutivos, cada uno con su propio cobro de repartidor. |
| Folio | Cada pedido tiene un folio corto y visible (ej. "pedido #12") para referencia rápida en cualquier mensaje de seguimiento o queja. |

## 4. Flujo completo, paso por paso

1. **Saludo** — Bot pregunta antojo (mandado de tienda o comida preparada), muestra tiendas disponibles si hace falta.
2. **Captura del pedido** — Con punto de venta: selección directa de catálogo, confirmación inmediata. Sin punto de venta ("modo IA"): el bot extrae nombre, marca, cantidad y tamaño de cada producto; si falta un dato clave, pregunta antes de cerrar el resumen — nunca adivina.
3. **Ubicación** — GPS + referencia/colonia. Fuera del radio de 1.5 km → rechazo automático inmediato.
4. **Confirmación del pedido con el cliente** — Resumen en lista corta (tienda, productos, dirección), el cliente confirma.
5. **Cotización con la tienda** — Bot pide precio a la tienda por cada producto. Timeout de 10 min (recordatorio a los 5) → si no responde, se cancela y se le ofrece al cliente pedir de otra tienda. Si falta algún producto, la tienda lo reporta por comando (puede incluir opciones alternativas) y el bot le pregunta al cliente si continúa sin ese producto o cancela — **esta cancelación es gratuita, porque aún no hay precio confirmado.**
6. **Precio final** — Bot suma todo y pide confirmación final al cliente. Timeout de 10 min (recordatorio a los 5) → si no responde, se cancela. **A partir de que el cliente confirma aquí, ya no se puede cancelar sin problema.**
7. **Asignación de repartidor** — Broadcast individual a repartidores disponibles con: dirección de recogida (de la tienda, tomada de base de datos, nunca preguntada de nuevo), dirección de entrega, productos, monto a cobrar. Confirman con comando (ej. `#acepto pedido [folio]`). El primero que confirma gana el pedido mediante un `UPDATE` atómico condicionado (`WHERE repartidor_id IS NULL`) — a los demás se les avisa que ya fue tomado, sin necesidad de coordinación manual. Si nadie acepta en 10 min (recordatorio a los 5) → se cancela y se le avisa al cliente que no hay repartidores disponibles.
8. **Recorrido** — Repartidor confirma → cliente recibe "tu pedido va en camino". Repartidor recoge (comando) → cliente recibe "fue recogido". Repartidor entrega, cobra en efectivo, marca "entregado" (comando) → cliente recibe mensaje de cierre y agradecimiento.
9. **Post-entrega** — Chat del cliente se reinicia por completo. Si hay una queja o algo salió mal, el bot escala directo al número de admin (configurar en base de datos si no está) para que el dueño lo resuelva directo con el cliente.

## 5. Reporte de métricas

Notificación semanal al número de admin con contexto del negocio (cantidad de pedidos, etc.) — pieza nueva, necesita su propio cron/worker separado del outbox de notificaciones inmediatas.

## 6. Casos límite ya resueltos (no preguntar, implementar así)

- **Dos repartidores confirman a la vez** → claim atómico por `UPDATE ... WHERE repartidor_id IS NULL`, no por orden de llegada de mensaje.
- **Pedido de dos tiendas** → se separa en dos pedidos consecutivos (ver regla de multi-tienda arriba).
- **Repartidor huérfano a medio pedido** → mismo timeout unificado de 10 min, notifica al admin para reasignar (automatizar reasignación completa se deja para cuando haya 2-3+ repartidores activos).

## 7. Estado técnico real — lo que falta cerrar

Esto es la lista de trabajo real, tomada del diagnóstico más reciente del propio Claude Code (ROADMAP.md) más lo definido en este documento:

- [ ] **Prioridad 1:** el mensaje de cotización a la tienda nunca se dispara — el pedido se queda esperando indefinidamente después de que el cliente confirma. Es el bug raíz que bloquea todo lo demás.
- [ ] Implementar los tres timeouts de 10 min (tienda, precio final del cliente, repartidor) + recordatorio a los 5 min.
- [ ] Envío del precio final combinado al cliente (productos + comisión + repartidor).
- [ ] Dispatch completo al repartidor con datos de la tienda desde base de datos (no preguntados de nuevo).
- [ ] Notificaciones de estado al cliente (recogido / en camino / entregado).
- [ ] Reinicio de conversación del cliente tras cierre del pedido.
- [ ] Claim atómico de repartidor (protección de condición de carrera).
- [ ] Validación de horario de Mándalo (8-8) y de cada tienda/repartidor — confirmar si el campo de horario ya existe en base de datos, si no, agregarlo.
- [ ] Bug de retención: `getOpenPedidoByCustomerPhone` no filtra por estado — un pedido viejo entregado/cancelado puede revivir y mezclarse con uno nuevo.
- [ ] Folio corto visible por pedido.
- [ ] Número de admin configurado en base de datos + flujo de escalamiento de quejas.
- [ ] Worker de reporte semanal de métricas al admin.
- [ ] Prompt del bot reescrito con la personalidad de la sección 2 (tono por rol + conocimiento de mercado mexicano).
- [ ] Separación de conversación para pedidos de dos tiendas (sección 6).

## 8. Mensaje para arrancar con Claude Code

Copiar y pegar esto como primer mensaje en la sesión de Claude Code, junto con este archivo:

> Lee el archivo Mandalo_Brief_Final_ClaudeCode.md completo antes de tocar nada. Todas las reglas de negocio y decisiones de casos límite ya están definidas ahí — no me preguntes sobre eso. Empieza por la Prioridad 1 de la sección 7 (el mensaje de cotización a la tienda que nunca se dispara), y sigue con el resto de la lista en orden. Trabaja en una rama de feature. Si necesitas cambios de base de datos, genera el SQL como archivo para que yo lo corra manualmente — no lo ejecutes tú contra producción. Avísame solo cuando termines un bloque grande de trabajo o si encuentras algo que contradice este documento.
