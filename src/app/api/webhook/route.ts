import { NextRequest, NextResponse } from "next/server";
import { parseIncomingWhatsAppMessage, processMandaloWebhook } from "@/lib/mandaloFlow";
import { normalizePhone } from "@/lib/roles";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";

function extractWaapiMessageObject(payload: unknown): Record<string, unknown> {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;

  const direct = (body.message ?? data.message) as unknown;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;

  const arr = (body.messages ?? data.messages) as unknown;
  if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") return arr[0] as Record<string, unknown>;

  return {};
}

function isFromMe(payload: unknown): boolean {
  const body = (payload ?? {}) as Record<string, unknown>;
  const message = extractWaapiMessageObject(payload);
  const candidates = [
    body.fromMe,
    body.from_me,
    message.fromMe,
    message.from_me,
    (message as Record<string, unknown>).isFromMe,
  ];
  return candidates.some((v) => v === true);
}

function extractWaapiText(payload: unknown): string | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const message = extractWaapiMessageObject(payload);
  const textObj = (body.text ?? data.text ?? message.text ?? {}) as Record<string, unknown>;

  const candidates = [
    body.text,
    body.body,
    data.body,
    data.text,
    message.body,
    message.text,
    textObj.body,
    textObj.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

function extractWaapiLocation(payload: unknown): { latitude: number; longitude: number } | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const message = extractWaapiMessageObject(payload);

  // Whapi.cloud entrega la ubicación anidada en message.location = { latitude, longitude, preview }.
  // "preview" es una imagen en base64 (no una URL de mapa) — nunca debe tratarse como texto/dirección.
  const candidates = [message.location, body.location, data.location];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const loc = candidate as Record<string, unknown>;
      const latitude = Number(loc.latitude);
      const longitude = Number(loc.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return { latitude, longitude };
      }
    }
  }
  return null;
}

function extractWaapiChatId(payload: unknown): string | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const message = extractWaapiMessageObject(payload);

  const candidates = [
    body.chatId,
    body.chat_id,
    body.from,
    body.sender,
    data.chatId,
    data.chat_id,
    data.from,
    message.chatId,
    message.chat_id,
    message.from,
    message.sender,
    message.author,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const env = getEnv();
    const expectedSecret = String(env.MANDALO_WEBHOOK_SECRET ?? "").trim();
    if (expectedSecret) {
      const requestUrl = new URL(req.url);
      const incomingSecret = String(
        req.headers.get("x-mandalo-webhook-secret") ?? requestUrl.searchParams.get("secret") ?? "",
      ).trim();
      if (incomingSecret !== expectedSecret) {
        console.warn("[Webhook] Secreto inválido; request rechazado.");
        return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 200 });
      }
    }

    const body = await req.json();
    console.log("[Webhook] Payload entrante:", JSON.stringify(body, null, 2));

    // Evita bucles: si el mensaje viene marcado como enviado por "mi" (bot/proveedor), no responder.
    if (isFromMe(body)) {
      console.log("[Webhook] Ignorando mensaje fromMe=true (probable eco del proveedor).");
      return NextResponse.json({ ok: true, ignored: "FROM_ME" }, { status: 200 });
    }

    // Compatibilidad:
    // - legado: body.data.from/body.data.body o body.from/body.body
    // - Waapi: chatId + text/message
    const mensaje = extractWaapiText(body);
    const numeroRaw = extractWaapiChatId(body);
    const ubicacion = extractWaapiLocation(body);

    if (!numeroRaw) {
      return NextResponse.json({ ok: false, error: "MISSING_FROM" }, { status: 200 });
    }

    // No procesar mensajes vacíos (un mensaje de ubicación no trae texto, así que
    // solo lo descartamos si TAMPOCO trae coordenadas de ubicación válidas).
    if ((!mensaje || String(mensaje).trim() === "") && !ubicacion) {
      return NextResponse.json({ ok: false, error: "EMPTY_MESSAGE" }, { status: 200 });
    }

    const numero = normalizePhone(String(numeroRaw));
    const textoMensaje =
      mensaje && String(mensaje).trim() !== "" ? String(mensaje) : "📍 (Cliente compartió su ubicación GPS)";
    console.log(
      `[Webhook] Procesando: ${textoMensaje} de ${numero}${ubicacion ? " [con ubicación GPS]" : ""}`,
    );
    console.log(`[Webhook] Intentando enviar respuesta a: ${numero} (raw: ${String(numeroRaw)})`);

    // Normalización al formato esperado por el flujo
    const normalized = {
      data: {
        from: numero,
        body: textoMensaje,
        ...(ubicacion ? { latitude: ubicacion.latitude, longitude: ubicacion.longitude } : {}),
      },
    };

    const incoming = parseIncomingWhatsAppMessage(normalized);

    // Tolerante a errores: si IA truena, no colgar webhook.
    let result: unknown;
    try {
      result = await processMandaloWebhook(incoming);
    } catch (err: unknown) {
      console.error("[Webhook Error] processMandaloWebhook:", err);
      const message = err instanceof Error ? err.message : "PROCESS_ERROR";
      result = { ok: false, error: message };
    }

    return NextResponse.json(result ?? { ok: false, error: "NO_RESULT" }, { status: 200 });
  } catch (err: unknown) {
    console.error("[Webhook Error]:", err);
    const message = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
