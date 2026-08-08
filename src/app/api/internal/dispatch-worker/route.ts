import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { createDispatchWorker } from "@/lib/services/dispatchWorker";
import { createProviderGateway } from "@/lib/services/providerGateway";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import type { OrderState } from "@/lib/orderStateMachine";

// Único estado en el que tiene sentido intentar despachar un mensaje a
// repartidor: mientras se está buscando/esperando confirmación. Una vez
// repartidor_asignado ya no hay nada que despachar por esta vía.
const DISPATCH_READY_STATES: OrderState[] = ["dispatch_repartidor_pendiente"];

type DispatchWorkerEventPayload = {
  pedidoId?: unknown;
  orderId?: unknown;
  record?: {
    id?: unknown;
    estado?: unknown;
  } | null;
  old_record?: {
    estado?: unknown;
  } | null;
  event?: unknown;
  type?: unknown;
  source?: unknown;
};

type PedidoDispatchState = {
  id: number;
  estado: OrderState;
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

async function parseEventPayload(request: Request): Promise<DispatchWorkerEventPayload> {
  try {
    return asRecord(await request.json()) as DispatchWorkerEventPayload;
  } catch {
    return {};
  }
}

function getEventPedidoId(payload: DispatchWorkerEventPayload): number | null {
  const record = asRecord(payload.record);
  return toNullableNumber(payload.pedidoId) ?? toNullableNumber(payload.orderId) ?? toNullableNumber(record.id);
}

function isDispatchReadyState(value: unknown): value is OrderState {
  return DISPATCH_READY_STATES.includes(String(value ?? "") as OrderState);
}

function isRelevantDispatchEvent(payload: DispatchWorkerEventPayload): boolean {
  const record = asRecord(payload.record);
  const oldRecord = asRecord(payload.old_record);
  const nextState = record.estado;
  const previousState = oldRecord.estado;

  if (!isDispatchReadyState(nextState)) return false;
  return String(previousState ?? "") !== String(nextState ?? "");
}

async function getPedidoDispatchState(pedidoId: number): Promise<PedidoDispatchState | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: Number(data.id),
    estado: String(data.estado ?? "seleccion_productos") as OrderState,
  };
}

async function handleDispatchWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[dispatchWorker] worker/event secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[dispatchWorker] worker/event secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const payload = await parseEventPayload(request);
    const pedidoId = getEventPedidoId(payload);

    if (pedidoId == null) {
      return NextResponse.json({ ok: false, error: "PEDIDO_ID_REQUIRED" }, { status: 400 });
    }

    if (payload.record && !isRelevantDispatchEvent(payload)) {
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

    const pedido = await getPedidoDispatchState(pedidoId);

    if (!pedido) {
      return NextResponse.json({ ok: false, error: "PEDIDO_NOT_FOUND", pedidoId }, { status: 404 });
    }

    if (!isDispatchReadyState(pedido.estado)) {
      return NextResponse.json(
        {
          ok: true,
          skipped: true,
          reason: "PEDIDO_NOT_READY_FOR_DISPATCH",
          pedidoId,
          estado: pedido.estado,
        },
        { status: 200 },
      );
    }

    const worker = createDispatchWorker({
      outboxRepository,
      providerGateway: createProviderGateway(),
      transitionService: createStateTransitionService(),
    });

    const summary = await worker.run({
      limit: 1,
      pedidoId,
      tipoMensaje: "dispatch_repartidor",
      workerId: `api/internal/dispatch-worker:event:${pedidoId}`,
    });

    return NextResponse.json({ ok: true, pedidoId, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[dispatchWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      {
        ok: false,
        error: "DISPATCH_WORKER_FAILED",
      },
      { status: 200 },
    );
  }
}

export async function POST(request: Request) {
  return handleDispatchWorkerRequest(request);
}
