import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import { resetChatHistory } from "@/lib/messages";
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

  const { error } = await supabase.from("clientes").upsert(payload, { onConflict: "telefono" });
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

  // La retención borra el pedido en cuanto llega a entregado/cancelado
  // (finalizePedidoRetention), así que en operación normal nunca debería
  // quedar una fila terminal para este teléfono. Aun así se filtra por
  // estado explícitamente: si esa limpieza falla a medias (o hay filas de
  // antes de que existiera esta regla), un pedido viejo entregado/cancelado
  // no debe "revivir" y mezclarse con el siguiente pedido del cliente — bug
  // real ya confirmado en producción (ver ROADMAP.md).
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado, metadata_json")
    .in("cliente_telefono", phoneVariants)
    .not("estado", "in", "(entregado,cancelado)")
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
    .from("pedidos")
    .insert({
      cliente_telefono: telefono,
      estado: "seleccion_productos" satisfies OrderState,
    })
    .select("id, estado, metadata_json")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("No se pudo crear el pedido draft en pedidos.");
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
    .from("pedidos")
    .select("metadata_json")
    .eq("id", params.pedidoId)
    .maybeSingle();
  if (readError) throw readError;

  const metadata = toPlainObject(current?.metadata_json as Record<string, unknown> | null);
  metadata.capture_snapshot = toPlainObject(params.snapshot as unknown as Record<string, unknown>);

  const { error } = await supabase
    .from("pedidos")
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
    .from("pedido_items")
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

  const { error: insertErr } = await supabase.from("pedido_items").insert(rows);
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
    direccion: string | null;
    horaApertura: string | null;
    horaCierre: string | null;
    subtotal: number | null;
    estadoTienda: string;
  } | null;
  items: Array<{ id: number; nombreProducto: string; cantidad: number | null; disponible: boolean }>;
};

// Lectura completa de un pedido (con su tienda e items) por id — para los
// handlers de tienda/repartidor en mandaloFlow.ts, que solo conocen el
// ORDEN #<id> mencionado en el mensaje entrante, no el teléfono del cliente.
export async function getPedidoById(pedidoId: number): Promise<PedidoFullRecord | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select(
      "id, estado, cliente_telefono, repartidor_id, direccion_entrega, latitud, longitud, " +
        "servicio_mandalo, servicio_repartidor, total_cliente, metadata_json, " +
        "pedido_tiendas(id, tienda_id, subtotal_tienda, estado_tienda, tiendas(nombre, telefono, direccion, hora_apertura, hora_cierre), pedido_items(id, nombre_producto, cantidad, disponible))",
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
  const itemsRaw = pt && Array.isArray(pt.pedido_items) ? (pt.pedido_items as UnknownRow[]) : [];

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
          direccion: tiendaInfo?.direccion == null ? null : String(tiendaInfo.direccion),
          horaApertura: tiendaInfo?.hora_apertura == null ? null : String(tiendaInfo.hora_apertura),
          horaCierre: tiendaInfo?.hora_cierre == null ? null : String(tiendaInfo.hora_cierre),
          subtotal: pt.subtotal_tienda == null ? null : Number(pt.subtotal_tienda),
          estadoTienda: String(pt.estado_tienda ?? "pendiente"),
        }
      : null,
    items: itemsRaw.map((it) => ({
      id: Number(it.id),
      nombreProducto: String(it.nombre_producto ?? ""),
      cantidad: it.cantidad == null ? null : Number(it.cantidad),
      disponible: it.disponible !== false,
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

export async function setPedidoTiendaEstado(params: {
  pedidoTiendaId: number;
  estadoTienda: "pendiente" | "confirmado" | "ajuste_producto" | "cancelado";
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedido_tiendas")
    .update({ estado_tienda: params.estadoTienda })
    .eq("id", params.pedidoTiendaId);
  if (error) throw error;
}

// Coincidencia difusa (exacta, luego parcial) del texto que manda la tienda
// en #NO_DISPONIBLE contra los productos reales del pedido — mismo patrón de
// "exacto, luego ILIKE" que resolveTiendaStrictByName en mandaloFlow.ts.
export async function findPedidoItemByText(
  pedidoTiendaId: number,
  texto: string,
): Promise<{ id: number; nombreProducto: string } | null> {
  const supabase = getSupabaseAdmin();
  const needle = cleanText(texto);
  if (!needle) return null;

  const { data, error } = await supabase
    .from("pedido_items")
    .select("id, nombre_producto")
    .eq("pedido_tienda_id", pedidoTiendaId);
  if (error) throw error;

  const rows = (data ?? []) as Array<{ id: unknown; nombre_producto: unknown }>;
  const normalizedNeedle = needle.toLowerCase();

  const exact = rows.find((r) => String(r.nombre_producto ?? "").trim().toLowerCase() === normalizedNeedle);
  if (exact) return { id: Number(exact.id), nombreProducto: String(exact.nombre_producto) };

  const partial = rows.find((r) => {
    const nombre = String(r.nombre_producto ?? "").trim().toLowerCase();
    return nombre.includes(normalizedNeedle) || normalizedNeedle.includes(nombre);
  });
  if (partial) return { id: Number(partial.id), nombreProducto: String(partial.nombre_producto) };

  return null;
}

export async function setPedidoItemDisponible(itemId: number, disponible: boolean): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedido_items").update({ disponible }).eq("id", itemId);
  if (error) throw error;
}

export async function removePedidoItem(itemId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedido_items").delete().eq("id", itemId);
  if (error) throw error;
}

// Reemplaza el producto (el cliente lo cambió por otro) — vuelve a marcarlo
// disponible=true, ya es un producto distinto que la tienda todavía no evaluó.
// cantidad es opcional a propósito: undefined = no tocar la cantidad ya
// guardada (el extractor de reemplazo no siempre encuentra una nueva).
export async function replacePedidoItemText(itemId: number, nuevoTexto: string, cantidad?: number | null): Promise<void> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, unknown> = { nombre_producto: nuevoTexto, disponible: true };
  if (cantidad !== undefined) update.cantidad = cantidad;
  const { error } = await supabase
    .from("pedido_items")
    .update(update)
    .eq("id", itemId);
  if (error) throw error;
}

export async function setPedidoTotales(params: {
  pedidoId: number;
  servicioRepartidor: number;
  totalCliente: number;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedidos")
    .update({
      servicio_repartidor: params.servicioRepartidor,
      total_cliente: params.totalCliente,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.pedidoId);
  if (error) throw error;
}

export async function setPedidoEstado(params: {
  pedidoId: number;
  estado: OrderState;
  metadataPatch?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const update: Record<string, unknown> = { estado: params.estado, updated_at: new Date().toISOString() };

  if (params.metadataPatch) {
    const { data: current, error: readError } = await supabase
      .from("pedidos")
      .select("metadata_json")
      .eq("id", params.pedidoId)
      .maybeSingle();
    if (readError) throw readError;
    update.metadata_json = { ...toPlainObject(current?.metadata_json as Record<string, unknown> | null), ...params.metadataPatch };
  }

  const { error } = await supabase.from("pedidos").update(update).eq("id", params.pedidoId);
  if (error) throw error;
}

// Retención (CLAUDE.md Sección 4): "solo se conservan pedidos activos. Al
// llegar a entregado o cancelado, el registro se elimina (no se guarda
// historial)". pedido_tiendas/pedido_items/pedido_eventos caen por cascada
// (on delete cascade, ver supabase/migrations/20260804_fase1_esquema_definitivo.sql
// y 20260805_fase2_pedidos_metadata.sql); admin_notificaciones.pedido_id usa
// on delete set null, así que el outbox ya enviado no se pierde.
export async function deletePedido(pedidoId: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedidos").delete().eq("id", pedidoId);
  if (error) throw error;
}

// Llamar SIEMPRE después de encolar cualquier mensaje final que referencie
// este pedidoId (admin_notificaciones.pedido_id no acepta un id que ya no
// exista) — nunca antes. Cierra el ciclo de vida completo de un pedido
// terminal: borra el registro y reinicia la conversación del cliente
// (messages.resetChatHistory), tal como pide la Sección 4 del CLAUDE.md.
export async function finalizePedidoRetention(params: { pedidoId: number; customerPhone: string }): Promise<void> {
  await resetChatHistory(params.customerPhone);
  await deletePedido(params.pedidoId);
}
