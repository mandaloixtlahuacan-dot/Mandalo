import type { SupabaseClient } from "@supabase/supabase-js";

import { samePhone } from "@/lib/app/phone";
import { trackingHeadline, trackingSteps, type TrackingStep } from "@/lib/app/tracking";
import type { OrderState } from "@/lib/orderStateMachine";
import { ORDER_STATES } from "@/lib/orderStateMachine";
import { formatMoney } from "@/lib/ordenes";

export type AppOrderView = {
  id: number;
  estado: OrderState;
  titulo: string;
  tienda: string;
  direccion: string | null;
  total: number | null;
  totalTexto: string | null;
  cotizar: boolean;
  pasos: TrackingStep[];
  items: Array<{ id: number; nombre: string; cantidad: number | null; extras: string[]; nota: string }>;
  puedeConfirmarTotal: boolean;
};

export async function readAppOrder(supabase: SupabaseClient, pedidoId: number, telefono: string): Promise<AppOrderView | null> {
  const result = await supabase
    .from("pedidos")
    .select(
      "id, estado, cliente_telefono, direccion_entrega, total_cliente, metadata_json, pedido_tiendas(id, estado_tienda, tiendas(nombre, usa_catalogo_fijo), pedido_items(id, nombre_producto, cantidad, disponible))",
    )
    .eq("id", pedidoId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  const row = result.data as Record<string, unknown>;
  if (!samePhone(String(row.cliente_telefono ?? ""), telefono)) return null;
  const estado = asState(row.estado);
  const metadata = asRecord(row.metadata_json);
  const appItems = Array.isArray(metadata.app_items) ? metadata.app_items : [];
  const link = first(row.pedido_tiendas);
  const tienda = asRecord(first(link?.tiendas) ?? link?.tiendas);
  const cotizar = tienda.usa_catalogo_fijo !== true;
  const items = (Array.isArray(link?.pedido_items) ? link.pedido_items : []).map((item) => {
    const record = asRecord(item);
    const saved = appItems.map(asRecord).find((entry) => String(entry.nombre ?? "") === String(record.nombre_producto ?? ""));
    return {
      id: Number(record.id),
      nombre: String(record.nombre_producto ?? ""),
      cantidad: record.cantidad == null ? null : Number(record.cantidad),
      extras: Array.isArray(saved?.extras) ? saved.extras.map((extra) => String(extra)) : [],
      nota: String(saved?.nota ?? ""),
    };
  });
  const total = row.total_cliente == null ? null : Number(row.total_cliente);
  const tiendaNombre = String(tienda.nombre ?? "la tienda");
  return {
    id: Number(row.id),
    estado,
    titulo: trackingHeadline(estado, tiendaNombre),
    tienda: tiendaNombre,
    direccion: row.direccion_entrega == null ? null : String(row.direccion_entrega),
    total,
    totalTexto: total == null ? (cotizar ? "Por cotizar" : null) : formatMoney(total),
    cotizar,
    pasos: trackingSteps(estado),
    items,
    puedeConfirmarTotal: estado === "confirmado_tiendas" && cotizar,
  };
}

export async function readOpenAppOrderId(supabase: SupabaseClient, telefono: string): Promise<number | null> {
  const { phoneVariants } = await import("@/lib/app/phone");
  const result = await supabase
    .from("pedidos")
    .select("id")
    .in("cliente_telefono", phoneVariants(telefono))
    .not("estado", "in", "(entregado,cancelado)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data?.id == null ? null : Number(result.data.id);
}

function asState(value: unknown): OrderState {
  const text = String(value ?? "");
  return (ORDER_STATES as readonly string[]).includes(text) ? (text as OrderState) : "seleccion_productos";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function first(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}
