import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import type {
  EstadoFlujoPedido,
  PedidoItemInput,
  PedidoSnapshot,
  PedidoV2Record,
} from "@/lib/services/captureEngine";

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

function mapPedidoV2Row(row: UnknownRow): PedidoV2Record {
  return {
    id: Number(row.id),
    estado_flujo: String(row.estado_flujo ?? "capturando_pedido") as EstadoFlujoPedido,
    snapshot_json:
      row.snapshot_json && typeof row.snapshot_json === "object" && !Array.isArray(row.snapshot_json)
        ? (row.snapshot_json as PedidoSnapshot)
        : {},
  };
}

async function resolveClienteIdByPhone(phone: string, customerName?: string | null): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  const telefono = normalizePhone(phone);
  if (!telefono) return null;

  const payload: Record<string, unknown> = {
    telefono,
    ultimo_pedido_at: new Date().toISOString(),
  };
  const nombre = cleanText(customerName);
  if (nombre) payload.nombre = nombre;

  const { data, error } = await supabase
    .from("clientes")
    .upsert(payload, { onConflict: "telefono" })
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data?.id != null ? Number(data.id) : null;
}

export async function getOpenPedidoByCustomerPhone(phone: string): Promise<PedidoV2Record | null> {
  const supabase = getSupabaseAdmin();
  const phoneVariants = getPhoneVariants(phone);

  const { data, error } = await supabase
    .from("pedidos_v2")
    .select("id, estado_flujo, snapshot_json, clientes!inner(telefono)")
    .in("estado_flujo", [
      "capturando_pedido",
      "requiere_especificacion_producto",
      "requiere_direccion_completa",
      "requiere_negocio",
      "listo_para_confirmacion_cliente",
    ])
    .in("clientes.telefono", phoneVariants)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapPedidoV2Row(data as UnknownRow);
}

export async function getOrCreateDraftPedido(params: {
  customerPhone: string;
  customerName?: string | null;
}): Promise<PedidoV2Record> {
  const existing = await getOpenPedidoByCustomerPhone(params.customerPhone);
  if (existing) return existing;

  const supabase = getSupabaseAdmin();
  const clienteId = await resolveClienteIdByPhone(params.customerPhone, params.customerName ?? null);

  const { data, error } = await supabase
    .from("pedidos_v2")
    .insert({
      cliente_id: clienteId,
      estado_flujo: "capturando_pedido",
      estado_pago: "pendiente",
      snapshot_json: {},
      origen_canal: "whatsapp",
    })
    .select("id, estado_flujo, snapshot_json")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("No se pudo crear el pedido draft en pedidos_v2.");
  return mapPedidoV2Row(data as UnknownRow);
}

export async function updatePedidoSnapshot(params: {
  pedidoId: number;
  estadoFlujo: EstadoFlujoPedido;
  snapshot: PedidoSnapshot;
  direccionEntregaTexto?: string | null;
  negocioId?: number | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedidos_v2")
    .update({
      estado_flujo: params.estadoFlujo,
      snapshot_json: toPlainObject(params.snapshot as Record<string, unknown>),
      direccion_entrega_texto: cleanText(params.direccionEntregaTexto) ?? null,
      negocio_id: params.negocioId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.pedidoId);

  if (error) throw error;
}

export async function replacePedidoItems(params: {
  pedidoId: number;
  items: PedidoItemInput[];
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error: deleteErr } = await supabase.from("pedido_items").delete().eq("pedido_id", params.pedidoId);
  if (deleteErr) throw deleteErr;

  if (!params.items.length) return;

  const rows = params.items.map((item) => ({
    pedido_id: params.pedidoId,
    nombre_producto: item.nombre_producto,
    marca: item.marca ?? null,
    presentacion: item.presentacion ?? null,
    cantidad: item.cantidad ?? null,
    unidad: item.unidad ?? null,
    notas: item.notas ?? null,
  }));

  const { error: insertErr } = await supabase.from("pedido_items").insert(rows);
  if (insertErr) throw insertErr;
}

export async function appendPedidoEvento(params: {
  pedidoId: number;
  tipoEvento: string;
  estadoOrigen?: EstadoFlujoPedido | null;
  estadoDestino?: EstadoFlujoPedido | null;
  actorTipo: "cliente" | "sistema" | "negocio" | "repartidor" | "admin";
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

