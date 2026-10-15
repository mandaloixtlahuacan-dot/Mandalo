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

export async function findActiveCourier(): Promise<ActiveCourier | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("repartidores")
      .select("id, nombre, telefono, activo, disponible")
      .eq("activo", true)
      .eq("disponible", true)
      .order("id", { ascending: true })
      .limit(1);
    if (error) {
      console.error("[mandalo] error consultando repartidores:", { message: error.message });
      return null;
    }
    const row = (data ?? [])[0] as ActiveCourier | undefined;
    if (row?.telefono) return row;
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando repartidores:", { message: errorMessage(e) });
  }
  return null;
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

export async function assignCourier(params: {
  pedido: PedidoFullRecord;
  customerPhone: string;
  courier: ActiveCourier;
  deliverCustomer: (body: string) => Promise<void>;
}): Promise<void> {
  const { pedido, courier } = params;
  const repartidorNombre = String(courier.nombre ?? "").trim() || "Repartidor";
  const repartidorTelefono = ensureMxWhatsappIntl(String(courier.telefono ?? ""));
  const mapsLink = resolveMapsLink({ latitud: pedido.latitud, longitud: pedido.longitud });
  const msgRepartidor =
    `🛵 *Hola ${repartidorNombre}, tienes un nuevo pedido*\n\n` +
    `🧾 *Pedido #${pedido.id}*\n\n` +
    `🏪 *${pedido.tienda?.nombre ?? "la tienda"}*\n\n` +
    `📍 *Recoger en:*\n${pedido.tienda?.direccion || "(sin dirección de tienda registrada, confirma con la tienda)"}\n\n` +
    `📍 *Entregar en:*\n${pedido.direccionEntrega || "(sin dirección)"}\n` +
    `${mapsLink ? `${mapsLink}\n` : ""}\n` +
    `🛒 *Productos:*\n\n${formatItems(pedido.items)}\n\n` +
    `${pedido.totalCliente != null ? `💵 *Cobrar: ${formatMoney(pedido.totalCliente)}*\n\n` : ""}` +
    `*Tel. cliente:* ${params.customerPhone}\n\n` +
    `*Responde con:*\n#CONFIRMO ${pedido.id}\n\n` +
    `*Luego:*\n#RECOGI ${pedido.id}\n\n#ENTREGADO ${pedido.id}`;

  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "dispatch_repartidor_pendiente",
    metadataPatch: {
      ...buildOrderTimeoutMetadata("courier_confirmation"),
      current_courier_id: typeof courier.id === "number" ? courier.id : null,
      current_courier_name: repartidorNombre,
      current_courier_phone: repartidorTelefono,
      courier_assignment_attempt: 1,
      sin_repartidor: false,
    },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "dispatch_repartidor",
    estadoOrigen: pedido.estado,
    estadoDestino: "dispatch_repartidor_pendiente",
    actorTipo: "sistema",
  });
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "dispatch_repartidor",
    destinatarioTipo: "repartidor",
    destinatarioId: typeof courier.id === "number" ? courier.id : null,
    telefonoDestino: repartidorTelefono,
    payload: {
      body: msgRepartidor,
      courierId: courier.id ?? null,
      courierName: repartidorNombre,
      courierPhone: repartidorTelefono,
      attemptNumber: 1,
    },
    idempotencyKey: `pedido:${pedido.id}:dispatch_repartidor:attempt:1`,
  });

  const msgCliente =
    `✅ *Pedido #${pedido.id} confirmado*\n\n` +
    `Llegará aproximadamente a las ${formatEstimatedArrival(20)}.\n\n` +
    `🛵 Estamos coordinando tu entrega con *${repartidorNombre}*.\n\n` +
    `Te aviso en cuanto confirme.`;
  await params.deliverCustomer(msgCliente);
  await rememberCustomer(params.customerPhone, msgCliente);
}
