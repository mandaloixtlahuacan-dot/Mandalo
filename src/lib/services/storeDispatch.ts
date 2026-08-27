import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { appendPedidoEvento, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import { buildOrderTimeoutMetadata } from "@/lib/services/orderTimeouts";
import type { OrderState } from "@/lib/orderStateMachine";

// Extraído de mandaloFlow.ts (antes vivía inline en handleEsperandoConfirmacionInicial)
// para poder llamarlo también desde scheduledDispatchWorker.ts, cuando una
// tienda que estaba cerrada al confirmar por fin abre. formatItemsForDispatch/
// logStoreDispatch son copias deliberadamente pequeñas (no exportadas desde
// mandaloFlow.ts) — moverlas ahí implicaría reencauzar los otros call sites
// de esas dos funciones dentro de mandaloFlow.ts sin ganar nada; son unas
// líneas triviales, más simple duplicarlas aquí que orquestar el import.
function formatItemsForDispatch(items: Array<{ nombreProducto: string; cantidad: number | null }>): string {
  if (!items.length) return "(sin productos)";
  return items.map((it) => `- ${it.nombreProducto}${it.cantidad != null ? ` x${it.cantidad}` : ""}`).join("\n");
}

function logStoreDispatch(params: {
  orderId: number;
  tiendaId?: unknown;
  tiendaNombre?: unknown;
  tiendaTelefono?: unknown;
  to: string;
  body: string;
}) {
  console.log("[dispatch][tienda]", {
    orderId: params.orderId,
    tienda_id: params.tiendaId ?? null,
    tienda_nombre: String(params.tiendaNombre ?? "").trim() || null,
    tienda_telefono: String(params.tiendaTelefono ?? "").trim() || null,
    to: params.to,
    bodyPreview: String(params.body ?? "").slice(0, 300),
  });
}

export type DispatchCotizacionResult =
  | { ok: true }
  | { ok: false; reason: "no_store_phone" }
  | { ok: false; reason: "not_claimed" };

// Envía la cotización a la tienda y transiciona el pedido a pendiente_tiendas.
// Se llama desde dos lugares: el flujo en vivo (mandaloFlow.ts, cuando la
// tienda ya estaba abierta al confirmar) y scheduledDispatchWorker.ts
// (cuando una tienda que estaba cerrada por fin abre). Claim atómico
// primero — mismo patrón que stateTransitionService.handleCourierConfirm:
// el worker recorre varios pedidos con awaits entre cada uno, así que hay
// una ventana real para que una cancelación del cliente (que borra el
// pedido) se cruce a la mitad. Si el UPDATE condicional no afecta ninguna
// fila, alguien más ya movió este pedido — no se manda nada a la tienda.
export async function dispatchCotizacionToStore(
  pedido: PedidoFullRecord,
  params: { fromEstado: OrderState; actorTipo: "cliente" | "sistema" },
): Promise<DispatchCotizacionResult> {
  if (!pedido.tienda?.telefono) {
    return { ok: false, reason: "no_store_phone" };
  }

  const supabase = getSupabaseAdmin();
  const metadataPatch = buildOrderTimeoutMetadata("store_quote");
  const { data, error } = await supabase
    .from("pedidos")
    .update({
      estado: "pendiente_tiendas",
      metadata_json: { ...pedido.metadata, ...metadataPatch },
      updated_at: new Date().toISOString(),
    })
    .eq("id", pedido.id)
    .eq("estado", params.fromEstado)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, reason: "not_claimed" };

  const tiendaTelefono = ensureMxWhatsappIntl(pedido.tienda.telefono);
  const encabezado =
    `COTIZAR. ORDEN #${pedido.id}\n` +
    `${pedido.direccionEntrega ? `Dirección: ${pedido.direccionEntrega}\n` : ""}` +
    `Pedido:\n${formatItemsForDispatch(pedido.items)}\n\n` +
    `Responde así: ORDEN #${pedido.id} PRECIO 150\n\n` +
    `¿Te falta algún producto? Responde: ORDEN #${pedido.id} NO_DISPONIBLE nombre del producto`;

  logStoreDispatch({
    orderId: pedido.id,
    tiendaId: pedido.tienda.tiendaId,
    tiendaNombre: pedido.tienda.nombre,
    tiendaTelefono,
    to: tiendaTelefono,
    body: encabezado,
  });

  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "cotizacion_tienda",
    destinatarioTipo: "negocio",
    destinatarioId: pedido.tienda.tiendaId,
    telefonoDestino: tiendaTelefono,
    payload: { body: encabezado },
    idempotencyKey: `pedido:${pedido.id}:cotizacion_tienda:v1`,
  });

  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "dispatch_tienda",
    estadoOrigen: params.fromEstado,
    estadoDestino: "pendiente_tiendas",
    actorTipo: params.actorTipo,
  });

  return { ok: true };
}
