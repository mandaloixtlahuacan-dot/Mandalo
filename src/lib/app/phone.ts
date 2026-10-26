import { ensureMxWhatsappIntl, normalizePhone } from "@/lib/roles";

/**
 * Teléfono guardado de la app: 52 + 10 dígitos, o 521 + 10 si así llegó.
 * El envío a WhatsApp no usa este valor tal cual: `whatsappTo` lo pasa a 521.
 */
export function parseAppPhone(raw: string): string | null {
  const digits = normalizePhone(raw);
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return digits;
  if (digits.length === 13 && digits.startsWith("521")) return digits;
  return null;
}

export function phoneVariants(raw: string): string[] {
  const sid = normalizePhone(raw);
  const last10 = sid.length > 10 ? sid.slice(-10) : sid;
  return Array.from(new Set([sid, last10, `52${last10}`, `521${last10}`].filter((item) => item.length > 0)));
}

export function samePhone(left: string, right: string): boolean {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const a10 = a.length > 10 ? a.slice(-10) : a;
  const b10 = b.length > 10 ? b.slice(-10) : b;
  return a10.length === 10 && a10 === b10;
}

export function whatsappTo(raw: string): string {
  return ensureMxWhatsappIntl(raw);
}
