import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createDispatchWorker } from "@/lib/services/dispatchWorker";
import { createProviderGateway } from "@/lib/services/providerGateway";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import * as outboxRepository from "@/lib/repositories/outboxRepository";

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

async function handleDispatchWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[dispatchWorker] worker/cron secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[dispatchWorker] worker/cron secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const worker = createDispatchWorker({
      outboxRepository,
      providerGateway: createProviderGateway(),
      transitionService: createStateTransitionService(),
    });

    const summary = await worker.run({
      limit: 20,
      workerId: "api/internal/dispatch-worker",
    });

    return NextResponse.json({ ok: true, summary }, { status: 200 });
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

export async function GET(request: Request) {
  return handleDispatchWorkerRequest(request);
}

export async function POST(request: Request) {
  return handleDispatchWorkerRequest(request);
}

