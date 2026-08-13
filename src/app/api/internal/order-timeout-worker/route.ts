import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createOrderTimeoutWorker } from "@/lib/services/orderTimeoutWorker";

// A diferencia de dispatch-worker/admin-outbox (reactivos a un INSERT/UPDATE
// puntual), este worker debe correr por TIEMPO, no por evento — nada cambia
// en la base de datos cuando "pasan 10 minutos sin respuesta". Se dispara vía
// pg_cron + pg_net desde Supabase (cada 1 minuto), no vía Database Webhook.
// Ver migración de infraestructura para el cron job.

function hasValidCronSecret(request: Request): boolean {
  const env = getEnv();
  const cronSecret = String(env.CRON_SECRET ?? "").trim();
  const authHeader = String(request.headers.get("authorization") ?? "").trim();
  const bearerPrefix = "Bearer ";
  const incomingBearerSecret = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length).trim() : "";
  return Boolean(cronSecret && incomingBearerSecret === cronSecret);
}

async function handleOrderTimeoutWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim()) {
    if (!hasValidCronSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[orderTimeoutWorker] CRON_SECRET missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn("[orderTimeoutWorker] CRON_SECRET missing; allowing request only because environment is non-production");
  }

  try {
    const worker = createOrderTimeoutWorker();
    const summary = await worker.run({ limit: 25 });
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch (e: unknown) {
    console.error("[orderTimeoutWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: "ORDER_TIMEOUT_WORKER_FAILED" }, { status: 200 });
  }
}

export async function POST(request: Request) {
  return handleOrderTimeoutWorkerRequest(request);
}
