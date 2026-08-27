import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import { getPedidoById, setPedidoEstado, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import { orderTimeoutFieldNames, type OrderTimeoutKind } from "@/lib/services/orderTimeouts";
import type { OrderState } from "@/lib/orderStateMachine";
import type { OutboxMessageType } from "@/lib/services/dispatchWorker";

// Barre los tres timeouts unificados de 10 min (Sección 3 del brief): tienda
// sin cotizar, cliente sin confirmar precio final, repartidor sin aceptar.
// Reemplaza a courierTimeoutWorker.ts (que reintentaba con otro repartidor —
// diseño anterior) por el más simple ya decidido: al vencer, se cancela y se
// avisa a quien corresponda. Pensado para correr cada minuto vía pg_cron +
// pg_net (ver migración de infraestructura), no como reacción a un evento.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatPedidoItems(items: Array<{ nombreProducto: string; cantidad: number | null }>): string {
  if (!items.length) return "- Sin productos definidos";
  return items.map((item) => `- ${item.nombreProducto}${item.cantidad != null ? ` x${item.cantidad}` : ""}`).join("\n");
}

type OutboundNotice = {
  telefono: string;
  body: string;
  tipoMensaje: OutboxMessageType;
  destinatarioTipo: "negocio" | "cliente" | "repartidor";
  destinatarioId: number | null;
};

type TimeoutKindConfig = {
  kind: OrderTimeoutKind;
  estado: OrderState;
  reasonCode: "store_quote_timeout" | "final_confirmation_timeout" | "courier_confirmation_timeout" | "product_adjustment_timeout";
  buildReminder(pedido: PedidoFullRecord): OutboundNotice | null;
  buildCancelNotices(pedido: PedidoFullRecord): OutboundNotice[];
  adminMessage(pedido: PedidoFullRecord): string;
};

const TIMEOUT_CONFIGS: TimeoutKindConfig[] = [
  {
    kind: "store_quote",
    estado: "pendiente_tiendas",
    reasonCode: "store_quote_timeout",
    buildReminder(pedido) {
      if (!pedido.tienda?.telefono) return null;
      return {
        telefono: ensureMxWhatsappIntl(pedido.tienda.telefono),
        body:
          `⏰ Recordatorio: el pedido #${pedido.id} sigue esperando tu precio.\n\n` +
          `Pedido:\n${formatPedidoItems(pedido.items)}\n\n` +
          `Tienes 5 minutos antes de que se cancele automáticamente.\n\n` +
          `Responde así: ORDEN #${pedido.id} PRECIO 150\n\n` +
          `¿Te falta algún producto? Responde: ORDEN #${pedido.id} NO_DISPONIBLE nombre del producto`,
        tipoMensaje: "cotizacion_tienda",
        destinatarioTipo: "negocio",
        destinatarioId: pedido.tienda.tiendaId,
      };
    },
    buildCancelNotices(pedido) {
      const notices: OutboundNotice[] = [
        {
          telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
          body: `⚠️ Tu pedido #${pedido.id} se canceló porque la tienda no respondió a tiempo.\n\n¿Quieres pedir de otro negocio? 🛒`,
          tipoMensaje: "notificacion_cliente",
          destinatarioTipo: "cliente",
          destinatarioId: null,
        },
      ];
      if (pedido.tienda?.telefono) {
        notices.push({
          telefono: ensureMxWhatsappIntl(pedido.tienda.telefono),
          body: `El pedido #${pedido.id} se canceló por falta de respuesta a tiempo. Ya no es necesario cotizarlo.`,
          tipoMensaje: "cotizacion_tienda",
          destinatarioTipo: "negocio",
          destinatarioId: pedido.tienda.tiendaId,
        });
      }
      return notices;
    },
    adminMessage: (pedido) =>
      `Timeout de cotización.\n\nPedido: ${pedido.id}\nLa tienda no respondió en 10 min. Pedido cancelado.`,
  },
  {
    kind: "final_confirmation",
    estado: "confirmado_tiendas",
    reasonCode: "final_confirmation_timeout",
    buildReminder(pedido) {
      return {
        telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
        body:
          `⏰ Tu pedido #${pedido.id} está por vencer.\n\n` +
          `Responde *SÍ* en los próximos 5 minutos para confirmarlo, o se cancelará automáticamente.`,
        tipoMensaje: "notificacion_cliente",
        destinatarioTipo: "cliente",
        destinatarioId: null,
      };
    },
    buildCancelNotices(pedido) {
      const notices: OutboundNotice[] = [
        {
          telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
          body: `⚠️ Tu pedido #${pedido.id} se canceló porque no confirmaste el precio final a tiempo.\n\nCuando quieras, puedes hacer un nuevo pedido. 🙏`,
          tipoMensaje: "notificacion_cliente",
          destinatarioTipo: "cliente",
          destinatarioId: null,
        },
      ];
      if (pedido.tienda?.telefono) {
        notices.push({
          telefono: ensureMxWhatsappIntl(pedido.tienda.telefono),
          body: `El pedido #${pedido.id} se canceló: el cliente no confirmó a tiempo. Ya no es necesario prepararlo.`,
          tipoMensaje: "cotizacion_tienda",
          destinatarioTipo: "negocio",
          destinatarioId: pedido.tienda.tiendaId,
        });
      }
      return notices;
    },
    adminMessage: (pedido) =>
      `Timeout de confirmación final.\n\nPedido: ${pedido.id}\nEl cliente no confirmó el precio en 10 min. Pedido cancelado.`,
  },
  {
    kind: "courier_confirmation",
    estado: "dispatch_repartidor_pendiente",
    reasonCode: "courier_confirmation_timeout",
    buildReminder(pedido) {
      const courierPhone = cleanText(pedido.metadata.current_courier_phone);
      if (!courierPhone) return null;
      return {
        telefono: ensureMxWhatsappIntl(courierPhone),
        body: `⏰ Recordatorio: tienes 5 minutos más para aceptar el pedido #${pedido.id} con #CONFIRMO ${pedido.id}, o se cancelará.`,
        tipoMensaje: "dispatch_repartidor",
        destinatarioTipo: "repartidor",
        destinatarioId: toNullableNumber(pedido.metadata.current_courier_id),
      };
    },
    buildCancelNotices(pedido) {
      const notices: OutboundNotice[] = [
        {
          telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
          body:
            `⚠️ Por ahora no tenemos repartidores disponibles para tu pedido #${pedido.id}, así que lo cancelamos.\n\n` +
            `En cuanto haya uno libre, puedes volver a pedir. 🙏`,
          tipoMensaje: "notificacion_cliente",
          destinatarioTipo: "cliente",
          destinatarioId: null,
        },
      ];
      if (pedido.tienda?.telefono) {
        notices.push({
          telefono: ensureMxWhatsappIntl(pedido.tienda.telefono),
          body: `El pedido #${pedido.id} se canceló: no hubo repartidor disponible a tiempo. Ya no es necesario prepararlo.`,
          tipoMensaje: "cotizacion_tienda",
          destinatarioTipo: "negocio",
          destinatarioId: pedido.tienda.tiendaId,
        });
      }
      return notices;
    },
    adminMessage: (pedido) =>
      `Timeout de repartidor.\n\nPedido: ${pedido.id}\nNingún repartidor confirmó en 10 min. Pedido cancelado.`,
  },
  {
    kind: "product_adjustment",
    estado: "ajuste_producto",
    reasonCode: "product_adjustment_timeout",
    buildReminder(pedido) {
      const itemNombre = cleanText(pedido.metadata.product_adjustment_item_nombre) ?? "un producto";
      return {
        telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
        body:
          `⏰ Tu pedido #${pedido.id} sigue esperando tu decisión sobre "${itemNombre}".\n\n` +
          `Responde en los próximos 5 minutos: escribe "sin él" para continuar sin ese producto, o dime por cuál lo cambio — si no, se cancelará.`,
        tipoMensaje: "notificacion_cliente",
        destinatarioTipo: "cliente",
        destinatarioId: null,
      };
    },
    buildCancelNotices(pedido) {
      const itemNombre = cleanText(pedido.metadata.product_adjustment_item_nombre) ?? "un producto";
      const notices: OutboundNotice[] = [
        {
          telefono: ensureMxWhatsappIntl(pedido.clienteTelefono),
          body: `⚠️ Tu pedido #${pedido.id} se canceló: no respondiste a tiempo sobre "${itemNombre}".\n\nCuando quieras, puedes hacer un nuevo pedido. 🙏`,
          tipoMensaje: "notificacion_cliente",
          destinatarioTipo: "cliente",
          destinatarioId: null,
        },
      ];
      if (pedido.tienda?.telefono) {
        notices.push({
          telefono: ensureMxWhatsappIntl(pedido.tienda.telefono),
          body: `El pedido #${pedido.id} se canceló: el cliente no respondió a tiempo sobre "${itemNombre}". Ya no es necesario prepararlo.`,
          tipoMensaje: "cotizacion_tienda",
          destinatarioTipo: "negocio",
          destinatarioId: pedido.tienda.tiendaId,
        });
      }
      return notices;
    },
    adminMessage: (pedido) =>
      `Timeout de ajuste de producto.\n\nPedido: ${pedido.id}\nEl cliente no decidió en 10 min. Pedido cancelado.`,
  },
];

// El deadline/recordatorio vive en metadata_json (no en columnas fijas, ver
// CLAUDE.md Sección 4 nota de implementación), así que se filtra por el path
// jsonb con `->>` — mismo patrón que ya usaba el courierTimeoutWorker anterior.
async function findExpiredPedidoIds(config: TimeoutKindConfig, nowIso: string, limit: number): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const { deadlineAt } = orderTimeoutFieldNames(config.kind);
  const { data, error } = await supabase
    .from("pedidos")
    .select("id")
    .eq("estado", config.estado)
    .lte(`metadata_json->>${deadlineAt}`, nowIso)
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => Number((row as { id: unknown }).id));
}

async function findDueReminderPedidoIds(config: TimeoutKindConfig, nowIso: string, limit: number): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const { deadlineAt, reminderAt, remindedAt } = orderTimeoutFieldNames(config.kind);
  const { data, error } = await supabase
    .from("pedidos")
    .select("id")
    .eq("estado", config.estado)
    .lte(`metadata_json->>${reminderAt}`, nowIso)
    .gt(`metadata_json->>${deadlineAt}`, nowIso)
    .is(`metadata_json->>${remindedAt}`, null)
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => Number((row as { id: unknown }).id));
}

async function sendNotice(pedidoId: number, kind: OrderTimeoutKind, tag: string, notice: OutboundNotice): Promise<void> {
  await outboxRepository.enqueueOutboundMessage({
    pedidoId,
    tipoMensaje: notice.tipoMensaje,
    destinatarioTipo: notice.destinatarioTipo,
    destinatarioId: notice.destinatarioId,
    telefonoDestino: notice.telefono,
    payload: { body: notice.body },
    idempotencyKey: `pedido:${pedidoId}:${kind}:${tag}:v1`,
  });
}

export type OrderTimeoutWorkerRunSummary = {
  remindersSent: number;
  cancelled: number;
  failed: number;
};

export function createOrderTimeoutWorker() {
  const transitionService = createStateTransitionService();

  async function processReminders(
    config: TimeoutKindConfig,
    nowIso: string,
    limit: number,
    summary: OrderTimeoutWorkerRunSummary,
  ): Promise<void> {
    const { remindedAt } = orderTimeoutFieldNames(config.kind);
    const ids = await findDueReminderPedidoIds(config, nowIso, limit);

    for (const pedidoId of ids) {
      try {
        const pedido = await getPedidoById(pedidoId);
        if (!pedido || pedido.estado !== config.estado) continue;

        const reminder = config.buildReminder(pedido);
        if (reminder) {
          await sendNotice(pedidoId, config.kind, "reminder", reminder);
        }

        await setPedidoEstado({ pedidoId, estado: pedido.estado, metadataPatch: { [remindedAt]: nowIso } });
        summary.remindersSent += 1;
      } catch (e: unknown) {
        summary.failed += 1;
        console.error("[orderTimeoutWorker] fallo al mandar recordatorio", {
          pedidoId,
          kind: config.kind,
          message: errorMessage(e),
        });
      }
    }
  }

  async function processExpirations(
    config: TimeoutKindConfig,
    nowIso: string,
    limit: number,
    summary: OrderTimeoutWorkerRunSummary,
  ): Promise<void> {
    const ids = await findExpiredPedidoIds(config, nowIso, limit);

    for (const pedidoId of ids) {
      try {
        const pedido = await getPedidoById(pedidoId);
        if (!pedido || pedido.estado !== config.estado) continue;

        for (const notice of config.buildCancelNotices(pedido)) {
          await sendNotice(pedidoId, config.kind, "cancel", notice);
        }

        await transitionService.handleOrderTimeoutExpired({
          pedidoId,
          fromState: config.estado,
          reasonCode: config.reasonCode,
          adminMessage: config.adminMessage(pedido),
          customerPhone: pedido.clienteTelefono,
        });
        summary.cancelled += 1;
      } catch (e: unknown) {
        summary.failed += 1;
        console.error("[orderTimeoutWorker] fallo al cancelar por timeout", {
          pedidoId,
          kind: config.kind,
          message: errorMessage(e),
        });
      }
    }
  }

  return {
    async run(params?: { limit?: number }): Promise<OrderTimeoutWorkerRunSummary> {
      const limit = params?.limit ?? 25;
      const nowIso = new Date().toISOString();
      const summary: OrderTimeoutWorkerRunSummary = { remindersSent: 0, cancelled: 0, failed: 0 };

      for (const config of TIMEOUT_CONFIGS) {
        await processReminders(config, nowIso, limit, summary);
        await processExpirations(config, nowIso, limit, summary);
      }

      return summary;
    },
  };
}

