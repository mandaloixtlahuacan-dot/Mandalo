import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getEnv } from "@/lib/env";
import { getAdminPhone } from "@/lib/repositories/configRepository";
import type {
  EnqueueOutboundMessageInput,
  OutboxMessageType,
  ReservedOutboxMessage,
} from "@/lib/services/dispatchWorker";

// Antes apuntaba a `pedido_mensajes` con columnas que nunca existieron ahí
// (bug confirmado en el diagnóstico original). Ahora opera sobre
// admin_notificaciones, ampliada en la Fase 2 a outbox general (ver CLAUDE.md
// Sección 4, nota de implementación). Dos "carriles" lógicos sobre la misma
// tabla física:
// - dispatchWorker.ts (este archivo): mensajes de pedido — cotización a
//   tienda, despacho a repartidor, notificaciones al cliente. Siempre debe
//   invocarse acotado por pedidoId/tipoMensaje (nunca en polling ciego), para
//   no competir por las alertas de administrador.
// - adminOutboxWorker.ts: alertas al administrador — reclama por su cuenta
//   con el mismo RPC, sin pasar por este archivo.

type UnknownRow = Record<string, unknown>;

function toPlainObject(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapDestinatarioTipo(value: unknown): ReservedOutboxMessage["destinatarioTipo"] {
  const v = String(value ?? "").trim();
  if (v === "negocio" || v === "repartidor" || v === "admin" || v === "cliente") return v;
  return "admin";
}

function mapRow(row: UnknownRow): ReservedOutboxMessage {
  const metadata = toPlainObject(row.metadata_json as Record<string, unknown> | null);
  return {
    id: Number(row.id),
    pedidoId: row.pedido_id == null ? null : Number(row.pedido_id),
    tipoMensaje: String(row.tipo ?? "") as OutboxMessageType,
    destinatarioTipo: mapDestinatarioTipo(row.destinatario_tipo),
    destinatarioId: row.destinatario_id == null ? null : Number(row.destinatario_id),
    telefonoDestino: String(row.destinatario_telefono ?? ""),
    payload: { body: String(row.contenido ?? ""), ...metadata },
    attemptCount: Number(row.intentos ?? 0),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
  };
}

export async function enqueueOutboundMessage(input: EnqueueOutboundMessageInput): Promise<number> {
  const supabase = getSupabaseAdmin();
  const body = String(input.payload.body ?? "").trim();
  if (!body) throw new Error("enqueueOutboundMessage: payload.body es obligatorio.");

  const { data: existing, error: existingError } = await supabase
    .from("admin_notificaciones")
    .select("id")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id != null) return Number(existing.id);

  const { data, error } = await supabase
    .from("admin_notificaciones")
    .insert({
      pedido_id: input.pedidoId,
      tipo: input.tipoMensaje,
      destinatario_tipo: input.destinatarioTipo,
      destinatario_id: input.destinatarioId ?? null,
      destinatario_telefono: input.telefonoDestino,
      contenido: body,
      estado_envio: "pendiente",
      intentos: 0,
      next_attempt_at: new Date().toISOString(),
      idempotency_key: input.idempotencyKey,
      metadata_json: toPlainObject(input.payload),
    })
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("No se pudo encolar el mensaje saliente.");
  return Number(data.id);
}

export async function reservePendingMessages(params: {
  limit: number;
  workerId: string;
  nowIso: string;
  pedidoId?: number;
  tipoMensaje?: OutboxMessageType;
}): Promise<ReservedOutboxMessage[]> {
  const supabase = getSupabaseAdmin();
  const env = getEnv();
  const { data, error } = await supabase.rpc("claim_admin_notificaciones_batch", {
    p_limit: params.limit,
    p_max_attempts: env.ADMIN_OUTBOX_MAX_ATTEMPTS,
    p_reclaim_stale_after_seconds: 900,
    p_pedido_id: params.pedidoId ?? null,
    p_tipo: params.tipoMensaje ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as UnknownRow[]).map(mapRow);
}

async function readMetadata(messageId: number): Promise<Record<string, unknown>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_notificaciones")
    .select("metadata_json")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  return toPlainObject(data?.metadata_json as Record<string, unknown> | null);
}

export async function markMessageSent(params: {
  messageId: number;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  sentAtIso: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const metadata = await readMetadata(params.messageId);
  metadata.provider_message_id = params.providerMessageId ?? null;
  metadata.provider_status = params.providerStatus ?? null;
  if (params.providerResponse) metadata.provider_response = params.providerResponse;

  const { error } = await supabase
    .from("admin_notificaciones")
    .update({
      estado_envio: "enviada",
      sent_at: params.sentAtIso,
      metadata_json: metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.messageId);

  if (error) throw error;
}

async function markMessageFailure(params: {
  messageId: number;
  attemptCount: number;
  nextAttemptAtIso: string;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const metadata = await readMetadata(params.messageId);
  metadata.provider_status = params.providerStatus ?? null;
  if (params.providerResponse) metadata.provider_response = params.providerResponse;

  const { error } = await supabase
    .from("admin_notificaciones")
    .update({
      estado_envio: "fallida",
      intentos: params.attemptCount,
      next_attempt_at: params.nextAttemptAtIso,
      last_error: params.errorMessage ?? null,
      metadata_json: metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.messageId);

  if (error) throw error;
}

export async function markMessageRetry(params: {
  messageId: number;
  attemptCount: number;
  nextAttemptAtIso: string;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<void> {
  await markMessageFailure(params);
}

export async function markMessageDead(params: {
  messageId: number;
  attemptCount: number;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<void> {
  // "Muerto" = fallida con intentos >= máximo. El RPC de claim ya deja de
  // recoger la fila una vez que intentos alcanza el máximo configurado, así
  // que no hace falta un estado_envio distinto para representarlo.
  await markMessageFailure({ ...params, nextAttemptAtIso: new Date().toISOString() });
}

// Usado por stateTransitionService.ts para alertas operativas al administrador
// (venta entregada, timeout de repartidor, fallo de dispatch, etc.). Es el
// carril de adminOutboxWorker.ts, no el de dispatchWorker.ts.
export async function enqueueAdminNotification(params: {
  pedidoId: number | null;
  tipo: string;
  contenido: string;
}): Promise<void> {
  const adminPhone = await getAdminPhone();
  if (!adminPhone) {
    console.warn("[outboxRepository] no hay teléfono de admin configurado (ni BD ni MANDALO_ADMIN_PHONE); no se encola notificación.");
    return;
  }

  const supabase = getSupabaseAdmin();
  const idempotencyKey = `admin:${params.tipo}:pedido:${params.pedidoId}:${Date.now()}`;
  const { error } = await supabase.from("admin_notificaciones").insert({
    pedido_id: params.pedidoId,
    tipo: params.tipo,
    destinatario_tipo: "admin",
    destinatario_telefono: adminPhone,
    contenido: params.contenido,
    estado_envio: "pendiente",
    intentos: 0,
    next_attempt_at: new Date().toISOString(),
    idempotency_key: idempotencyKey,
    metadata_json: {},
  });

  if (error) {
    console.error("[outboxRepository] enqueueAdminNotification failed", {
      pedidoId: params.pedidoId,
      tipo: params.tipo,
      message: error.message,
    });
  }
}
