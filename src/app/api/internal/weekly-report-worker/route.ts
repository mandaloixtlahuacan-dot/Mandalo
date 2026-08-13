import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createWeeklyReportWorker } from "@/lib/services/weeklyReportWorker";

// Igual que order-timeout-worker: corre por TIEMPO (una vez a la semana), no
// por evento — se dispara vía pg_cron + pg_net desde Supabase, no vía
// Database Webhook. Ver supabase/migrations/20260812_metricas_semanales.sql.

function hasValidCronSecret(request: Request): boolean {
  const env = getEnv();
  const cronSecret = String(env.CRON_SECRET ?? "").trim();
  const authHeader = String(request.headers.get("authorization") ?? "").trim();
  const bearerPrefix = "Bearer ";
  const incomingBearerSecret = authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length).trim() : "";
  return Boolean(cronSecret && incomingBearerSecret === cronSecret);
}

async function handleWeeklyReportWorkerRequest(request: Request) {
  const env = getEnv();

  if (String(env.CRON_SECRET ?? "").trim()) {
    if (!hasValidCronSecret(request)) {
      return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    console.warn("[weeklyReportWorker] CRON_SECRET missing in production");
    return NextResponse.json({ ok: false, error: "WORKER_SECRET_MISSING" }, { status: 503 });
  } else {
    console.warn("[weeklyReportWorker] CRON_SECRET missing; allowing request only because environment is non-production");
  }

  try {
    const worker = createWeeklyReportWorker();
    const result = await worker.run();
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (e: unknown) {
    console.error("[weeklyReportWorker] unexpected route error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: "WEEKLY_REPORT_WORKER_FAILED" }, { status: 200 });
  }
}

export async function POST(request: Request) {
  return handleWeeklyReportWorkerRequest(request);
}
