/**
 * Tope de salida por número, en la memoria de este proceso.
 * Cubre todos los envíos de WhatsApp (texto e imagen).
 * El mismo texto al mismo número no se repite en 60 segundos.
 * A lo más 6 textos distintos por número en ese mismo minuto.
 * Un menú y después un ejemplo son distintos: los dos pueden salir.
 * Si el envío a Whapi falla, se suelta el cupo para que un reintento sí salga.
 */

export const OUTBOUND_WINDOW_MS = 60_000;
export const OUTBOUND_MAX_PER_MINUTE = 6;

export type OutboundVerdict = "send" | "duplicate" | "rate";

type Stamp = { body: string; at: number };

const sentByPhone = new Map<string, Stamp[]>();

function phoneKey(to: string): string {
  const digits = String(to ?? "").replace(/[^\d]/g, "");
  return digits || String(to ?? "").trim();
}

function fresh(history: Stamp[], now: number): Stamp[] {
  return history.filter((item) => now - item.at <= OUTBOUND_WINDOW_MS);
}

function load(phone: string, now: number): Stamp[] {
  const history = fresh(sentByPhone.get(phone) ?? [], now);
  if (history.length === 0) sentByPhone.delete(phone);
  else sentByPhone.set(phone, history);
  return history;
}

export function resetOutboundGuard(): void {
  sentByPhone.clear();
}

export function outboundDecision(to: string, body: string, now = Date.now()): OutboundVerdict {
  const history = load(phoneKey(to), now);
  const text = String(body ?? "");
  if (history.some((item) => item.body === text)) return "duplicate";
  if (history.length >= OUTBOUND_MAX_PER_MINUTE) return "rate";
  return "send";
}

export function recordOutbound(to: string, body: string, now = Date.now()): void {
  const phone = phoneKey(to);
  const history = load(phone, now);
  history.push({ body: String(body ?? ""), at: now });
  sentByPhone.set(phone, history);
}

export function releaseOutbound(to: string, body: string, now = Date.now()): void {
  const phone = phoneKey(to);
  const text = String(body ?? "");
  const history = load(phone, now);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.body === text) {
      history.splice(index, 1);
      break;
    }
  }
  if (history.length === 0) sentByPhone.delete(phone);
  else sentByPhone.set(phone, history);
}
