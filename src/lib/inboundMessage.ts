import { coordsFromMapText, extractCoordsFromUbicacion } from "@/lib/services/geo";

/**
 * Clasifica el webhook de Whapi antes de tocar el pedido.
 * Un pin, una ubicación en tiempo real, un adjunto real o un texto vacío
 * producen una respuesta. Un evento de sistema (source system, type unknown
 * y similares) no es un mensaje: contestarlo genera otro evento igual y el
 * bot se queda en bucle. Los acuses de entrega tampoco son mensajes.
 */

export const TEXT_ONLY_REPLY =
  "Perdón, por ahora solo podemos atender mensajes de texto. ¿Me lo escribes por favor?";

export const LIVE_LOCATION_REPLY =
  "Esa ubicación en tiempo real no la manejamos. Por favor mándanos tu ubicación actual (📎 > Ubicación > Enviar mi ubicación actual) o escribe tu dirección.";

export const GPS_PLACEHOLDER = "📍 (Cliente compartió su ubicación GPS)";

export const WEBHOOK_PROCESS_ERROR_REPLY =
  "⚠️ Tuve un problema procesando tu mensaje. Intenta escribirlo de nuevo en un momento — si sigue sin funcionar, ya le avisé a nuestro equipo. 🙏";

export type UnsupportedMedia = "sticker" | "image" | "audio" | "video" | "document" | "contact" | "unsupported";

export type ClassifiedInbound =
  | { kind: "ignore"; reason: "from_me" | "not_a_message" | "system" }
  | { kind: "missing_from" }
  | { kind: "text"; from: string; messageId: string | null; body: string }
  | { kind: "location"; from: string; messageId: string | null; body: string; latitude: number; longitude: number }
  | { kind: "location_unparsed"; from: string; messageId: string | null; body: string }
  | { kind: "live_location"; from: string; messageId: string | null; body: string }
  | { kind: "media"; from: string; messageId: string | null; body: string; media: UnsupportedMedia };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function messageObject(payload: unknown): Record<string, unknown> {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const direct = body.message ?? data.message;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  const arr = body.messages ?? data.messages;
  if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object") return arr[0] as Record<string, unknown>;
  return {};
}

function messageType(payload: unknown): string {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  return String(message.type ?? body.type ?? data.type ?? "").toLowerCase();
}

function isFromMe(payload: unknown): boolean {
  const body = asRecord(payload);
  const message = messageObject(payload);
  return [body.fromMe, body.from_me, message.fromMe, message.from_me, message.isFromMe].some((value) => value === true);
}

function eventLabel(payload: unknown): string {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const event = body.event ?? data.event;
  if (typeof event === "string") return event.toLowerCase();
  const record = asRecord(event);
  return `${String(record.type ?? "")} ${String(record.event ?? "")}`.trim().toLowerCase();
}

function isStatusEvent(payload: unknown): boolean {
  const label = eventLabel(payload);
  const names = ["statuses", "status", "ack", "acks", "presence", "presences", "calls", "chats", "groups", "users", "labels", "channel", "receipts", "receipt"];
  if (names.some((name) => label === name || label.startsWith(`${name} `) || label.endsWith(` ${name}`))) return true;
  const body = asRecord(payload);
  const message = messageObject(payload);
  const hasMessage = Object.keys(message).length > 0 || typeof body.text === "string" || typeof body.body === "string";
  return (Array.isArray(body.statuses) || Array.isArray(body.acks)) && !hasMessage;
}

function collectIds(payload: unknown): string[] {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  return [body.chatId, body.chat_id, body.from, body.to, data.chatId, data.chat_id, data.from, message.chatId, message.chat_id, message.from, message.to, message.sender, message.author].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
}

function isNonDirectChat(payload: unknown): boolean {
  return collectIds(payload).some((id) => {
    const lower = id.trim().toLowerCase();
    return lower.includes("@g.us") || lower.includes("@broadcast") || lower.includes("@newsletter");
  });
}

function isEditOrDelete(payload: unknown): boolean {
  const message = messageObject(payload);
  const type = messageType(payload);
  if (["edit", "edited", "message_edit", "revoke", "revoked", "delete", "deleted"].includes(type)) return true;
  if (message.edited === true || message.is_edited === true || message.isEdit === true) return true;
  const protocol = asRecord(message.protocol);
  const subtype = String(message.subtype ?? protocol.type ?? "").toLowerCase();
  return ["message_edit", "edit", "revoke", "revoked", "delete", "deleted"].includes(subtype);
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function chatId(payload: unknown): string | null {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  return firstString([
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
  ]);
}

function messageId(payload: unknown): string | null {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  return firstString([message.id, body.id, data.id]);
}

function textOf(payload: unknown): string | null {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  const textObj = asRecord(body.text ?? data.text ?? message.text);
  return firstString([body.text, body.body, data.body, data.text, message.body, message.text, textObj.body, textObj.text, message.caption]);
}

function captionOf(payload: unknown): string | null {
  const message = messageObject(payload);
  const nests = [message.image, message.video, message.document, message.audio, message.sticker, message.gif].map(asRecord);
  for (const nest of nests) {
    if (typeof nest.caption === "string" && nest.caption.trim() !== "") return nest.caption;
  }
  return textOf(payload);
}

function coordsOf(value: unknown): { latitude: number; longitude: number } | null {
  const loc = asRecord(value);
  const fromNumbers = extractCoordsFromUbicacion(loc);
  if (fromNumbers) return fromNumbers;
  return coordsFromMapText(`${String(loc.url ?? "")}\n${String(loc.address ?? "")}\n${String(loc.name ?? "")}`);
}

function pinOf(payload: unknown): { latitude: number; longitude: number } | null {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  for (const candidate of [message.location, body.location, data.location]) {
    const coords = coordsOf(candidate);
    if (coords) return coords;
  }
  return coordsFromMapText(textOf(payload) ?? "");
}

function mediaOf(payload: unknown, type: string): UnsupportedMedia | null {
  const message = messageObject(payload);
  if (type === "sticker" || message.sticker) return "sticker";
  if (type === "audio" || type === "voice" || type === "ptt" || message.audio || message.voice) return "audio";
  if (type === "video" || type === "gif" || message.video || message.gif) return "video";
  if (type === "image" || type === "imagemessage" || message.image) return "image";
  if (type === "document" || type === "file" || message.document) return "document";
  if (
    type === "contact" ||
    type === "contacts" ||
    type === "contact_list" ||
    type === "vcard" ||
    message.contact ||
    message.contacts ||
    message.vcard
  ) {
    return "contact";
  }
  return null;
}

const TEXT_TYPES = new Set(["text", "chat", "link_preview", "reply", "buttons_response", "list_response", "interactive"]);

const NON_MESSAGE_TYPES = new Set([
  "unknown",
  "system",
  "revoked",
  "revoke",
  "e2e_notification",
  "call_log",
  "call",
  "voice_call",
  "video_call",
  "reaction",
  "action",
  "notification",
  "receipt",
  "receipts",
  "ack",
  "acks",
  "edit",
  "edited",
  "message_edit",
  "delete",
  "deleted",
  "protocol",
  "ciphertext",
  "ephemeral",
  "group_invite",
  "newsletter",
  "broadcast",
]);

function messageSource(payload: unknown): string {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const message = messageObject(payload);
  return String(message.source ?? body.source ?? data.source ?? "").trim().toLowerCase();
}

function ignoreNoise(payload: unknown, why: string): ClassifiedInbound {
  console.log("[inbound] ignorando evento que no es un mensaje", {
    why,
    type: messageType(payload) || null,
    source: messageSource(payload) || null,
    id: messageId(payload),
  });
  return { kind: "ignore", reason: why === "sin_texto_ni_medio" ? "not_a_message" : "system" };
}

export function classifyInbound(payload: unknown): ClassifiedInbound {
  if (isFromMe(payload)) return { kind: "ignore", reason: "from_me" };
  if (isStatusEvent(payload)) return { kind: "ignore", reason: "not_a_message" };
  if (isNonDirectChat(payload)) return ignoreNoise(payload, "chat_no_directo");
  if (isEditOrDelete(payload)) return ignoreNoise(payload, "edicion_o_borrado");

  const type = messageType(payload);
  if (messageSource(payload) === "system") return ignoreNoise(payload, "source_system");
  if (NON_MESSAGE_TYPES.has(type)) return ignoreNoise(payload, `tipo_${type}`);

  const from = chatId(payload);
  if (!from) return { kind: "missing_from" };

  const id = messageId(payload);
  const message = messageObject(payload);
  const live = type === "live_location" || type === "livelocation" || Boolean(message.live_location);
  if (live) {
    return { kind: "live_location", from, messageId: id, body: "📍 (ubicación en tiempo real)" };
  }

  if (type === "location") {
    const coords = pinOf(payload);
    if (coords) {
      return { kind: "location", from, messageId: id, body: textOf(payload) ?? GPS_PLACEHOLDER, ...coords };
    }
    return { kind: "location_unparsed", from, messageId: id, body: GPS_PLACEHOLDER };
  }

  const media = mediaOf(payload, type);
  if (media) {
    const caption = captionOf(payload);
    return { kind: "media", from, messageId: id, body: caption ?? "📎", media };
  }

  const text = textOf(payload);
  if (text || TEXT_TYPES.has(type)) {
    return { kind: "text", from, messageId: id, body: text ?? " " };
  }

  return ignoreNoise(payload, "sin_texto_ni_medio");
}
