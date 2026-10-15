import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import {
  appendPedidoEvento,
  finalizePedidoRetention,
  setPedidoEstado,
  type PedidoFullRecord,
} from "@/lib/repositories/pedidoRepositoryV2";
import * as metricsRepository from "@/lib/repositories/metricsRepository";
import { formatNoCourierAdmin, formatNoCourierCustomer, formatNoCourierStore } from "@/lib/customerUx";
import { formatMoney } from "@/lib/ordenes";
import { formatNameQtyLine, joinBlocks } from "@/lib/messageStyle";
import { dispatchItemAlreadyShowsQty } from "@/lib/services/captureEngine";
import { buildOrderTimeoutMetadata } from "@/lib/services/orderTimeouts";
import { resolveMapsLink } from "@/lib/services/geo";
import { saveChatMessage } from "@/lib/messages";
import {
  buildCourierOfferMessage,
  buildCustomerCourierCoordinatingMessage,
  selectAvailableCouriers,
  type CourierScheduleRow,
} from "@/lib/services/courierAvailability";

export type ActiveCourier = {
  id?: unknown;
  nombre?: unknown;
  telefono?: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatItems(items: Array<{ nombreProducto: string; cantidad: number | null }>): string {
  if (!items.length) return "🛍️ *Sin productos*";
  return joinBlocks(
    items.map((item) => {
      const name = item.nombreProducto.trim() || "producto";
      return formatNameQtyLine(name, item.cantidad, item.cantidad != null && dispatchItemAlreadyShowsQty(name, item.cantidad));
    }),
  );
}

function formatEstimatedArrival(minutesToAdd = 20): string {
  const eta = new Date(Date.now() + minutesToAdd * 60 * 1000);
  return eta.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Mexico_City" });
}

type CourierQueryRow = CourierScheduleRow & { id?: unknown; nombre?: unknown; telefono?: unknown };

function toCourierId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Repartidores activos, disponibles y dentro de su horario semanal ahora.
 * Puede ser más de uno: el pedido se les ofrece a todos.
 */
export async function findAvailableCouriers(now: Date = new Date()): Promise<ActiveCourier[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("repartidores")
      .select("id, nombre, telefono, activo, disponible, horario_json")
      .eq("activo", true)
      .eq("disponible", true)
      .order("id", { ascending: true });
    if (error) {
      console.error("[mandalo] error consultando repartidores:", { message: error.message });
      return [];
    }
    const rows: CourierQueryRow[] = (data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: toCourierId(record.id),
        nombre: record.nombre == null ? null : String(record.nombre),
        telefono: record.telefono == null ? null : String(record.telefono),
        activo: record.activo === true,
        disponible: record.disponible !== false,
        horarioJson: record.horario_json,
      };
    });
    return selectAvailableCouriers(rows, now).map((courier) => ({
      id: courier.id,
      nombre: courier.nombre,
      telefono: courier.telefono,
    }));
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando repartidores:", { message: errorMessage(e) });
  }
  return [];
}

async function rememberCustomer(telefono: string, body: string): Promise<void> {
  await saveChatMessage({ telefono, texto: body, estado: "bot" }).catch(() => {});
}

/**
 * El cliente ya confirmó y no hay repartidor. No se usa el timeout de
 * "no confirmaste el precio". Se avisa con el motivo real y se cierra.
 */
export async function cancelBecauseNoCourier(params: {
  pedido: PedidoFullRecord;
  customerPhone: string;
  notifyStore: boolean;
  deliverCustomer: (body: string) => Promise<void>;
}): Promise<void> {
  const { pedido } = params;
  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "cancelado",
    metadataPatch: {
      sin_repartidor: true,
      cancelled_reason: "sin_repartidor",
      cancelled_at: new Date().toISOString(),
    },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "cancelado",
    estadoOrigen: pedido.estado,
    estadoDestino: "cancelado",
    actorTipo: "sistema",
    payload: { reason: "sin_repartidor" },
  });

  const customerBody = formatNoCourierCustomer(pedido.id);
  await params.deliverCustomer(customerBody);
  await rememberCustomer(params.customerPhone, customerBody);

  if (params.notifyStore && pedido.tienda?.telefono) {
    const body = formatNoCourierStore(pedido.id);
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "cotizacion_tienda",
      destinatarioTipo: "negocio",
      destinatarioId: pedido.tienda.tiendaId,
      telefonoDestino: ensureMxWhatsappIntl(pedido.tienda.telefono),
      payload: { body },
      idempotencyKey: `pedido:${pedido.id}:sin_repartidor:tienda:v1`,
    });
  }

  await outboxRepository
    .enqueueAdminNotification({
      pedidoId: pedido.id,
      tipo: "sin_repartidor",
      contenido: formatNoCourierAdmin(pedido.id),
    })
    .catch((e: unknown) => {
      console.error("[mandalo] no se pudo avisar al admin que no hay repartidor", {
        pedidoId: pedido.id,
        message: errorMessage(e),
      });
    });

  await metricsRepository.incrementMetric("pedidos_cancelados").catch(() => {});
  await finalizePedidoRetention({ pedidoId: pedido.id, customerPhone: params.customerPhone }).catch((e: unknown) => {
    console.error("[mandalo] finalizePedidoRetention falló tras sin repartidor", {
      pedidoId: pedido.id,
      message: errorMessage(e),
    });
  });
}

/**
 * Ofrece el pedido a cada repartidor disponible en este momento.
 * No fija repartidor_id: el primero que mande #CONFIRMO se lo queda
 * con un UPDATE condicional (repartidor_id IS NULL).
 */
export async function offerOrderToCouriers(params: {
  pedido: PedidoFullRecord;
  customerPhone: string;
  couriers: ActiveCourier[];
  deliverCustomer: (body: string) => Promise<void>;
  actorTipo?: "cliente" | "sistema";
}): Promise<void> {
  const { pedido } = params;
  const offered = params.couriers
    .map((courier) => ({
      id: typeof courier.id === "number" ? courier.id : toCourierId(courier.id),
      nombre: String(courier.nombre ?? "").trim() || "Repartidor",
      telefono: ensureMxWhatsappIntl(String(courier.telefono ?? "")),
    }))
    .filter((courier) => courier.telefono);
  if (!offered.length) throw new Error("offerOrderToCouriers: no hay repartidores para ofrecer.");

  const mapsLink = resolveMapsLink({ latitud: pedido.latitud, longitud: pedido.longitud });
  const itemsText = formatItems(pedido.items);
  const chargeLine = pedido.totalCliente != null ? `💵 *Cobrar: ${formatMoney(pedido.totalCliente)}*` : null;

  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "dispatch_repartidor_pendiente",
    metadataPatch: {
      ...buildOrderTimeoutMetadata("courier_confirmation"),
      offered_couriers: offered,
      current_courier_id: null,
      current_courier_name: null,
      current_courier_phone: null,
      courier_assignment_attempt: 1,
      sin_repartidor: false,
    },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "dispatch_repartidor",
    estadoOrigen: pedido.estado,
    estadoDestino: "dispatch_repartidor_pendiente",
    actorTipo: params.actorTipo ?? "sistema",
    payload: { offeredCourierIds: offered.map((courier) => courier.id) },
  });

  for (const courier of offered) {
    const body = buildCourierOfferMessage({
      courierName: courier.nombre,
      pedidoId: pedido.id,
      storeName: pedido.tienda?.nombre ?? "la tienda",
      pickupAddress: pedido.tienda?.direccion || "(sin dirección de tienda registrada, confirma con la tienda)",
      dropoffAddress: pedido.direccionEntrega || "(sin dirección)",
      mapsLink,
      itemsText,
      chargeLine,
      customerPhone: params.customerPhone,
    });
    console.log("[dispatch][courier]", {
      orderId: pedido.id,
      courier_name: courier.nombre,
      courier_phone: courier.telefono,
      customer_phone: params.customerPhone,
      mapsLink: mapsLink || null,
      bodyPreview: body.slice(0, 300),
    });
    const keyId = courier.id ?? courier.telefono;
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "dispatch_repartidor",
      destinatarioTipo: "repartidor",
      destinatarioId: courier.id,
      telefonoDestino: courier.telefono,
      payload: {
        body,
        courierId: courier.id,
        courierName: courier.nombre,
        courierPhone: courier.telefono,
        attemptNumber: 1,
      },
      idempotencyKey: `pedido:${pedido.id}:dispatch_repartidor:attempt:1:courier:${keyId}`,
    });
  }

  const msgCliente = buildCustomerCourierCoordinatingMessage({
    pedidoId: pedido.id,
    etaText: formatEstimatedArrival(20),
    courierNames: offered.map((courier) => courier.nombre),
  });
  await params.deliverCustomer(msgCliente);
  await rememberCustomer(params.customerPhone, msgCliente);
}
