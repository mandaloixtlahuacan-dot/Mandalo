import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "flujo-propio-starter",
    whapi_token: process.env.WHAPI_TOKEN ? "set" : "missing",
    openai_api_key: process.env.OPENAI_API_KEY ? "set" : "missing",
    webhook_secret: process.env.WEBHOOK_SECRET ? "set" : "missing",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  });
}
