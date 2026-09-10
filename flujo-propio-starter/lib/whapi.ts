import { toMexicoWhatsappJid } from "./mexicoJid";

function baseUrl(): string {
  return (process.env.WHAPI_BASE_URL || "https://gate.whapi.cloud").replace(
    /\/$/,
    "",
  );
}

function token(): string {
  const t = process.env.WHAPI_TOKEN || "";
  if (!t) throw new Error("WHAPI_TOKEN is not set");
  return t;
}

/**
 * Send a plain-text WhatsApp message via Whapi.cloud.
 * `toJid` may be a bare phone or a full JID; MX numbers are normalized to 521…@s.whatsapp.net.
 */
export async function sendText(toJid: string, body: string): Promise<void> {
  const to = toMexicoWhatsappJid(toJid);
  const url = `${baseUrl()}/messages/text`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, body }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Whapi sendText failed status=${res.status} body_len=${text.length}`,
    );
  }
}
