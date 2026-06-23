import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getEnv } from "@/lib/env";
import type { OrderState } from "@/lib/orderStateMachine";

type MensajeRol = "cliente" | "bot" | "tienda" | "repartidor" | "sistema";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const maybe = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [
      maybe.code != null ? `code=${String(maybe.code)}` : null,
      maybe.message != null ? `message=${String(maybe.message)}` : null,
      maybe.details != null ? `details=${String(maybe.details)}` : null,
      maybe.hint != null ? `hint=${String(maybe.hint)}` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(" | ") : JSON.stringify(error);
  }
  return String(error);
}

function toPlainRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type MirrorOrderUpsertFromLegacyParams = {
  legacyPedidoId: number;
  telefonoCliente: string;
  canonicalEstado: OrderState;
  snapshot: Record<string, unknown>;
  total?: number | null;
  addressText?: string | null;
  mapsLink?: string | null;
  negocioId?: number | null;
  repartidorId?: number | null;
  estaEnZonaServicio?: boolean | null;
  zonaDetectada?: string | null;
};

export async function mirrorOrderUpsertFromLegacy(
  params: MirrorOrderUpsertFromLegacyParams,
): Promise<{ pedidoV2Id: number | null; clienteId: number | null }> {
  const supabase = getSupabaseAdmin();

  try {
    const tel = String(params.telefonoCliente ?? "").trim();
    if (!tel) return { pedidoV2Id: null, clienteId: null };
    const snapshotPlain = toPlainRecord(params.snapshot);

    // 1) Upsert cliente por teléfono
    const { data: clienteRow, error: clienteErr } = await supabase
      .from("clientes")
      .upsert(
        {
          telefono: tel,
          ultimo_pedido_at: new Date().toISOString(),
        },
        { onConflict: "telefono" },
      )
      .select("id")
      .maybeSingle();
    if (clienteErr) throw clienteErr;
    const clienteId = clienteRow?.id != null ? Number(clienteRow.id) : null;

    // 2) Upsert pedido v2 por legacy_pedido_id
    const { data: pedidoRow, error: pedidoErr } = await supabase
      .from("pedidos_v2")
      .upsert(
        {
          legacy_pedido_id: params.legacyPedidoId,
          cliente_id: clienteId,
          negocio_id: params.negocioId ?? null,
          repartidor_id: params.repartidorId ?? null,
          estado_flujo: params.canonicalEstado,
          estado_pago: "pendiente",
          total_cliente: params.total ?? null,
          direccion_entrega_texto: params.addressText ?? null,
          google_maps_link: params.mapsLink ?? null,
          esta_en_zona_servicio: params.estaEnZonaServicio ?? null,
          zona_detectada: params.zonaDetectada ?? null,
          snapshot_json: snapshotPlain,
          origen_canal: "whatsapp",
        },
        { onConflict: "legacy_pedido_id" },
      )
      .select("id")
      .maybeSingle();
    if (pedidoErr) throw pedidoErr;

    const pedidoV2Id = pedidoRow?.id != null ? Number(pedidoRow.id) : null;
    return { pedidoV2Id, clienteId };
  } catch (e: unknown) {
    console.error("[dualWrite] mirrorOrderUpsertFromLegacy failed", {
      legacyPedidoId: params.legacyPedidoId,
      canonicalEstado: params.canonicalEstado,
      telefonoCliente: params.telefonoCliente,
      negocioId: params.negocioId ?? null,
      repartidorId: params.repartidorId ?? null,
      total: params.total ?? null,
      snapshotKeys: Object.keys(toPlainRecord(params.snapshot)),
      message: formatUnknownError(e),
    });
    return { pedidoV2Id: null, clienteId: null };
  }
}

export type MirrorOrderEventParams = {
  pedidoV2Id: number;
  tipoEvento: string; // ej. "transition"
  estadoOrigen?: OrderState | null;
  estadoDestino?: OrderState | null;
  actorTipo?: MensajeRol | null;
  actorTelefono?: string | null;
  descripcion?: string | null;
  payload?: Record<string, unknown>;
};

export async function mirrorOrderEvent(params: MirrorOrderEventParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  try {
    await supabase.from("pedido_eventos").insert({
      pedido_id: params.pedidoV2Id,
      tipo_evento: params.tipoEvento,
      estado_origen: params.estadoOrigen ?? null,
      estado_destino: params.estadoDestino ?? null,
      actor_tipo: params.actorTipo ?? null,
      actor_telefono: params.actorTelefono ?? null,
      descripcion: params.descripcion ?? null,
      payload_json: toPlainRecord(params.payload),
    });
  } catch (e: unknown) {
    console.error("[dualWrite] mirrorOrderEvent failed", {
      pedidoV2Id: params.pedidoV2Id,
      message: formatUnknownError(e),
    });
  }
}

export type MirrorChatMessageParams = {
  rolMensaje: MensajeRol;
  contenido: string;
  telefonoOrigen?: string | null;
  telefonoDestino?: string | null;
  canal?: string | null;
  legacyPedidoId?: number | null;
  pedidoV2Id?: number | null;
  telefonoCliente?: string | null;
  metadata?: Record<string, unknown>;
};

async function resolvePedidoV2IdByLegacy(legacyPedidoId: number): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos_v2")
    .select("id")
    .eq("legacy_pedido_id", legacyPedidoId)
    .maybeSingle();
  if (error) throw error;
  return data?.id != null ? Number(data.id) : null;
}

async function resolveClienteIdByPhone(phone: string): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  const tel = String(phone ?? "").trim();
  if (!tel) return null;
  const { data, error } = await supabase
    .from("clientes")
    .upsert({ telefono: tel }, { onConflict: "telefono" })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return data?.id != null ? Number(data.id) : null;
}

export async function mirrorChatMessage(params: MirrorChatMessageParams): Promise<void> {
  const supabase = getSupabaseAdmin();
  try {
    let pedidoV2Id = params.pedidoV2Id ?? null;
    if (!pedidoV2Id && params.legacyPedidoId != null) {
      pedidoV2Id = await resolvePedidoV2IdByLegacy(params.legacyPedidoId);
    }

    const clienteId = params.telefonoCliente ? await resolveClienteIdByPhone(params.telefonoCliente) : null;

    await supabase.from("pedido_mensajes").insert({
      pedido_id: pedidoV2Id,
      cliente_id: clienteId,
      rol_mensaje: params.rolMensaje,
      telefono_origen: params.telefonoOrigen ?? null,
      telefono_destino: params.telefonoDestino ?? null,
      contenido: String(params.contenido ?? ""),
      canal: params.canal ?? "whatsapp",
      metadata_json: toPlainRecord(params.metadata),
    });
  } catch (e: unknown) {
    console.error("[dualWrite] mirrorChatMessage failed", {
      legacyPedidoId: params.legacyPedidoId ?? null,
      pedidoV2Id: params.pedidoV2Id ?? null,
      message: formatUnknownError(e),
    });
  }
}

export type EnqueueAdminNotificationParams = {
  pedidoV2Id: number;
  tipo: "venta_entregada";
  contenido: string;
};

export async function enqueueAdminNotification(params: EnqueueAdminNotificationParams): Promise<void> {
  const env = getEnv();
  const adminPhone = String(env.MANDALO_ADMIN_PHONE ?? "").trim();
  if (!adminPhone) {
    console.warn("[dualWrite] WARNING: MANDALO_ADMIN_PHONE vacío; no se encola admin_notificaciones.");
    return;
  }

  const supabase = getSupabaseAdmin();
  try {
    await supabase.from("admin_notificaciones").insert({
      pedido_id: params.pedidoV2Id,
      tipo: "venta_entregada",
      destinatario_telefono: adminPhone,
      contenido: params.contenido,
      estado_envio: "pendiente",
      intentos: 0,
      next_attempt_at: new Date().toISOString(),
      idempotency_key: `venta_entregada:pedido:${params.pedidoV2Id}`,
      metadata_json: {},
    });
  } catch (e: unknown) {
    // En caso de idempotencia (unique), ignoramos el duplicado para no spamear.
    console.error("[dualWrite] enqueueAdminNotification failed", {
      pedidoV2Id: params.pedidoV2Id,
      message: formatUnknownError(e),
    });
  }
}
