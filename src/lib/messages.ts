import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";

export type ChatMessageRole = "cliente" | "bot";

export type ChatHistoryItem = {
  texto: string;
  estado: ChatMessageRole;
  created_at: string;
};

export type IncomingWhatsAppMessage = {
  from: string;
  body: string;
  raw: unknown;
  location?: { latitude: number; longitude: number };
};

// Nota: Whapi.cloud entrega la ubicación anidada en message.location.{latitude,longitude} —
// distinto de este shape plano. La normalización real (leer el payload nativo de Whapi y
// aplanarlo a { data: { from, body, latitude, longitude } }) vive en /api/webhook/route.ts
// (extractWaapiLocation). Este parser solo consume el shape ya normalizado.
const incomingSchema = z
  .object({
    from: z.string().min(3).optional(),
    body: z.string().min(1).optional(),
    latitude: z.coerce.number().optional(),
    longitude: z.coerce.number().optional(),
    data: z
      .object({
        from: z.string().min(3).optional(),
        body: z.string().min(1).optional(),
        latitude: z.coerce.number().optional(),
        longitude: z.coerce.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseIncomingWhatsAppMessage(payload: unknown): IncomingWhatsAppMessage {
  const parsed = incomingSchema.parse(payload);
  const from = parsed.from ?? parsed.data?.from;
  const body = parsed.body ?? parsed.data?.body;
  if (!from || !body) throw new Error("Payload inválido. Se esperaba {from, body}.");

  const latitude = parsed.data?.latitude ?? parsed.latitude;
  const longitude = parsed.data?.longitude ?? parsed.longitude;
  const location =
    typeof latitude === "number" && typeof longitude === "number"
      ? { latitude, longitude }
      : undefined;

  return { from, body, raw: payload, location };
}

// El historial de chat vive en clientes_new.metadata_json.chat_history (un
// arreglo acotado), no en una tabla de pedidos: el cliente puede platicar
// (saludo, small talk) sin tener un pedido activo, así que no puede depender
// de que exista una fila de pedido. Reemplaza a la tabla legacy `pedidos`
// (que mezclaba mensajes de chat con filas de orden) y al espejo en
// pedido_mensajes que hacía dualWrite.ts.
const CHAT_HISTORY_STORAGE_LIMIT = 30;

async function getClienteMetadata(telefono: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("clientes_new")
    .select("metadata_json")
    .eq("telefono", telefono)
    .maybeSingle();
  if (error) throw error;
  const metadata = data?.metadata_json;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export async function saveChatMessage(params: {
  telefono: string;
  texto: string;
  estado: ChatMessageRole;
}): Promise<void> {
  const telefono = normalizePhone(String(params.telefono ?? ""));
  if (!telefono) return;

  const supabase = getSupabaseAdmin();
  const metadata = await getClienteMetadata(telefono);
  const history = Array.isArray(metadata.chat_history) ? (metadata.chat_history as ChatHistoryItem[]) : [];
  const entry: ChatHistoryItem = {
    texto: params.texto,
    estado: params.estado,
    created_at: new Date().toISOString(),
  };
  const nextHistory = [...history, entry].slice(-CHAT_HISTORY_STORAGE_LIMIT);

  const { error } = await supabase
    .from("clientes_new")
    .upsert(
      { telefono, metadata_json: { ...metadata, chat_history: nextHistory } },
      { onConflict: "telefono" },
    );
  if (error) throw error;
}

export async function fetchRecentChatHistory(
  telefono: string,
  limit = 10,
): Promise<ChatHistoryItem[]> {
  const normalized = normalizePhone(String(telefono ?? ""));
  if (!normalized) return [];

  const metadata = await getClienteMetadata(normalized);
  const history = Array.isArray(metadata.chat_history) ? (metadata.chat_history as ChatHistoryItem[]) : [];

  // Mismo contrato que antes: más reciente primero.
  return history.slice(-limit).reverse();
}

export function sanitizeCustomerReply(text: string): string {
  let t = String(text ?? "");
  // Quitar fences y bloques tipo JSON que se hayan colado
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/\{[\s\S]*\}/g, " ");
  // Quitar la palabra "json" si se coló
  t = t.replace(/\bjson\b/gi, " ");
  // Normalizar espacios
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function isYesConfirmation(text: string): boolean {
  return /\b(si|sí|ok|va|confirmo|confirmar|dale|de acuerdo|visto bueno)\b/i.test(
    String(text ?? "").trim(),
  );
}

export function normalizeMessageIntentText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNewOrderIntent(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  return (
    t === "nuevo" ||
    t.includes("pedido nuevo") ||
    t.includes("nuevo pedido") ||
    t.includes("quiero empezar uno nuevo") ||
    t.includes("quiero un pedido nuevo") ||
    t.includes("reiniciar") ||
    t.includes("reinicio") ||
    t.includes("reset") ||
    t.includes("empezar de cero") ||
    t.includes("empecemos de cero") ||
    t.includes("empezar desde cero")
  );
}

export function isConversationModeMessage(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  // Heurística simple: mensajes emocionales o de charla general
  return (
    t.includes("estoy triste") ||
    t.includes("me siento") ||
    t.includes("que tienes") ||
    t.includes("que vendes") ||
    t.includes("que hay") ||
    t.includes("como estas") ||
    t === "hola" ||
    t.startsWith("hola ") ||
    t.includes("buenos dias") ||
    t.includes("buenas tardes") ||
    t.includes("buenas noches") ||
    t.includes("gracias")
  );
}

