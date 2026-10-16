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
const menuImageAt = new Map<string, number>();

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
  menuImageAt.clear();
}

export function menuImageRecentlySent(to: string, storeId: number, now = Date.now()): boolean {
  const at = menuImageAt.get(`${phoneKey(to)}:${storeId}`);
  return at != null && now - at <= OUTBOUND_WINDOW_MS;
}

export function recordMenuImage(to: string, storeId: number, now = Date.now()): void {
  menuImageAt.set(`${phoneKey(to)}:${storeId}`, now);
}

function foldBody(body: string): string {
  return String(body ?? "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** El texto entero es uno que este proceso ya mandó a ese número. Un "ok" o un "sí" no cuentan. */
export function wasRecentlySent(to: string, body: string, now = Date.now()): boolean {
  const folded = foldBody(body);
  if (folded.length < 12) return false;
  return load(phoneKey(to), now).some((item) => foldBody(item.body) === folded);
}

export function outboundSendsLeft(to: string, now = Date.now()): number {
  return Math.max(0, OUTBOUND_MAX_PER_MINUTE - load(phoneKey(to), now).length);
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

/**
 * Si el mismo texto de cliente se bloquea en 60 s, esto es el aviso distinto
 * que sí puede salir una vez. Mensajes de tienda o repartidor regresan null.
 */
export function customerFlowFallback(blockedBody: string): string | null {
  const folded = foldBody(blockedBody)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (!folded || folded.startsWith("sigo en este paso") || folded.startsWith("aqui sigo")) return null;
  if (folded.startsWith("va, dime que quieres") || folded.startsWith("te lo acabo de pasar")) return null;
  if (folded.startsWith("perdon, me lo repites") || folded.startsWith("escribemelo por favor")) return null;
  if (
    /#(confirmo|recogi|entregado|precio)/.test(folded) ||
    /\borden\b/.test(folded) ||
    folded.includes("cobrar") ||
    folded.includes("no_disponible") ||
    folded.includes("repartidor")
  ) {
    return null;
  }
  if (folded.includes("ubicacion por gps") || folded.includes("compartes tu ubicacion") || folded.includes("mandame el pin")) {
    return "Sigo en este paso. Mándame el pin de tu ubicación, o escribe calle y número.";
  }
  if (folded.includes("estan bien estos productos") || folded.includes("tu pedido esta bien")) {
    return "Sigo en este paso. Si la lista ya está bien, responde sí. Si no, dime qué le cambio.";
  }
  if (folded.includes("menu") || folded.includes("foto")) {
    return "Va, dime qué quieres del menú 😊";
  }
  if (folded.includes("?")) {
    return "Sigo en este paso. Contéstame lo que te pregunté: la marca, el tamaño o el número.";
  }
  return "Aquí sigo 😊, dime qué te gustaría pedir";
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
