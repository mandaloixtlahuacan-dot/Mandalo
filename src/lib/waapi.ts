import { getEnv } from "@/lib/env";
import { outboundDecision, recordOutbound, releaseOutbound, type OutboundVerdict } from "@/lib/outboundGuard";

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

function suppressedSend(to: string, body: string, reason: Exclude<OutboundVerdict, "send">): WaapiSendTextResponse {
  console.warn("[outbound-guard] envío suprimido", {
    reason: reason === "duplicate" ? "identico_60s" : "tope_por_minuto",
    to: String(to ?? "").replace(/[^\d]/g, ""),
    bodyPreview: String(body ?? "").slice(0, 160),
  });
  return {
    ok: true,
    status: 200,
    statusText: "suppressed",
    data: { suppressed: true, reason },
  };
}

function reserveOutbound(to: string, body: string): WaapiSendTextResponse | null {
  const verdict = outboundDecision(to, body);
  if (verdict !== "send") return suppressedSend(to, body, verdict);
  recordOutbound(to, body);
  return null;
}

export async function waapiSendTextRequest({ to, body }: WaapiSendTextArgs): Promise<WaapiSendTextResponse> {
  const suppressed = reserveOutbound(to, body);
  if (suppressed) return suppressed;

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    releaseOutbound(to, body);
    throw error;
  }
  const url = `${String(env.WAAPI_API_BASE).replace(/\/+$/, "")}/messages/text`;
  const waapiTo = toWaapiChatId(to);

  console.log("[mandalo] waapi -> sendText to:", waapiTo);
  console.log("[DEBUG] Waapi request:", {
    url,
    to: waapiTo,
    bodyLength: String(body ?? "").length,
    bodyPreview: String(body ?? "").slice(0, 500),
  });

  let res: Response;
  try {
    res = await fetch(url, {
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
  } catch (error) {
    releaseOutbound(to, body);
    throw error;
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  console.log("[DEBUG] Respuesta Waapi:", {
    to: waapiTo,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: parsed,
    rawTextPreview: parsed ? undefined : text.slice(0, 2000),
  });

  if (!res.ok) releaseOutbound(to, body);

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    data: parsed ?? { ok: true, raw: text },
    rawText: text,
  };
}

export type WaapiSendImageArgs = {
  to: string;
  caption: string;
  png: Buffer;
  filename?: string;
};

export async function waapiSendImage({ to, caption, png, filename }: WaapiSendImageArgs): Promise<WaapiSendTextResponse> {
  const suppressed = reserveOutbound(to, caption);
  if (suppressed) return suppressed;

  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    releaseOutbound(to, caption);
    throw error;
  }
  const url = `${String(env.WAAPI_API_BASE).replace(/\/+$/, "")}/messages/image`;
  const waapiTo = toWaapiChatId(to);
  const form = new FormData();
  form.append("to", waapiTo);
  form.append("caption", caption);
  form.append("media", new Blob([new Uint8Array(png)], { type: "image/png" }), filename || "menu.png");

  console.log("[mandalo] waapi -> sendImage to:", waapiTo, "bytes:", png.length);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WAAPI_TOKEN}`,
      },
      body: form,
    });
  } catch (error) {
    releaseOutbound(to, caption);
    throw error;
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  console.log("[DEBUG] Respuesta Waapi imagen:", {
    to: waapiTo,
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: parsed,
    rawTextPreview: parsed ? undefined : text.slice(0, 2000),
  });

  if (!res.ok) {
    releaseOutbound(to, caption);
    throw new Error(`Waapi image error ${res.status}: ${text.slice(0, 500)}`);
  }

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
      rawResponsePreview: String(result.rawText ?? "").slice(0, 2000),
    });
    throw new Error(`Waapi error ${result.status}: ${String(result.rawText ?? "")}`);
  }
  return result.data;
}

export function normalizeWhatsAppText(text: string) {
  // Conserva saltos de línea reales (listas de filtros, tiendas y menú).
  // Solo aplana espacios horizontales y recorta líneas en blanco de más.
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
