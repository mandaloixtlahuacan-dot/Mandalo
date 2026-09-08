import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import {
  appendPedidoEvento,
  getProductosTiendaActivos,
  matchProductoTienda,
  setPedidoEstado,
  setPedidoItemDisponible,
  setPedidoTiendaCotizacion,
  setPedidoTiendaEstado,
  setPedidoTotales,
  type PedidoFullRecord,
} from "@/lib/repositories/pedidoRepositoryV2";
import { buildOrderTimeoutMetadata } from "@/lib/services/orderTimeouts";
import { calculateFinalPrice, formatMoney, MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "@/lib/ordenes";
import { saveChatMessage as guardarMensajeChat } from "@/lib/messages";
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

// Compartida entre el #PRECIO manual (mandaloFlow.ts handleTiendaMessage) y
// el camino automático de tiendas con catálogo fijo (dispatchCatalogoFijo,
// abajo) — pendiente_tiendas -> confirmado_tiendas es la misma transición
// sea cual sea el origen del subtotal, así que vive en un solo lugar.
export async function finalizeStoreQuote(params: {
  pedido: PedidoFullRecord;
  subtotal: number;
  actorTipo: "tienda" | "sistema";
}): Promise<{ total: number }> {
  const { pedido, subtotal, actorTipo } = params;
  if (!pedido.tienda) throw new Error(`finalizeStoreQuote: pedido ${pedido.id} sin tienda vinculada`);

  const total = calculateFinalPrice(subtotal);

  await setPedidoTiendaCotizacion({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, subtotal });
  await setPedidoTotales({ pedidoId: pedido.id, servicioRepartidor: MANDALO_DELIVERY_FEE, totalCliente: total });
  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "confirmado_tiendas",
    metadataPatch: buildOrderTimeoutMetadata("final_confirmation"),
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "cotizacion_recibida",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "confirmado_tiendas",
    actorTipo,
    payload: { subtotal, total },
  });

  const msg =
    `Este es el total de tu pedido en *${pedido.tienda.nombre ?? "la tienda"}*:\n\n` +
    `Pedido #${pedido.id}\n` +
    `Subtotal: ${formatMoney(subtotal)}\n` +
    `Servicio Mándalo: ${formatMoney(MANDALO_SERVICE_FEE)}\n` +
    `Envío: ${formatMoney(MANDALO_DELIVERY_FEE)}\n` +
    `*Total a pagar: ${formatMoney(total)}*\n\n` +
    `¿Confirmas tu pedido? Responde *SÍ* ✅`;
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: msg },
    idempotencyKey: `pedido:${pedido.id}:cliente:cotizacion_recibida:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msg, estado: "bot" }).catch(() => {});

  return { total };
}

// Compartida entre #NO_DISPONIBLE manual (mandaloFlow.ts
// handleTiendaProductoNoDisponible) y el camino automático de catálogo fijo
// (un producto del pedido que no está en el menú de la tienda se trata
// exactamente igual, solo que sin que la tienda tenga que escribir nada).
export async function flagItemUnavailable(params: {
  pedido: PedidoFullRecord;
  item: { id: number; nombreProducto: string };
  actorTipo: "tienda" | "sistema";
}): Promise<void> {
  const { pedido, item, actorTipo } = params;
  if (!pedido.tienda) throw new Error(`flagItemUnavailable: pedido ${pedido.id} sin tienda vinculada`);

  await setPedidoItemDisponible(item.id, false);
  await setPedidoTiendaEstado({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, estadoTienda: "ajuste_producto" });
  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "ajuste_producto",
    metadataPatch: {
      ...buildOrderTimeoutMetadata("product_adjustment"),
      product_adjustment_item_id: item.id,
      product_adjustment_item_nombre: item.nombreProducto,
    },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "producto_no_disponible",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "ajuste_producto",
    actorTipo,
    payload: { itemId: item.id, itemNombre: item.nombreProducto },
  });

  const msgCliente =
    `📦 *${pedido.tienda.nombre ?? "La tienda"}* no tiene disponible:\n"${item.nombreProducto}"\n\n` +
    `¿Quieres continuar tu pedido sin este producto, o prefieres cambiarlo por otro?\n\n` +
    `Responde "sin él" para quitarlo, o dime el producto por el que lo cambias. 🙏`;
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: msgCliente },
    idempotencyKey: `pedido:${pedido.id}:cliente:producto_no_disponible:${item.id}:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msgCliente, estado: "bot" }).catch(() => {});
}

// Tiendas con tiendas.usa_catalogo_fijo = true (ver migración
// 20260907_tiendas_catalogo_fijo.sql): en vez de mandar "COTIZAR." y esperar
// #PRECIO, resuelve el subtotal directo contra productos_tienda. Un producto
// que no matchea con el catálogo se trata igual que un #NO_DISPONIBLE manual
// (flagItemUnavailable) — la tienda nunca tiene que escribir nada.
async function dispatchCatalogoFijo(
  pedido: PedidoFullRecord,
  params: { fromEstado: OrderState; actorTipo: "cliente" | "sistema" },
): Promise<DispatchCotizacionResult> {
  if (!pedido.tienda?.telefono) return { ok: false, reason: "no_store_phone" };

  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "dispatch_tienda",
    estadoOrigen: params.fromEstado,
    estadoDestino: "pendiente_tiendas",
    actorTipo: params.actorTipo,
    payload: { catalogoFijo: true },
  });

  const catalogo = await getProductosTiendaActivos(pedido.tienda.tiendaId);
  const matches = pedido.items
    .filter((item) => item.disponible !== false)
    .map((item) => ({ item, match: matchProductoTienda(catalogo, item.nombreProducto) }));

  const missing = matches.find((m) => !m.match);
  if (missing) {
    await flagItemUnavailable({ pedido, item: missing.item, actorTipo: "sistema" });
    return { ok: true };
  }

  const subtotal = matches.reduce((sum, m) => sum + m.match!.precio * (m.item.cantidad ?? 1), 0);
  await finalizeStoreQuote({ pedido, subtotal, actorTipo: "sistema" });

  const tiendaTelefono = ensureMxWhatsappIntl(pedido.tienda.telefono);
  const aviso =
    `📦 Nuevo pedido #${pedido.id} (catálogo, ya cobrado automático)\n\n` +
    `${pedido.direccionEntrega ? `Dirección: ${pedido.direccionEntrega}\n` : ""}` +
    `Pedido:\n${formatItemsForDispatch(pedido.items)}\n\n` +
    `Ya no hace falta que cotices — prepáralo en cuanto puedas. 🙏`;

  logStoreDispatch({
    orderId: pedido.id,
    tiendaId: pedido.tienda.tiendaId,
    tiendaNombre: pedido.tienda.nombre,
    tiendaTelefono,
    to: tiendaTelefono,
    body: aviso,
  });

  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "cotizacion_tienda",
    destinatarioTipo: "negocio",
    destinatarioId: pedido.tienda.tiendaId,
    telefonoDestino: tiendaTelefono,
    payload: { body: aviso },
    idempotencyKey: `pedido:${pedido.id}:cotizacion_tienda:v1`,
  });

  return { ok: true };
}

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

  // pedido en memoria no trae el estado recién escrito por el UPDATE de
  // arriba — solo estado importa para lo que sigue (tienda/items/cliente no
  // cambiaron), así que se sobreescribe local en vez de releer de la BD.
  const claimed: PedidoFullRecord = { ...pedido, estado: "pendiente_tiendas" };

  if (claimed.tienda?.usaCatalogoFijo) {
    return dispatchCatalogoFijo(claimed, params);
  }

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
