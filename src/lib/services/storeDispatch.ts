import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { ensureMxWhatsappIntl } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import {
  appendPedidoEvento,
  getProductosTiendaActivos,
  removePedidoItem,
  setPedidoEstado,
  setPedidoItemDisponible,
  setPedidoTiendaCotizacion,
  setPedidoTiendaEstado,
  setPedidoTotales,
  type PedidoFullRecord,
} from "@/lib/repositories/pedidoRepositoryV2";
import { buildOrderTimeoutMetadata } from "@/lib/services/orderTimeouts";
import { matchCatalogProduct, priceCatalogOrder } from "@/lib/catalogQuantities";
import { formatCatalogReceiptNotice, formatCustomerQuoteMessage, formatScheduledSentNotice } from "@/lib/customerUx";
import { formatCheckedLines, formatNameQtyLine, joinBlocks } from "@/lib/messageStyle";
import { dispatchItemAlreadyShowsQty } from "@/lib/services/captureEngine";
import { calculateFinalPrice, MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE, mensajeClienteProductoNoDisponible } from "@/lib/ordenes";
import { formatAbarrotesQuoteRequest, formatCatalogStoreConfirmRequest } from "@/lib/storeOrderCommands";
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
  if (!items.length) return "🛍️ *Sin productos*";
  return joinBlocks(
    items.map((it) => {
      const name = it.nombreProducto.trim() || "producto";
      return formatNameQtyLine(name, it.cantidad, it.cantidad != null && dispatchItemAlreadyShowsQty(name, it.cantidad));
    }),
  );
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
  itemLines?: string[] | null;
  /**
   * confirm: el cliente todavía tiene que decir SÍ al total (tienda que cotiza).
   * receipt: ya confirmó; se manda el total sin pedir otro SÍ.
   * none: no se le escribe en este paso.
   */
  customerUpdate?: "confirm" | "receipt" | "none";
}): Promise<{ total: number }> {
  const { pedido, subtotal, actorTipo } = params;
  const customerUpdate = params.customerUpdate ?? "confirm";
  if (!pedido.tienda) throw new Error(`finalizeStoreQuote: pedido ${pedido.id} sin tienda vinculada`);

  const total = calculateFinalPrice(subtotal);
  const itemLines =
    params.itemLines ??
    formatItemsForDispatch(pedido.items.filter((item) => item.disponible !== false))
      .split("\n")
      .filter((line) => line.trim().length > 0);

  await setPedidoTiendaCotizacion({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, subtotal });
  await setPedidoTotales({
    pedidoId: pedido.id,
    servicioMandalo: MANDALO_SERVICE_FEE,
    servicioRepartidor: MANDALO_DELIVERY_FEE,
    totalCliente: total,
  });
  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "confirmado_tiendas",
    metadataPatch:
      customerUpdate === "confirm"
        ? buildOrderTimeoutMetadata("final_confirmation")
        : { catalogo_confirmado: true, sin_repartidor: false },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "cotizacion_recibida",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "confirmado_tiendas",
    actorTipo,
    payload: { subtotal, total },
  });

  if (customerUpdate !== "none") {
    const msg =
      customerUpdate === "receipt"
        ? formatCatalogReceiptNotice({
            tiendaNombre: pedido.tienda.nombre ?? "la tienda",
            pedidoId: pedido.id,
            subtotal,
            total,
            itemLines,
          })
        : formatCustomerQuoteMessage({
            tiendaNombre: pedido.tienda.nombre ?? "la tienda",
            pedidoId: pedido.id,
            subtotal,
            total,
            itemLines,
          });
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "notificacion_cliente",
      destinatarioTipo: "cliente",
      telefonoDestino: pedido.clienteTelefono,
      payload: { body: msg },
      idempotencyKey:
        customerUpdate === "receipt"
          ? `pedido:${pedido.id}:catalogo:recibo:v1`
          : `pedido:${pedido.id}:cliente:cotizacion_recibida:v1`,
    });
    await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msg, estado: "bot" }).catch(() => {});
  }

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

  const msgCliente = mensajeClienteProductoNoDisponible(pedido.tienda.nombre, item.nombreProducto);
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

// Tiendas con tiendas.usa_catalogo_fijo = true (George, La Central): el
// subtotal sale del menú, pero la tienda confirma con ORDEN #N CONFIRMO
// antes del repartidor. Mismo estado pendiente_tiendas y el mismo timeout
// de 10 min que abarrotes. Un producto que no está en el menú se trata
// como faltante automático (flagItemUnavailable).
async function dispatchCatalogoFijo(
  pedido: PedidoFullRecord,
  params: {
    fromEstado: OrderState;
    actorTipo: "cliente" | "sistema";
    catalogAlreadyConfirmed?: boolean;
    sendCustomerReceipt?: boolean;
    noticeKey?: string;
  },
): Promise<DispatchCotizacionResult> {
  if (!pedido.tienda?.telefono) return { ok: false, reason: "no_store_phone" };

  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "dispatch_tienda",
    estadoOrigen: params.fromEstado,
    estadoDestino: "pendiente_tiendas",
    actorTipo: params.actorTipo,
    payload: { catalogoFijo: true, clienteYaConfirmo: params.catalogAlreadyConfirmed === true },
  });

  const catalogo = await getProductosTiendaActivos(pedido.tienda.tiendaId);
  const matches = pedido.items
    .filter((item) => item.disponible !== false)
    .map((item) => ({ item, match: matchCatalogProduct(catalogo, item.nombreProducto) }));

  const missing = matches.find((m) => !m.match);
  if (missing) {
    await flagItemUnavailable({ pedido, item: missing.item, actorTipo: "sistema" });
    return { ok: true };
  }

  const subtotal = matches.reduce((sum, m) => sum + m.match!.precio * (m.item.cantidad ?? 1), 0);
  const priced = priceCatalogOrder(
    matches.map((entry) => ({ nombre_producto: entry.item.nombreProducto, cantidad: entry.item.cantidad })),
    catalogo,
  );
  // El cliente ya confirmó el menú. La tienda igual manda CONFIRMO
  // antes de que el pedido pase al repartidor. El precio no se vuelve a pedir.
  if (params.sendCustomerReceipt) {
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "notificacion_cliente",
      destinatarioTipo: "cliente",
      destinatarioId: null,
      telefonoDestino: ensureMxWhatsappIntl(pedido.clienteTelefono),
      payload: {
        body: formatScheduledSentNotice(pedido.id, pedido.tienda.nombre ?? "la tienda", true),
      },
      idempotencyKey: `pedido:${pedido.id}:esperando_apertura:dispatched:v1`,
    });
  }

  const tiendaTelefono = ensureMxWhatsappIntl(pedido.tienda.telefono);
  const aviso = formatCatalogStoreConfirmRequest({
    pedidoId: pedido.id,
    direccion: pedido.direccionEntrega,
    pedidoTexto: formatCheckedLines(priced.lines),
    subtotal,
    total: calculateFinalPrice(subtotal),
  });

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
    idempotencyKey: params.noticeKey ?? `pedido:${pedido.id}:cotizacion_tienda:v1`,
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
  params: {
    fromEstado: OrderState;
    actorTipo: "cliente" | "sistema";
    catalogAlreadyConfirmed?: boolean;
    sendCustomerReceipt?: boolean;
    /** Otra vuelta a la tienda, cuando el cliente dejó el pedido sin un faltante. */
    noticeKey?: string;
  },
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

  try {
    const { scheduleAppPush } = await import("@/lib/app/notifyHook");
    await scheduleAppPush({ pedidoId: pedido.id, estado: "pendiente_tiendas", previousEstado: params.fromEstado });
  } catch (pushError: unknown) {
    console.error("[app-push] el aviso no salió", pushError instanceof Error ? pushError.message : pushError);
  }

  // pedido en memoria no trae el estado recién escrito por el UPDATE de
  // arriba — solo estado importa para lo que sigue (tienda/items/cliente no
  // cambiaron), así que se sobreescribe local en vez de releer de la BD.
  const claimed: PedidoFullRecord = { ...pedido, estado: "pendiente_tiendas" };

  if (claimed.tienda?.usaCatalogoFijo) {
    return dispatchCatalogoFijo(claimed, params);
  }

  const tiendaTelefono = ensureMxWhatsappIntl(pedido.tienda.telefono);
  const encabezado = formatAbarrotesQuoteRequest({
    pedidoId: pedido.id,
    direccion: pedido.direccionEntrega,
    pedidoTexto: formatItemsForDispatch(pedido.items),
  });

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
    idempotencyKey: params.noticeKey ?? `pedido:${pedido.id}:cotizacion_tienda:v1`,
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

/**
 * La tienda marcó faltantes. Se quitan, el pedido espera el sí/no del cliente
 * y sale un solo aviso (outbox). No manda nada a la tienda: el acuse va en
 * el turno del webhook.
 */
export async function askCustomerAboutRemovedItems(params: {
  pedido: PedidoFullRecord;
  removed: Array<{ id: number; nombreProducto: string }>;
  body: string;
}): Promise<void> {
  const { pedido, removed } = params;
  if (!pedido.tienda) throw new Error(`askCustomerAboutRemovedItems: pedido ${pedido.id} sin tienda`);
  const ids = removed.map((item) => item.id).sort((a, b) => a - b);
  const nombres = removed.map((item) => item.nombreProducto);

  for (const item of removed) {
    await removePedidoItem(item.id);
  }

  await setPedidoTiendaEstado({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, estadoTienda: "ajuste_producto" });
  await setPedidoEstado({
    pedidoId: pedido.id,
    estado: "ajuste_producto",
    metadataPatch: {
      ...buildOrderTimeoutMetadata("product_adjustment"),
      product_adjustment_mode: "confirmar_restante",
      product_adjustment_removed: nombres,
      product_adjustment_removed_ids: ids,
      product_adjustment_item_nombre: nombres.join(", "),
      product_adjustment_item_id: ids[0] ?? null,
    },
  });
  await appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "producto_no_disponible",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "ajuste_producto",
    actorTipo: "tienda",
    payload: { itemIds: ids, itemNombres: nombres },
  });

  await outboxRepository.enqueueOutboundMessage({
    pedidoId: pedido.id,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: params.body },
    idempotencyKey: `pedido:${pedido.id}:cliente:sin_productos:${ids.join("-")}:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: params.body, estado: "bot" }).catch(() => {});
}
