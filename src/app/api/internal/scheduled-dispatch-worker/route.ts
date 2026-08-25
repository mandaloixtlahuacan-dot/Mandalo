import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createScheduledDispatchWorker } from "@/lib/services/scheduledDispatchWorker";

// Igual que order-timeout-worker: corre por TIEMPO, no por evento — nada
// cambia en la base de datos cuando "la tienda por fin abrió" o "pasaron 48h
// sin que abriera". Se dispara vía pg_cron + pg_net desde Supabase (cada 1
// minuto), no vía Database Webhook. Ver
// supabase/migrations/20260824_scheduled_dispatch_worker_cron.sql.

function hasValidCronSecret(request: Request): boolean {
  const env = getEnv();
  const cronSecret = String(env.CRON_SECRET ?? "").trim();
  const authHeader = String(request.headers.get("authorization") ?? "").trim();
  const bearerPrefix = "Bearer ";
  const incomingBearerSecret = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length).trim() : "";
  return Boolean(cronSecret && incomingBearerSecret === cronSecret);
}

async function handleScheduledDispatchWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim()) {
    if (!hasValidCronSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[scheduledDispatchWorker] CRON_SECRET missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn("[scheduledDispatchWorker] CRON_SECRET missing; allowing request only because environment is non-production");
  }

  try {
    const worker = createScheduledDispatchWorker();
    const summary = await worker.run({ limit: 25 });
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[scheduledDispatchWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: "SCHEDULED_DISPATCH_WORKER_FAILED" }, { status: 200 });
  }
}

export async function POST(request: Request) {
  return handleScheduledDispatchWorkerRequest(request);
}
