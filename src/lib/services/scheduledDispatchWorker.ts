import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import { getPedidoById, setPedidoEstado, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import { checkTiendaSchedule } from "@/lib/services/businessHours";
import { dispatchCotizacionToStore } from "@/lib/services/storeDispatch";
import { ESPERANDO_APERTURA_DEADLINE_FIELD } from "@/lib/services/orderTimeouts";

// Dispara los pedidos programados (esperando_apertura_tienda, CLAUDE.md
// Sección 5 regla 6 / Sección 8) en cuanto la tienda elegida abre, y cancela
// los que llevan más de 48h sin que la tienda abra. Pensado para correr cada
// minuto vía pg_cron + pg_net, mismo patrón que orderTimeoutWorker.ts — pero
// es un worker aparte porque el chequeo es distinto en naturaleza: "¿está
// abierta la tienda ahora mismo?" (horario recurrente, checkTiendaSchedule)
// en vez de "¿ya pasó una fecha límite absoluta?" (los tres timeouts de 10
// min de ese otro worker).

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WAITING_ESTADO = "esperando_apertura_tienda" as const;

async function findWaitingPedidoIds(limit: number): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("pedidos").select("id").eq("estado", WAITING_ESTADO).limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => Number((row as { id: unknown }).id));
}

export type ScheduledDispatchWorkerRunSummary = {
  dispatched: number;
  cancelled: number;
  stillWaiting: number;
  failed: number;
};

async function handleDispatch(pedido: PedidoFullRecord, summary: ScheduledDispatchWorkerRunSummary): Promise<void> {
  const result = await dispatchCotizacionToStore(pedido, { fromEstado: WAITING_ESTADO, actorTipo: "sistema" });

  if (result.ok) {
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "notificacion_cliente",
      destinatarioTipo: "cliente",
      destinatarioId: null,
      telefonoDestino: ensureMxWhatsappIntl(pedido.clienteTelefono),
      payload: {
        body: `📦 Tu pedido #${pedido.id} ya se envió a *${pedido.tienda?.nombre ?? "la tienda"}*, que acaba de abrir. Te aviso en cuanto confirme el precio.`,
      },
      idempotencyKey: `pedido:${pedido.id}:esperando_apertura:dispatched:v1`,
    });
    summary.dispatched += 1;
    return;
  }

  if (result.reason === "not_claimed") {
    // Alguien más ya movió este pedido (ej. una cancelación cruzada en el
    // mismo instante) — nada que hacer, no es un fallo real.
    return;
  }

  // no_store_phone: caso raro. A diferencia del flujo en vivo, aquí no hay
  // turno de conversación con el cliente para pedirle que reintente — se
  // deja el pedido en espera y se alerta al admin una sola vez, no en cada
  // tick del cron.
  const alreadyAlerted = Boolean(pedido.metadata.store_phone_missing_alerted_at);
  if (!alreadyAlerted) {
    try {
      await outboxRepository.enqueueAdminNotification({
        pedidoId: pedido.id,
        tipo: "alerta_operativa",
        contenido: `Pedido #${pedido.id} listo para envío programado, pero la tienda no tiene teléfono registrado. Revisar manualmente.`,
      });
    } catch (e: unknown) {
      console.error("[scheduledDispatchWorker] no se pudo alertar al admin (sin teléfono de tienda)", {
        pedidoId: pedido.id,
        message: errorMessage(e),
      });
    }
    await setPedidoEstado({
      pedidoId: pedido.id,
      estado: WAITING_ESTADO,
      metadataPatch: { store_phone_missing_alerted_at: new Date().toISOString() },
    }).catch(() => {});
  }
  summary.failed += 1;
}

async function handleExpired(
  pedido: PedidoFullRecord,
  transitionService: ReturnType<typeof createStateTransitionService>,
  summary: ScheduledDispatchWorkerRunSummary,
): Promise<void> {
  const tiendaNombre = pedido.tienda?.nombre ?? "la tienda";

  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    destinatarioId: null,
    telefonoDestino: ensureMxWhatsappIntl(pedido.clienteTelefono),
    payload: {
      body: `⚠️ Tu pedido #${pedido.id} a *${tiendaNombre}* se canceló: la tienda no abrió a tiempo.\n\nCuando quieras, puedes hacer un nuevo pedido. 🙏`,
    },
    idempotencyKey: `pedido:${pedido.id}:esperando_apertura:expired:v1`,
  });

  await transitionService.handleOrderTimeoutExpired({
    pedidoId: pedido.id,
    fromState: WAITING_ESTADO,
    reasonCode: "store_never_opened",
    adminMessage: `Pedido programado nunca se disparó.\n\nPedido: ${pedido.id}\nTienda: ${tiendaNombre}\nNo abrió dentro del plazo de 48h. Pedido cancelado.`,
    customerPhone: pedido.clienteTelefono,
  });

  summary.cancelled += 1;
}

export function createScheduledDispatchWorker() {
  const transitionService = createStateTransitionService();

  return {
    async run(params?: { limit?: number }): Promise<ScheduledDispatchWorkerRunSummary> {
      const limit = params?.limit ?? 25;
      const nowMs = Date.now();
      const summary: ScheduledDispatchWorkerRunSummary = { dispatched: 0, cancelled: 0, stillWaiting: 0, failed: 0 };

      const ids = await findWaitingPedidoIds(limit);

      for (const pedidoId of ids) {
        try {
          const pedido = await getPedidoById(pedidoId);
          if (!pedido || pedido.estado !== WAITING_ESTADO) continue;

          const schedule = pedido.tienda
            ? checkTiendaSchedule({ horaApertura: pedido.tienda.horaApertura, horaCierre: pedido.tienda.horaCierre })
            : { withinSchedule: true as const };

          if (schedule.withinSchedule) {
            await handleDispatch(pedido, summary);
            continue;
          }

          const deadlineRaw = pedido.metadata[ESPERANDO_APERTURA_DEADLINE_FIELD];
          const deadlineMs = typeof deadlineRaw === "string" ? Date.parse(deadlineRaw) : NaN;
          const expired = Number.isFinite(deadlineMs) && deadlineMs <= nowMs;

          if (expired) {
            await handleExpired(pedido, transitionService, summary);
            continue;
          }

          summary.stillWaiting += 1;
        } catch (e: unknown) {
          summary.failed += 1;
          console.error("[scheduledDispatchWorker] fallo procesando pedido en espera", {
            pedidoId,
            message: errorMessage(e),
          });
        }
      }

      return summary;
    },
  };
}
