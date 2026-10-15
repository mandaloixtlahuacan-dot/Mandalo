import { NextRequest, NextResponse } from "next/server";
import { classifyInbound } from "@/lib/inboundMessage";
import { parseIncomingWhatsAppMessage, processMandaloWebhook } from "@/lib/mandaloFlow";
import { normalizePhone } from "@/lib/roles";
import { getEnv } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeWhatsAppText, waapiSendText } from "@/lib/waapi";

export const runtime = "nodejs";
// Sin esto, Vercel mata la función a los 10s por defecto — una llamada a
// OpenAI más varias consultas a Supabase secuenciales pueden superar eso
// fácilmente bajo mala red o carga, y Whapi reintenta la entrega del webhook
// al no recibir respuesta a tiempo (causa probable de los reintentos vistos
// en producción agosto 2026, además de la deduplicación de abajo). 60s es el
// máximo permitido en el plan Hobby.
export const maxDuration = 60;

// Whapi reintenta la entrega del webhook si no le llega una respuesta rápido
// (confirmado en producción agosto 2026: un mensaje real se procesó 16 veces
// — el bot llamaba a la IA y escribía en la BD una y otra vez para el MISMO
// mensaje, y las escrituras concurrentes sin ningún bloqueo terminaban
// pisándose entre sí, perdiendo los productos ya capturados). Sin esto, el
// webhook no tenía ninguna protección contra reprocesar un mensaje ya visto
// — a diferencia del lado de salida (outboxRepository), que sí usa
// idempotencyKey desde el principio. Claim atómico vía unique constraint:
// si el insert choca (23505), ya se procesó, se ignora sin tocar nada más.
async function claimInboundMessage(messageId: string, telefono: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // Log temporal de diagnóstico (agosto 2026): un mensaje real se insertó
  // sin chocar 60 veces con el mismo message_id pese a que el primary key
  // sí existe en la tabla — el error nunca se vio en logs porque nunca se
  // registró el resultado crudo del insert. Este log se retira en cuanto se
  // confirme la causa real.
  console.log("[Webhook][dedupe] intentando reclamar mensaje", { messageId, telefono });
  const { data, error, status } = await supabase
    .from("whatsapp_mensajes_procesados")
    .insert({ message_id: messageId, telefono })
    .select();
  console.log("[Webhook][dedupe] resultado del insert", {
    messageId,
    status,
    data,
    error: error ? { code: error.code, message: error.message, details: error.details, hint: error.hint } : null,
  });
  if (!error) return true;
  if (error.code === "23505") return false;
  // Fail-open: un error de BD que no sea el conflicto esperado no debe
  // bloquear el mensaje — mejor procesarlo de más que dejar al cliente sin
  // respuesta por un problema ajeno a él.
  console.error("[Webhook] no se pudo registrar dedupe de mensaje entrante", { messageId, message: error.message });
  return true;
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

    const inbound = classifyInbound(body);
    if (inbound.kind === "ignore" || (inbound.kind === "media" && inbound.media === "unsupported")) {
      const reason = inbound.kind === "ignore" ? inbound.reason : "not_a_message";
      console.log(`[Webhook] Ignorando evento ${reason}.`);
      const ignored = reason === "from_me" ? "FROM_ME" : reason === "system" ? "SYSTEM" : "NOT_A_MESSAGE";
      return NextResponse.json({ ok: true, ignored }, { status: 200 });
    }
    if (inbound.kind === "missing_from") {
      return NextResponse.json({ ok: false, error: "MISSING_FROM" }, { status: 200 });
    }

    const numeroRaw = inbound.from;
    const numero = normalizePhone(String(numeroRaw));
    const textoMensaje = inbound.body;
    const ubicacion = inbound.kind === "location" ? { latitude: inbound.latitude, longitude: inbound.longitude } : null;
    const messageId = inbound.messageId;
    if (messageId) {
      const claimed = await claimInboundMessage(messageId, numero);
      if (!claimed) {
        console.log(`[Webhook] Mensaje ${messageId} ya se había procesado — ignorando reintento de Whapi.`);
        return NextResponse.json({ ok: true, ignored: "DUPLICATE_MESSAGE" }, { status: 200 });
      }
    }

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
    incoming.mediaKind = inbound.kind === "media" ? inbound.media : null;
    incoming.liveLocation = inbound.kind === "live_location";
    incoming.locationAttempt = inbound.kind === "location_unparsed";

    // Tolerante a errores: si IA truena, no colgar webhook.
    let result: unknown;
    try {
      result = await processMandaloWebhook(incoming);
    } catch (err: unknown) {
      console.error("[Webhook Error] processMandaloWebhook:", err);
      const message = err instanceof Error ? err.message : "PROCESS_ERROR";
      result = { ok: false, error: message };

      // Red de seguridad: hasta ahora, cualquier excepción aquí dejaba al
      // cliente en silencio total (sin ningún WhatsApp de vuelta) — bug real
      // confirmado en producción 2026-09-12 (violación de foreign key por un
      // business_id alucinado por la IA). El error de fondo se corrige aparte;
      // esto es el respaldo genérico para que NINGÚN error futuro deje al
      // cliente sin respuesta, sea cual sea la causa.
      try {
        await waapiSendText({
          to: numero,
          body: normalizeWhatsAppText(
            "⚠️ Tuve un problema procesando tu mensaje. Intenta escribirlo de nuevo en un momento — si sigue sin funcionar, ya le avisé a nuestro equipo. 🙏",
          ),
        });
      } catch (notifyErr: unknown) {
        console.error("[Webhook Error] no se pudo mandar el mensaje de respaldo al cliente:", notifyErr);
      }
    }

    return NextResponse.json(result ?? { ok: false, error: "NO_RESULT" }, { status: 200 });
  } catch (err: unknown) {
    console.error("[Webhook Error]:", err);
    const message = err instanceof Error ? err.message : "UNKNOWN_ERROR";
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
