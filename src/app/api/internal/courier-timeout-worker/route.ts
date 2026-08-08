import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { createCourierTimeoutWorker } from "@/lib/services/courierTimeoutWorker";

const COURIER_TIMEOUT_READY_STATE = "dispatch_repartidor_pendiente";

type CourierTimeoutEventPayload = {
  pedidoId?: unknown;
  orderId?: unknown;
  record?: {
    id?: unknown;
    estado?: unknown;
    metadata_json?: { courier_confirmation_deadline_at?: unknown } | null;
  } | null;
  old_record?: {
    estado?: unknown;
  } | null;
  event?: unknown;
  type?: unknown;
  source?: unknown;
};

type PedidoTimeoutState = {
  id: number;
  estado: string;
  deadlineAt: string | null;
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

async function parseEventPayload(request: Request): Promise<CourierTimeoutEventPayload> {
  try {
    return asRecord(await request.json()) as CourierTimeoutEventPayload;
  } catch {
    return {};
  }
}

function getEventPedidoId(payload: CourierTimeoutEventPayload): number | null {
  const record = asRecord(payload.record);
  return toNullableNumber(payload.pedidoId) ?? toNullableNumber(payload.orderId) ?? toNullableNumber(record.id);
}

function isRelevantTimeoutEvent(payload: CourierTimeoutEventPayload): boolean {
  const record = asRecord(payload.record);
  if (!payload.record) return true;
  return String(record.estado ?? "") === COURIER_TIMEOUT_READY_STATE;
}

function isDeadlineDue(deadlineAt: string | null, nowMs: number): boolean {
  if (!deadlineAt) return false;
  const deadlineMs = Date.parse(deadlineAt);
  return Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
}

async function getPedidoTimeoutState(pedidoId: number): Promise<PedidoTimeoutState | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado, metadata_json")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const metadata = asRecord(data.metadata_json);
  return {
    id: Number(data.id),
    estado: String(data.estado ?? ""),
    deadlineAt: cleanText(metadata.courier_confirmation_deadline_at),
  };
}

async function handleCourierTimeoutWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[courierTimeoutWorker] worker/event secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[courierTimeoutWorker] worker/event secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const payload = await parseEventPayload(request);
    const pedidoId = getEventPedidoId(payload);

    if (pedidoId == null) {
      return NextResponse.json({ ok: false, error: "PEDIDO_ID_REQUIRED" }, { status: 400 });
    }

    if (!isRelevantTimeoutEvent(payload)) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "IRRELEVANT_STATE_TRANSITION",
          pedidoId,
        },
        { status: 200 },
      );
    }

    const pedido = await getPedidoTimeoutState(pedidoId);

    if (!pedido) {
      return NextResponse.json({ ok: false, error: "PEDIDO_NOT_FOUND", pedidoId }, { status: 404 });
    }

    if (pedido.estado !== COURIER_TIMEOUT_READY_STATE) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "PEDIDO_NOT_WAITING_FOR_COURIER_CONFIRMATION",
          pedidoId,
          estado: pedido.estado,
        },
        { status: 200 },
      );
    }

    if (!isDeadlineDue(pedido.deadlineAt, Date.now())) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "COURIER_CONFIRMATION_DEADLINE_NOT_DUE",
          pedidoId,
          courierConfirmationDeadlineAt: pedido.deadlineAt,
        },
        { status: 200 },
      );
    }

    const worker = createCourierTimeoutWorker();
    const summary = await worker.run({ limit: 1, pedidoId });
    return NextResponse.json({ ok: true, pedidoId, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[courierTimeoutWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: "COURIER_TIMEOUT_WORKER_FAILED" }, { status: 200 });
  }
}

export async function POST(request: Request) {
  return handleCourierTimeoutWorkerRequest(request);
}
