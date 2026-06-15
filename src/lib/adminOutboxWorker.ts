import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { waapiSendTextRequest } from "@/lib/waapi";

type AdminNotificationRow = {
  id: number;
  pedido_id: number | null;
  tipo: string;
  destinatario_telefono: string;
  contenido: string;
  estado_envio: string;
  intentos: number;
  next_attempt_at: string | null;
  metadata_json: Record<string, unknown> | null;
};

export type AdminOutboxBatchSummary = {
  totalClaimed: number;
  sent: number;
  failed: number;
  dryRun: boolean;
  processedIds: number[];
  errors: Array<{ notificationId: number; pedidoId: number | null; error: string }>;
};

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

function truncateErrorMessage(value: string, max = 500): string {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function computeNextAttemptAt(attempt: number, baseSeconds: number, maxAttempts: number): string {
  const now = Date.now();
  if (attempt >= maxAttempts) {
    return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  }
  const delaySeconds = Math.min(baseSeconds * Math.pow(2, Math.max(attempt - 1, 0)), 3600);
  return new Date(now + delaySeconds * 1000).toISOString();
}

async function markNotificationSent(
  row: AdminNotificationRow,
  dryRun: boolean,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const metadata = {
    ...(row.metadata_json ?? {}),
    ...(dryRun ? { dry_run: true, dry_run_processed_at: new Date().toISOString() } : {}),
  };
  const { error } = await supabase
    .from("admin_notificaciones")
    .update({
      estado_envio: "enviada",
      sent_at: new Date().toISOString(),
      last_error: null,
      metadata_json: metadata,
    })
    .eq("id", row.id);
  if (error) throw error;
}

async function markNotificationFailed(
  row: AdminNotificationRow,
  errorMessage: string,
  baseBackoffSeconds: number,
  maxAttempts: number,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("admin_notificaciones")
    .update({
      estado_envio: "fallida",
      last_error: truncateErrorMessage(errorMessage),
      next_attempt_at: computeNextAttemptAt(row.intentos, baseBackoffSeconds, maxAttempts),
    })
    .eq("id", row.id);
  if (error) throw error;
}

async function claimAdminOutboxBatch(): Promise<AdminNotificationRow[]> {
  const env = getEnv();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_admin_notificaciones_batch", {
    p_limit: env.ADMIN_OUTBOX_BATCH_SIZE,
    p_max_attempts: env.ADMIN_OUTBOX_MAX_ATTEMPTS,
    p_reclaim_stale_after_seconds: 900,
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    pedido_id: row.pedido_id == null ? null : Number(row.pedido_id),
    tipo: String(row.tipo ?? ""),
    destinatario_telefono: String(row.destinatario_telefono ?? ""),
    contenido: String(row.contenido ?? ""),
    estado_envio: String(row.estado_envio ?? ""),
    intentos: Number(row.intentos ?? 0),
    next_attempt_at: row.next_attempt_at == null ? null : String(row.next_attempt_at),
    metadata_json:
      row.metadata_json && typeof row.metadata_json === "object"
        ? (row.metadata_json as Record<string, unknown>)
        : {},
  }));
}

export async function processAdminOutboxBatch(): Promise<AdminOutboxBatchSummary> {
  const env = getEnv();
  const summary: AdminOutboxBatchSummary = {
    totalClaimed: 0,
    sent: 0,
    failed: 0,
    dryRun: env.ADMIN_OUTBOX_DRY_RUN,
    processedIds: [],
    errors: [],
  };

  let claimed: AdminNotificationRow[] = [];
  try {
    claimed = await claimAdminOutboxBatch();
  } catch (e: unknown) {
    const msg = formatUnknownError(e);
    console.error("[adminOutboxWorker] claim failed", { message: msg });
    summary.errors.push({ notificationId: 0, pedidoId: null, error: msg });
    return summary;
  }

  summary.totalClaimed = claimed.length;
  if (!claimed.length) {
    console.log("[adminOutboxWorker] no notifications claimed");
    return summary;
  }

  for (const row of claimed) {
    summary.processedIds.push(row.id);
    try {
      if (env.ADMIN_OUTBOX_DRY_RUN) {
        await markNotificationSent(row, true);
        summary.sent += 1;
        continue;
      }

      const result = await waapiSendTextRequest({
        to: row.destinatario_telefono,
        body: row.contenido,
      });

      if (!result.ok) {
        throw new Error(`Waapi ${result.status}: ${String(result.rawText ?? result.statusText)}`);
      }

      await markNotificationSent(row, false);
      summary.sent += 1;
    } catch (e: unknown) {
      const msg = formatUnknownError(e);
      try {
        await markNotificationFailed(
          row,
          msg,
          env.ADMIN_OUTBOX_BASE_BACKOFF_SECONDS,
          env.ADMIN_OUTBOX_MAX_ATTEMPTS,
        );
      } catch (updateErr: unknown) {
        console.error("[adminOutboxWorker] failed to mark notification as fallida", {
          notificationId: row.id,
          pedidoId: row.pedido_id,
          attempt: row.intentos,
          error: formatUnknownError(updateErr),
        });
      }
      summary.failed += 1;
      summary.errors.push({
        notificationId: row.id,
        pedidoId: row.pedido_id,
        error: truncateErrorMessage(msg, 240),
      });
      console.error("[adminOutboxWorker] notification failed", {
        notificationId: row.id,
        pedidoId: row.pedido_id,
        attempt: row.intentos,
        error: truncateErrorMessage(msg, 240),
      });
    }
  }

  console.log("[adminOutboxWorker] batch summary", {
    claimed: summary.totalClaimed,
    sent: summary.sent,
    failed: summary.failed,
    dryRun: summary.dryRun,
  });
  return summary;
}
