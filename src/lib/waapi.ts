import { getEnv } from "@/lib/env";

export type WaapiSendTextArgs = {
  to: string;
  body: string;
};

export type WaapiSendTextResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  rawText?: string;
};

function toWaapiChatId(to: string): string {
  const raw = String(to ?? "").trim();
  if (raw.endsWith("@c.us") || raw.endsWith("@g.us")) return raw;
  return `${raw}@c.us`;
}

export async function waapiSendTextRequest({ to, body }: WaapiSendTextArgs): Promise<WaapiSendTextResponse> {
  const env = getEnv();
  const url = `${String(env.WAAPI_API_BASE).replace(/\/+$/, "")}/messages/text`;
  const waapiTo = toWaapiChatId(to);

  console.log("[mandalo] waapi -> sendText to:", waapiTo);
  console.log("[DEBUG] Waapi request:", {
    url,
    to: waapiTo,
    bodyLength: String(body ?? "").length,
    bodyPreview: String(body ?? "").slice(0, 500),
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.WAAPI_TOKEN}`,
    },
    body: JSON.stringify({
      to: waapiTo,
      body,
    }),
  });

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  console.log("[DEBUG] Respuesta Waapi:", {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: parsed,
    rawTextPreview: parsed ? undefined : text.slice(0, 2000),
  });

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    data: parsed ?? { ok: true, raw: text },
    rawText: text,
  };
}

export async function waapiSendText({ to, body }: WaapiSendTextArgs) {
  const result = await waapiSendTextRequest({ to, body });
  if (!result.ok) {
    console.error("[mandalo] waapi error:", {
      status: result.status,
      statusText: result.statusText,
      to,
      responseText: String(result.rawText ?? "").slice(0, 2000),
    });
    throw new Error(`Waapi error ${result.status}: ${String(result.rawText ?? "")}`);
  }
  return result.data;
}

export function normalizeWhatsAppText(text: string) {
  // Normalizamos saltos/espacios antes de enviar al proveedor de WhatsApp.
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

