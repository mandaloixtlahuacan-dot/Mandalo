import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { processAdminOutboxBatch } from "@/lib/adminOutboxWorker";

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

async function handleAdminOutboxRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[adminOutboxWorker] worker/cron secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[adminOutboxWorker] worker/cron secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const summary = await processAdminOutboxBatch();
    return NextResponse.json({ ok: true, summary }, { status: 200 });
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

export async function GET(request: Request) {
  return handleAdminOutboxRequest(request);
}

export async function POST(request: Request) {
  return handleAdminOutboxRequest(request);
}
