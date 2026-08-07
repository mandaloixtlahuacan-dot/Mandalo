import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import type { OrderState } from "@/lib/orderStateMachine";
import type { PedidoItemInput, PedidoSnapshot, PedidoV2Record } from "@/lib/services/captureEngine";

type UnknownRow = Record<string, unknown>;

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function toPlainObject(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getPhoneVariants(rawPhone: string): string[] {
  const sid = normalizePhone(String(rawPhone ?? ""));
  const last10 = sid.length > 10 ? sid.slice(-10) : sid;
  return Array.from(
    new Set([sid, last10, `52${last10}`, `521${last10}`].map((x) => String(x ?? "").trim()).filter(Boolean)),
  );
}

function composeItemText(item: PedidoItemInput): string {
  return [item.nombre_producto, item.marca, item.presentacion, item.unidad, item.notas]
    .map((part) => cleanText(part))
    .filter(Boolean)
    .join(" ");
}

function mapPedidoRow(row: UnknownRow): PedidoV2Record {
  const metadata = toPlainObject(row.metadata_json as Record<string, unknown> | null);
  return {
    id: Number(row.id),
    estado: String(row.estado ?? "seleccion_productos") as OrderState,
    snapshot_json: (metadata.capture_snapshot as PedidoSnapshot | undefined) ?? {},
  };
}

async function ensureClienteByPhone(phone: string, customerName?: string | null): Promise<string> {
  const supabase = getSupabaseAdmin();
  const telefono = normalizePhone(phone);
  if (!telefono) throw new Error("Teléfono de cliente inválido.");

  const payload: Record<string, unknown> = { telefono };
  const nombre = cleanText(customerName);
  if (nombre) payload.nombre = nombre;

  const { error } = await supabase.from("clientes_new").upsert(payload, { onConflict: "telefono" });
  if (error) throw error;
  return telefono;
}

async function getPedidoTiendaId(pedidoId: number): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedido_tiendas")
    .select("id")
    .eq("pedido_id", pedidoId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id != null ? Number(data.id) : null;
}

async function upsertPedidoTienda(params: { pedidoId: number; tiendaId: number }): Promise<void> {
  const supabase = getSupabaseAdmin();
  const existingId = await getPedidoTiendaId(params.pedidoId);

  if (existingId != null) {
    const { error } = await supabase
      .from("pedido_tiendas")
      .update({ tienda_id: params.tiendaId })
      .eq("id", existingId);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("pedido_tiendas").insert({
    pedido_id: params.pedidoId,
    tienda_id: params.tiendaId,
    estado_tienda: "pendiente",
  });
  if (error) throw error;
}

export async function getOpenPedidoByCustomerPhone(phone: string): Promise<PedidoV2Record | null> {
  const supabase = getSupabaseAdmin();
  const phoneVariants = getPhoneVariants(phone);

  // No hace falta filtrar por estado: la regla de retención borra el pedido en
  // cuanto llega a entregado/cancelado, así que cualquier fila que exista para
  // este teléfono es, por definición, un pedido activo.
  const { data, error } = await supabase
    .from("pedidos_new")
    .select("id, estado, metadata_json")
    .in("cliente_telefono", phoneVariants)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapPedidoRow(data as UnknownRow);
}

export async function getOrCreateDraftPedido(params: {
  customerPhone: string;
  customerName?: string | null;
}): Promise<PedidoV2Record> {
  const existing = await getOpenPedidoByCustomerPhone(params.customerPhone);
  if (existing) return existing;

  const supabase = getSupabaseAdmin();
  const telefono = await ensureClienteByPhone(params.customerPhone, params.customerName ?? null);

  const { data, error } = await supabase
    .from("pedidos_new")
    .insert({
      cliente_telefono: telefono,
      estado: "seleccion_productos" satisfies OrderState,
    })
    .select("id, estado, metadata_json")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("No se pudo crear el pedido draft en pedidos_new.");
  return mapPedidoRow(data as UnknownRow);
}

export async function updatePedidoSnapshot(params: {
  pedidoId: number;
  estado: OrderState;
  snapshot: PedidoSnapshot;
  addressText?: string | null;
  latitud?: number | null;
  longitud?: number | null;
  tiendaId?: number | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: current, error: readError } = await supabase
    .from("pedidos_new")
    .select("metadata_json")
    .eq("id", params.pedidoId)
    .maybeSingle();
  if (readError) throw readError;

  const metadata = toPlainObject(current?.metadata_json as Record<string, unknown> | null);
  metadata.capture_snapshot = toPlainObject(params.snapshot as unknown as Record<string, unknown>);

  const { error } = await supabase
    .from("pedidos_new")
    .update({
      estado: params.estado,
      direccion_entrega: cleanText(params.addressText) ?? null,
      latitud: params.latitud ?? null,
      longitud: params.longitud ?? null,
      metadata_json: metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.pedidoId);
  if (error) throw error;

  if (params.tiendaId != null) {
    await upsertPedidoTienda({ pedidoId: params.pedidoId, tiendaId: params.tiendaId });
  }
}

export async function replacePedidoItems(params: {
  pedidoId: number;
  items: PedidoItemInput[];
}): Promise<void> {
  const pedidoTiendaId = await getPedidoTiendaId(params.pedidoId);
  // Sin tienda elegida todavía no hay dónde colgar los productos — se
  // reintenta en el siguiente turno una vez que el cliente elige negocio
  // (el LLM vuelve a emitir los items ya conocidos con el historial de chat).
  if (pedidoTiendaId == null) return;

  const supabase = getSupabaseAdmin();
  const { error: deleteErr } = await supabase
    .from("pedido_items_new")
    .delete()
    .eq("pedido_tienda_id", pedidoTiendaId);
  if (deleteErr) throw deleteErr;

  if (!params.items.length) return;

  const rows = params.items
    .map((item) => ({
      pedido_tienda_id: pedidoTiendaId,
      nombre_producto: composeItemText(item),
      cantidad: item.cantidad ?? null,
    }))
    .filter((row) => row.nombre_producto.length > 0);

  if (!rows.length) return;

  const { error: insertErr } = await supabase.from("pedido_items_new").insert(rows);
  if (insertErr) throw insertErr;
}

export async function appendPedidoEvento(params: {
  pedidoId: number;
  tipoEvento: string;
  estadoOrigen?: OrderState | null;
  estadoDestino?: OrderState | null;
  actorTipo: "cliente" | "bot" | "tienda" | "repartidor" | "sistema";
  payload?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedido_eventos").insert({
    pedido_id: params.pedidoId,
    tipo_evento: params.tipoEvento,
    estado_origen: params.estadoOrigen ?? null,
    estado_destino: params.estadoDestino ?? null,
    actor_tipo: params.actorTipo,
    payload_json: toPlainObject(params.payload),
  });

  if (error) throw error;
}

export async function getPedidoTiendaIdForPedido(pedidoId: number): Promise<number | null> {
  return getPedidoTiendaId(pedidoId);
}

export type PedidoFullRecord = {
  id: number;
  estado: OrderState;
  clienteTelefono: string;
  repartidorId: number | null;
  direccionEntrega: string | null;
  latitud: number | null;
  longitud: number | null;
  servicioMandalo: number;
  servicioRepartidor: number | null;
  totalCliente: number | null;
  metadata: Record<string, unknown>;
  snapshot: PedidoSnapshot;
  tienda: {
    pedidoTiendaId: number;
    tiendaId: number;
    nombre: string | null;
    telefono: string | null;
    subtotal: number | null;
    estadoTienda: string;
  } | null;
  items: Array<{ id: number; nombreProducto: string; cantidad: number | null }>;
};

// Lectura completa de un pedido (con su tienda e items) por id — para los
// handlers de tienda/repartidor en mandaloFlow.ts, que solo conocen el
// ORDEN #<id> mencionado en el mensaje entrante, no el teléfono del cliente.
export async function getPedidoById(pedidoId: number): Promise<PedidoFullRecord | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos_new")
    .select(
      "id, estado, cliente_telefono, repartidor_id, direccion_entrega, latitud, longitud, " +
        "servicio_mandalo, servicio_repartidor, total_cliente, metadata_json, " +
        "pedido_tiendas(id, tienda_id, subtotal_tienda, estado_tienda, tiendas(nombre, telefono), pedido_items_new(id, nombre_producto, cantidad))",
    )
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as UnknownRow;
  const metadata = toPlainObject(row.metadata_json as Record<string, unknown> | null);
  const pedidoTiendasRaw = Array.isArray(row.pedido_tiendas) ? row.pedido_tiendas : [];
  const pt = pedidoTiendasRaw[0] as UnknownRow | undefined;
  const tiendaRaw = pt?.tiendas;
  const tiendaInfo = (Array.isArray(tiendaRaw) ? tiendaRaw[0] : tiendaRaw) as UnknownRow | undefined;
  const itemsRaw = pt && Array.isArray(pt.pedido_items_new) ? (pt.pedido_items_new as UnknownRow[]) : [];

  return {
    id: Number(row.id),
    estado: String(row.estado ?? "seleccion_productos") as OrderState,
    clienteTelefono: String(row.cliente_telefono ?? ""),
    repartidorId: row.repartidor_id == null ? null : Number(row.repartidor_id),
    direccionEntrega: row.direccion_entrega == null ? null : String(row.direccion_entrega),
    latitud: row.latitud == null ? null : Number(row.latitud),
    longitud: row.longitud == null ? null : Number(row.longitud),
    servicioMandalo: Number(row.servicio_mandalo ?? 20),
    servicioRepartidor: row.servicio_repartidor == null ? null : Number(row.servicio_repartidor),
    totalCliente: row.total_cliente == null ? null : Number(row.total_cliente),
    metadata,
    snapshot: (metadata.capture_snapshot as PedidoSnapshot | undefined) ?? {},
    tienda: pt
      ? {
          pedidoTiendaId: Number(pt.id),
          tiendaId: Number(pt.tienda_id),
          nombre: tiendaInfo?.nombre == null ? null : String(tiendaInfo.nombre),
          telefono: tiendaInfo?.telefono == null ? null : String(tiendaInfo.telefono),
          subtotal: pt.subtotal_tienda == null ? null : Number(pt.subtotal_tienda),
          estadoTienda: String(pt.estado_tienda ?? "pendiente"),
        }
      : null,
    items: itemsRaw.map((it) => ({
      id: Number(it.id),
      nombreProducto: String(it.nombre_producto ?? ""),
      cantidad: it.cantidad == null ? null : Number(it.cantidad),
    })),
  };
}

export async function setPedidoTiendaCotizacion(params: {
  pedidoTiendaId: number;
  subtotal: number;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedido_tiendas")
    .update({ subtotal_tienda: params.subtotal, estado_tienda: "confirmado" })
    .eq("id", params.pedidoTiendaId);
  if (error) throw error;
}

export async function setPedidoTotales(params: {
  pedidoId: number;
  servicioRepartidor: number;
  totalCliente: number;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedidos_new")
    .update({
      servicio_repartidor: params.servicioRepartidor,
      total_cliente: params.totalCliente,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.pedidoId);
  if (error) throw error;
}

export async function setPedidoEstado(params: { pedidoId: number; estado: OrderState }): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedidos_new")
    .update({ estado: params.estado, updated_at: new Date().toISOString() })
    .eq("id", params.pedidoId);
  if (error) throw error;
}
