import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createCourierTimeoutWorker } from "@/lib/services/courierTimeoutWorker";

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

async function handleCourierTimeoutWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim() || String(env.MANDALO_INTERNAL_WORKER_SECRET ?? "").trim()) {
    if (!hasValidWorkerSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[courierTimeoutWorker] worker/cron secret missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn(
      "[courierTimeoutWorker] worker/cron secret missing; allowing request only because environment is non-production",
    );
  }

  try {
    const worker = createCourierTimeoutWorker();
    const summary = await worker.run({ limit: 20 });
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[courierTimeoutWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: "COURIER_TIMEOUT_WORKER_FAILED" }, { status: 200 });
  }
}

export async function GET(request: Request) {
  return handleCourierTimeoutWorkerRequest(request);
}

export async function POST(request: Request) {
  return handleCourierTimeoutWorkerRequest(request);
}

