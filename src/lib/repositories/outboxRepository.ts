import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  EnqueueOutboundMessageInput,
  OutboxStatus,
  ReservedOutboxMessage,
} from "@/lib/services/dispatchWorker";

type UnknownRow = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mapReservedRow(row: UnknownRow): ReservedOutboxMessage {
  return {
    id: Number(row.id),
    pedidoId: row.pedido_id == null ? null : Number(row.pedido_id),
    tipoMensaje: String(row.tipo_mensaje ?? "") as ReservedOutboxMessage["tipoMensaje"],
    destinatarioTipo: String(row.destinatario_tipo ?? "") as ReservedOutboxMessage["destinatarioTipo"],
    destinatarioId: row.destinatario_id == null ? null : Number(row.destinatario_id),
    telefonoDestino: String(row.telefono_destino ?? ""),
    payload: asRecord(row.payload_json),
    attemptCount: Number(row.attempt_count ?? 0),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
  };
}

export async function enqueueOutboundMessage(input: EnqueueOutboundMessageInput): Promise<number> {
  const supabase = getSupabaseAdmin();

  const { data: existing, error: existingError } = await supabase
    .from("pedido_mensajes")
    .select("id")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.id != null) return Number(existing.id);

  const { data, error } = await supabase
    .from("pedido_mensajes")
    .insert({
      pedido_id: input.pedidoId,
      direccion: "saliente",
      tipo_mensaje: input.tipoMensaje,
      destinatario_tipo: input.destinatarioTipo,
      destinatario_id: input.destinatarioId ?? null,
      telefono_destino: input.telefonoDestino,
      payload_json: input.payload,
      estado_envio: "pendiente",
      attempt_count: 0,
      next_attempt_at: new Date().toISOString(),
      idempotency_key: input.idempotencyKey,
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
}): Promise<ReservedOutboxMessage[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedido_mensajes")
    .select("id, pedido_id, tipo_mensaje, destinatario_tipo, destinatario_id, telefono_destino, payload_json, attempt_count, idempotency_key")
    .in("estado_envio", ["pendiente", "reintentando"])
    .lte("next_attempt_at", params.nowIso)
    .order("created_at", { ascending: true })
    .limit(params.limit);

  if (error) throw error;
  const rows = (data ?? []) as UnknownRow[];
  const reserved: ReservedOutboxMessage[] = [];

  for (const row of rows) {
    const id = Number(row.id);
    const { data: claimData, error: claimError } = await supabase
      .from("pedido_mensajes")
      .update({
        estado_envio: "procesando" satisfies OutboxStatus,
        locked_at: params.nowIso,
        locked_by: params.workerId,
      })
      .eq("id", id)
      .in("estado_envio", ["pendiente", "reintentando"])
      .select("id")
      .maybeSingle();

    if (claimError) throw claimError;
    if (claimData?.id != null) {
      reserved.push(mapReservedRow(row));
    }
  }

  return reserved;
}

export async function markMessageSent(params: {
  messageId: number;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  sentAtIso: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedido_mensajes")
    .update({
      estado_envio: "enviado" satisfies OutboxStatus,
      provider_message_id: params.providerMessageId ?? null,
      provider_status: params.providerStatus ?? null,
      provider_response_json: params.providerResponse ?? {},
      sent_at: params.sentAtIso,
      locked_at: null,
      locked_by: null,
      last_error: null,
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
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedido_mensajes")
    .update({
      estado_envio: "reintentando" satisfies OutboxStatus,
      attempt_count: params.attemptCount,
      next_attempt_at: params.nextAttemptAtIso,
      provider_status: params.providerStatus ?? null,
      provider_response_json: params.providerResponse ?? {},
      last_error: params.errorMessage ?? null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", params.messageId);

  if (error) throw error;
}

export async function markMessageDead(params: {
  messageId: number;
  attemptCount: number;
  providerStatus?: string | null;
  providerResponse?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("pedido_mensajes")
    .update({
      estado_envio: "muerto" satisfies OutboxStatus,
      attempt_count: params.attemptCount,
      provider_status: params.providerStatus ?? null,
      provider_response_json: params.providerResponse ?? {},
      last_error: params.errorMessage ?? null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", params.messageId);

  if (error) throw error;
}

