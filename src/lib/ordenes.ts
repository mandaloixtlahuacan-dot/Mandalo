import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrderState, TransitionContext } from "@/lib/orderStateMachine";
import {
  assertTransition,
  buildGoogleMapsLink,
  normalizeLegacyState,
} from "@/lib/orderStateMachine";
import {
  enqueueAdminNotification,
  mirrorOrderEvent,
  mirrorOrderUpsertFromLegacy,
} from "@/lib/dualWrite";

// ----------------------------
// Tipos internos (Bloque 2)
// ----------------------------
type OrderItem = {
  name: string;
  qty?: string | null;
  details?: string | null;
};

type OrderSnapshot = {
  // Convenciones actuales/legacy que se han usado en detalle_pedido
  stage?: string | null;
  items?: OrderItem[] | null;
  address_text?: string | null;
  addressText?: string | null;
  customer_name?: string | null;
  customerName?: string | null;

  business_id?: number | string | null;
  businessId?: number | string | null;
  business_name?: string | null;
  businessName?: string | null;
  business_phone?: string | null;
  businessPhone?: string | null;

  courier_id?: number | string | null;
  courierId?: number | string | null;
  courier_phone?: string | null;
  courierPhone?: string | null;
  repartidor_nombre?: string | null;

  zoneValidation?: boolean | null;
  logistics?: unknown;
  total?: number | null;
};

type StoredOrderRecord = {
  id: number;
  estado: string | null;
  detalle_pedido: string | null;
  total: number | null;
  telefono_cliente: string | null;
  created_at: string | null;
};

export type OrderSnapshotResult = {
  record: StoredOrderRecord;
  legacyStateRaw: string | null;
  state: OrderState | null;
  snapshot: OrderSnapshot;
};

export type TransitionOrderStateParams = {
  orderId: number;
  to: OrderState;
  contextOverrides?: Partial<TransitionContext>;
  snapshotPatch?: Partial<OrderSnapshot>;
  dbPatch?: Record<string, unknown>;
};

export function safeParseOrderSnapshot(value: unknown): OrderSnapshot {
  if (value && typeof value === "object") return value as OrderSnapshot;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") return parsed as OrderSnapshot;
    return {};
  } catch {
    return {};
  }
}

export function normalizeStoredOrderState(raw: string | null | undefined): OrderState | null {
  return normalizeLegacyState(String(raw ?? ""));
}

function isChatEstado(raw: string | null | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "cliente" || v === "bot" || v === "tienda" || v === "repartidor" || v === "sistema";
}

export function serializeOrderStateForPersistence(state: OrderState): string {
  const map: Record<OrderState, string> = {
    capturando_pedido: "collecting",
    pendiente_confirmacion_cliente: "esperando_confirmacion",
    pendiente_cotizacion_tienda: "awaiting_quote",
    pendiente_aprobacion_total: "awaiting_confirm",
    pendiente_aceptacion_repartidor: "en_proceso",
    repartidor_confirmado: "repartidor_asignado",
    pedido_recogido: "en_camino",
    repartidor_en_destino: "llegado",
    pendiente: "pendiente",
    confirmado: "confirmado",
    dispatch_repartidor_pendiente: "en_proceso",
    confirmado_para_repartidor: "repartidor_asignado",
    reasignacion_pendiente: "reasignacion_pendiente",
    recogido: "recogido",
    en_camino: "en_camino",
    entregado: "completado",
    cancelado: "cancelado",
    rechazado_fuera_de_zona: "rechazado_fuera_de_zona",
    bloqueado_operativamente: "bloqueado_operativamente",
  };
  return map[state];
}

export const MANDALO_SERVICE_FEE = 20;
export const DELIVERY_FEE = 35;
export const MANDALO_DELIVERY_FEE = DELIVERY_FEE;

export function calculateOrderTotal(storePrice: number) {
  const base = Number(storePrice);
  const precioTienda = Number.isFinite(base) && base > 0 ? base : 0;
  const total = precioTienda + MANDALO_SERVICE_FEE + DELIVERY_FEE;

  return {
    precioTienda,
    servicioMandalo: MANDALO_SERVICE_FEE,
    servicioDomicilio: DELIVERY_FEE,
    total,
  };
}

export function calculateFinalPrice(storePrice: number): number {
  return calculateOrderTotal(storePrice).total;
}

export type OrdenEstado =
  | "cotizando"
  | "esperando_confirmacion"
  | "asignado"
  | "en_camino"
  | "entregado"
  | "cancelado";

export async function crearOrden(params: {
  telefonoCliente: string;
  resumenPedido: string;
  estado?: string;
}) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("pedidos")
    .insert({
      telefono_cliente: params.telefonoCliente,
      // En este despliegue, la tabla "pedidos" funciona como registro de órdenes.
      // Usamos detalle_pedido como resumen del pedido.
      detalle_pedido: params.resumenPedido,
      estado: params.estado ?? "cotizando",
    })
    .select("id")
    .single();
  if (error) throw error;

  const legacyPedidoId = Number(data.id);

  // Dual write (best-effort): intento de espejo inicial, nunca rompe legacy.
  try {
    const canonical = normalizeLegacyState(params.estado ?? "") ?? "capturando_pedido";
    let snapshot: Record<string, unknown> = {};
    try {
      snapshot = JSON.parse(String(params.resumenPedido ?? "{}")) as Record<string, unknown>;
    } catch {
      snapshot = {};
    }
    const addressText =
      (snapshot as { address_text?: unknown; addressText?: unknown }).address_text != null
        ? String((snapshot as { address_text: unknown }).address_text)
        : (snapshot as { addressText?: unknown }).addressText != null
          ? String((snapshot as { addressText: unknown }).addressText)
          : null;
    const mapsLink = buildGoogleMapsLink(addressText);
    await mirrorOrderUpsertFromLegacy({
      legacyPedidoId,
      telefonoCliente: params.telefonoCliente,
      canonicalEstado: canonical,
      snapshot,
      total: (snapshot as { total?: unknown }).total as number | null | undefined,
      addressText,
      mapsLink,
    });
  } catch (e: unknown) {
    console.error("[dualWrite] crearOrden mirror failed", {
      legacyPedidoId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return legacyPedidoId;
}

export async function buscarOrdenActivaCliente(telefonoCliente: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, created_at, telefono_cliente, detalle_pedido, total, estado")
    .eq("telefono_cliente", telefonoCliente)
    .in("estado", ["cotizando", "esperando_confirmacion", "asignado", "en_camino"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getOrderById(orderId: number): Promise<OrderSnapshotResult> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado, detalle_pedido, total, telefono_cliente, created_at")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Orden no encontrada: ${orderId}`);

  const toStoredRecord = (row: unknown): StoredOrderRecord => ({
    id: Number((row as { id: unknown }).id),
    estado: (row as { estado?: unknown }).estado == null ? null : String((row as { estado?: unknown }).estado),
    detalle_pedido:
      (row as { detalle_pedido?: unknown }).detalle_pedido == null
        ? null
        : String((row as { detalle_pedido?: unknown }).detalle_pedido),
    total:
      typeof (row as { total?: unknown }).total === "number"
        ? (row as { total?: number }).total ?? null
        : (row as { total?: number | null }).total ?? null,
    telefono_cliente:
      (row as { telefono_cliente?: unknown }).telefono_cliente == null
        ? null
        : String((row as { telefono_cliente?: unknown }).telefono_cliente),
    created_at:
      (row as { created_at?: unknown }).created_at == null
        ? null
        : String((row as { created_at?: unknown }).created_at),
  });

  let record: StoredOrderRecord = toStoredRecord(data);

  // Blindaje: la tabla legacy `public.pedidos` mezcla órdenes y mensajes (cliente/bot/tienda/repartidor).
  // Si nos piden un id que en realidad apunta a una fila de chat, buscamos la última orden real del mismo teléfono.
  if (isChatEstado(record.estado)) {
    const tel = String(record.telefono_cliente ?? "").trim();
    console.warn("[ordenes] getOrderById: id apunta a fila de chat; buscando orden real por teléfono", {
      orderId,
      estado: record.estado,
      telefono_cliente: tel || null,
    });

    if (tel) {
      const { data: fallback, error: fbErr } = await supabase
        .from("pedidos")
        .select("id, estado, detalle_pedido, total, telefono_cliente, created_at")
        .eq("telefono_cliente", tel)
        .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema)")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fbErr) throw fbErr;
      if (fallback) {
        record = toStoredRecord(fallback);
      }
    }
  }

  const legacyStateRaw = record.estado;
  const state = normalizeStoredOrderState(legacyStateRaw);
  const snapshot = safeParseOrderSnapshot(record.detalle_pedido);
  return { record, legacyStateRaw, state, snapshot };
}

export async function getActiveOrderByCustomerPhone(
  telefonoCliente: string,
): Promise<OrderSnapshotResult | null> {
  const supabase = getSupabaseAdmin();
  const sid = String(telefonoCliente ?? "").trim();
  const norm = sid.replace(/\D/g, "");
  const last10 = norm.length > 10 ? norm.slice(-10) : norm;
  const variants = Array.from(
    new Set([norm, last10, `52${last10}`, `521${last10}`].map((x) => String(x ?? "").trim()).filter(Boolean)),
  );
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado, detalle_pedido, total, telefono_cliente, created_at")
    .in("telefono_cliente", variants)
    // Conservador: ignoramos estados de chat si existieran
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const record: StoredOrderRecord = {
    id: Number((data as { id: unknown }).id),
    estado: (data as { estado?: unknown }).estado == null ? null : String((data as { estado?: unknown }).estado),
    detalle_pedido:
      (data as { detalle_pedido?: unknown }).detalle_pedido == null
        ? null
        : String((data as { detalle_pedido?: unknown }).detalle_pedido),
    total:
      typeof (data as { total?: unknown }).total === "number"
        ? (data as { total?: number }).total ?? null
        : (data as { total?: number | null }).total ?? null,
    telefono_cliente:
      (data as { telefono_cliente?: unknown }).telefono_cliente == null
        ? null
        : String((data as { telefono_cliente?: unknown }).telefono_cliente),
    created_at:
      (data as { created_at?: unknown }).created_at == null
        ? null
        : String((data as { created_at?: unknown }).created_at),
  };

  const legacyStateRaw = record.estado;
  const state = normalizeStoredOrderState(legacyStateRaw);
  const snapshot = safeParseOrderSnapshot(record.detalle_pedido);
  return { record, legacyStateRaw, state, snapshot };
}

export function buildTransitionContextFromOrder(
  order: OrderSnapshotResult,
  overrides?: Partial<TransitionContext>,
): TransitionContext {
  const s = order.snapshot ?? {};

  const items = (Array.isArray(s.items) ? s.items : null) ?? null;
  const addressText = (s.address_text ?? s.addressText ?? null) ?? null;
  const customerName = (s.customer_name ?? s.customerName ?? null) ?? null;
  const businessId = (s.business_id ?? s.businessId ?? null) ?? null;
  const businessName = (s.business_name ?? s.businessName ?? null) ?? null;
  const businessPhone = (s.business_phone ?? s.businessPhone ?? null) ?? null;
  const courierId = (s.courier_id ?? s.courierId ?? null) ?? null;
  const courierPhone = (s.courier_phone ?? s.courierPhone ?? null) ?? null;
  const total = order.record.total ?? s.total ?? null;
  const mapsLink = buildGoogleMapsLink(addressText);

  const ctx: TransitionContext = {
    orderId: order.record.id,
    customerPhone: order.record.telefono_cliente ?? null,
    customerName,
    businessId,
    businessName,
    businessPhone,
    courierId,
    courierPhone,
    addressText,
    mapsLink,
    items,
    total,
    zoneValidation: s.zoneValidation ?? null,
    logistics: s.logistics,
    business: { name: businessName, phone: businessPhone },
    courier: { name: s.repartidor_nombre ?? null, phone: courierPhone },
    courierAvailable: null,
    ...overrides,
  };

  return ctx;
}

export async function transitionOrderState(params: TransitionOrderStateParams): Promise<{
  orderId: number;
  from: OrderState;
  to: OrderState;
  persistedEstado: string;
}> {
  const { orderId, to, contextOverrides, snapshotPatch, dbPatch } = params;

  if (dbPatch && Object.prototype.hasOwnProperty.call(dbPatch, "estado")) {
    throw new Error("dbPatch no puede incluir 'estado' (usa transitionOrderState.to)");
  }

  const current = await getOrderById(orderId);
  const from = current.state;
  if (!from) {
    throw new Error(`No se pudo normalizar el estado almacenado: ${current.legacyStateRaw ?? "(null)"}`);
  }

  const mergedSnapshot: OrderSnapshot = { ...(current.snapshot ?? {}), ...(snapshotPatch ?? {}) };
  const nextOrder: OrderSnapshotResult = { ...current, snapshot: mergedSnapshot };
  const context = buildTransitionContextFromOrder(nextOrder, contextOverrides);

  assertTransition(from, to, context);

  const persistedEstado = serializeOrderStateForPersistence(to);
  const updatePayload: Record<string, unknown> = {
    ...(dbPatch ?? {}),
    estado: persistedEstado,
    detalle_pedido: JSON.stringify(mergedSnapshot),
  };

  // Persistir total si viene explícito o si el snapshot lo trae
  const totalFromSnapshot =
    typeof mergedSnapshot.total === "number" && Number.isFinite(mergedSnapshot.total) ? mergedSnapshot.total : null;
  const totalFromDbPatch =
    typeof (dbPatch as { total?: unknown } | undefined)?.total === "number"
      ? ((dbPatch as { total: number }).total as number)
      : null;
  if (totalFromDbPatch != null) updatePayload.total = totalFromDbPatch;
  else if (totalFromSnapshot != null) updatePayload.total = totalFromSnapshot;

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedidos").update(updatePayload).eq("id", orderId);
  if (error) throw error;

  // Dual write (best-effort): espejo v2 + auditoría + outbox. NUNCA rompe legacy.
  try {
    const telefonoCliente = String(current.record.telefono_cliente ?? "").trim();
    const addressText =
      mergedSnapshot.address_text ?? mergedSnapshot.addressText ?? null;
    const mapsLink = buildGoogleMapsLink(addressText);

    const totalForMirror =
      typeof updatePayload.total === "number"
        ? (updatePayload.total as number)
        : typeof mergedSnapshot.total === "number"
          ? mergedSnapshot.total
          : null;

    const negocioId =
      typeof mergedSnapshot.business_id === "number"
        ? mergedSnapshot.business_id
        : typeof mergedSnapshot.businessId === "number"
          ? mergedSnapshot.businessId
          : null;

    const repartidorId =
      typeof mergedSnapshot.courier_id === "number"
        ? mergedSnapshot.courier_id
        : typeof mergedSnapshot.courierId === "number"
          ? mergedSnapshot.courierId
          : null;

    const zoneValidation =
      typeof mergedSnapshot.zoneValidation === "boolean" ? mergedSnapshot.zoneValidation : null;

    const upsertResult = await mirrorOrderUpsertFromLegacy({
      legacyPedidoId: orderId,
      telefonoCliente,
      canonicalEstado: to,
      snapshot: mergedSnapshot as unknown as Record<string, unknown>,
      total: totalForMirror,
      addressText,
      mapsLink,
      negocioId,
      repartidorId,
      estaEnZonaServicio: zoneValidation,
    });

    const tasks: Promise<unknown>[] = [];
    if (upsertResult.pedidoV2Id) {
      tasks.push(
        mirrorOrderEvent({
          pedidoV2Id: upsertResult.pedidoV2Id,
          tipoEvento: "transition",
          estadoOrigen: from,
          estadoDestino: to,
          actorTipo: "sistema",
          actorTelefono: null,
          descripcion: `Transición ${from} -> ${to}`,
          payload: {
            legacyPedidoId: orderId,
            telefonoCliente,
          },
        }),
      );

      if (to === "entregado") {
        tasks.push(
          enqueueAdminNotification({
            pedidoV2Id: upsertResult.pedidoV2Id,
            tipo: "venta_entregada",
            contenido: `Pedido entregado (v2:${upsertResult.pedidoV2Id}, legacy:${orderId}). Total: ${totalForMirror ?? "N/A"}`,
          }),
        );
      }
    }

    await Promise.allSettled(tasks);
  } catch (e: unknown) {
    console.error("[dualWrite] transitionOrderState mirror failed", {
      legacyPedidoId: orderId,
      from,
      to,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return { orderId, from, to, persistedEstado };
}

export async function actualizarOrden(ordenId: number, patch: Record<string, unknown>) {
  // Legacy (compatibilidad): mutación directa de columnas.
  // Nota: futuras transiciones de estado deben migrar a transitionOrderState().
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedidos").update(patch).eq("id", ordenId);
  if (error) throw error;
}

export async function asignarRepartidor(ordenId: number) {
  const supabase = getSupabaseAdmin();

  const { data: rep, error } = await supabase
    .from("repartidores")
    .select("id, nombre, whatsapp")
    .eq("activo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!rep?.id || !rep?.whatsapp) return null;

  // No guardamos repartidor_id en "pedidos" porque la tabla no lo tiene.
  // El mensajero confirma/actualiza por WhatsApp referenciando ORDEN #<id>.
  await actualizarOrden(ordenId, { estado: "asignado" });
  return { id: Number(rep.id), nombre: rep.nombre as string | null, whatsapp: rep.whatsapp as string };
}

export function extraerOrdenId(texto: string): number | null {
  const normalized = String(texto ?? "");
  const m =
    normalized.match(/\borden\s*#\s*(\d+)/i) ||
    normalized.match(/\borden\s+(\d+)/i) ||
    normalized.match(/#\s*(\d+)/) ||
    normalized.match(/\b(\d+)\s*(?:precio|total)\b/i);
  return m ? Number(m[1]) : null;
}

export function extraerPrecio(texto: string): number | null {
  // IMPORTANTE:
  // En mensajes como: "ORDEN #162 PRECIO 87" no queremos capturar 162.
  // Extraemos estrictamente el número DESPUÉS de la palabra "PRECIO" o "TOTAL".
  const normalized = String(texto ?? "").replace(/,/g, ".");
  const m =
    normalized.match(/\bprecio\b[^0-9]*([0-9]+(\.[0-9]+)?)/i) ||
    normalized.match(/\btotal\b[^0-9]*([0-9]+(\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

export function esConfirmacionCliente(texto: string): boolean {
  return /\b(si|sí|ok|va|confirmo|confirmar|dale|de acuerdo)\b/i.test(texto.trim());
}

export function esActualizacionRepartidor(texto: string): OrdenEstado | null {
  const t = texto.toLowerCase();
  if (t.includes("en camino") || t.includes("voy")) return "en_camino";
  if (t.includes("entregado") || t.includes("entregue") || t.includes("entregué")) return "entregado";
  if (t.includes("cancel")) return "cancelado";
  return null;
}
