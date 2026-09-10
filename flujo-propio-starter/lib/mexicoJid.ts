/**
 * Normalize a Mexican phone / chat id into a Whapi JID:
 *   521XXXXXXXXXX@s.whatsapp.net
 *
 * Accepts: 10 digits, 52…, 521…, with or without @s.whatsapp.net / @c.us,
 * spaces, dashes, or leading +.
 */
export function toMexicoWhatsappJid(input: string): string {
  const raw = (input || "").trim();
  if (!raw) {
    throw new Error("Empty phone / JID");
  }

  // Already a JID — normalize the user part, keep domain preference
  const at = raw.indexOf("@");
  const userPart = at >= 0 ? raw.slice(0, at) : raw;
  const domain = at >= 0 ? raw.slice(at + 1) : "s.whatsapp.net";

  const digits = userPart.replace(/\D/g, "");
  if (digits.length < 10) {
    throw new Error(`Phone too short: ${raw}`);
  }

  const last10 = digits.slice(-10);
  // MX mobile WhatsApp JIDs use 521 + 10 digits (not bare 52)
  const intl = `521${last10}`;

  // Prefer @s.whatsapp.net; map legacy @c.us to the same
  const normalizedDomain =
    domain === "c.us" || domain === "s.whatsapp.net"
      ? "s.whatsapp.net"
      : domain;

  return `${intl}@${normalizedDomain}`;
}

/** Returns the 10-digit national MX mobile, or null. */
export function mxNational10(input: string): string | null {
  try {
    const jid = toMexicoWhatsappJid(input);
    const digits = jid.split("@")[0].replace(/\D/g, "");
    return digits.slice(-10);
  } catch {
    return null;
  }
}
