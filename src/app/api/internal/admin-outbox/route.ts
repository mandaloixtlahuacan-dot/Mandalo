import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { processAdminOutboxBatch } from "@/lib/adminOutboxWorker";

type AdminOutboxEventPayload = {
  notificationId?: unknown;
  id?: unknown;
  record?: {
    id?: unknown;
    estado_envio?: unknown;
    next_attempt_at?: unknown;
  } | null;
  old_record?: {
    estado_envio?: unknown;
  } | null;
  event?: unknown;
  type?: unknown;
  source?: unknown;
};

type AdminNotificationState = {
  id: number;
  estadoEnvio: string;
  nextAttemptAt: string | null;
};

function hasValidWorkerSecret(request: Request): boolean {
  const env = getEnv();
  const internalSecret = String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim();
  const cronSecret = String(env.CRON_SECRET ?? "").trim();
  const incomingLegacySecret = String(request.headers.get("x-mandalo-worker-secret") ?? "").trim();
  const authHeader = String(request.headers.get("authorization") ?? "").trim();
  const bearerPrefix = "Bearer ";
  const incomingBearerSecret = authHeader.startsWith(bearerPrefix)
    ? authHeader.slice(bearerPrefix.length).trim()
    : "";

  return Boolean(
    (cronSecret && incomingBearerSecret === cronSecret) ||
      (internalSecret && incomingLegacySecret === internalSecret),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

async function parseEventPayload(request: Request): Promise<AdminOutboxEventPayload> {
  try {
    return asRecord(await request.json()) as AdminOutboxEventPayload;
  } catch {
    return {};
  }
}

function getEventNotificationId(payload: AdminOutboxEventPayload): number | null {
  const record = asRecord(payload.record);
  return toNullableNumber(payload.notificationId) ?? toNullableNumber(payload.id) ?? toNullableNumber(record.id);
}

function isRelevantOutboxEvent(payload: AdminOutboxEventPayload): boolean {
  const record = asRecord(payload.record);
  if (!payload.record) return true;
  return ["pendiente", "fallida"].includes(String(record.estado_envio ?? ""));
}

function isNextAttemptDue(nextAttemptAt: string | null, nowMs: number): boolean {
  if (!nextAttemptAt) return true;
  const nextAttemptMs = Date.parse(nextAttemptAt);
  return Number.isFinite(nextAttemptMs) && nextAttemptMs <= nowMs;
}

async function getAdminNotificationState(notificationId: number): Promise<AdminNotificationState | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_notificaciones")
    .select("id, estado_envio, next_attempt_at")
    .eq("id", notificationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: Number(data.id),
    estadoEnvio: String(data.estado_envio ?? ""),
    nextAttemptAt: cleanText(data.next_attempt_at),
  };
}

async function handleAdminOutboxRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[adminOutboxWorker] worker/event secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[adminOutboxWorker] worker/event secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const payload = await parseEventPayload(request);
    const notificationId = getEventNotificationId(payload);

    if (notificationId == null) {
      return NextResponse.json({ ok: false, error: "NOTIFICATION_ID_REQUIRED" }, { status: 400 });
    }

    if (!isRelevantOutboxEvent(payload)) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "IRRELEVANT_OUTBOX_STATE",
          notificationId,
        },
        { status: 200 },
      );
    }

    const notification = await getAdminNotificationState(notificationId);

    if (!notification) {
      return NextResponse.json({ ok: false, error: "NOTIFICATION_NOT_FOUND", notificationId }, { status: 404 });
    }

    if (!["pendiente", "fallida"].includes(notification.estadoEnvio)) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "NOTIFICATION_NOT_READY_FOR_SEND",
          notificationId,
          estadoEnvio: notification.estadoEnvio,
        },
        { status: 200 },
      );
    }

    if (!isNextAttemptDue(notification.nextAttemptAt, Date.now())) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "NOTIFICATION_NEXT_ATTEMPT_NOT_DUE",
          notificationId,
          nextAttemptAt: notification.nextAttemptAt,
        },
        { status: 200 },
      );
    }

    const summary = await processAdminOutboxBatch({ notificationId });
    return NextResponse.json({ ok: true, notificationId, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[adminOutboxWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      {
        ok: false,
        error: "ADMIN_OUTBOX_WORKER_FAILED",
      },
      { status: 200 },
    );
  }
}

export async function POST(request: Request) {
  return handleAdminOutboxRequest(request);
}
