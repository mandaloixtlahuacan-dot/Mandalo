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

// El historial de chat vive en clientes.metadata_json.chat_history (un
// arreglo acotado), no en una tabla de pedidos: el cliente puede platicar
// (saludo, small talk) sin tener un pedido activo, así que no puede depender
// de que exista una fila de pedido. Reemplaza a la tabla legacy `pedidos`
// (que mezclaba mensajes de chat con filas de orden) y al espejo en
// pedido_mensajes que hacía dualWrite.ts.
const CHAT_HISTORY_STORAGE_LIMIT = 30;

async function getClienteMetadata(telefono: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("clientes")
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
    .from("clientes")
    .upsert(
      { telefono, metadata_json: { ...metadata, chat_history: nextHistory } },
      { onConflict: "telefono" },
    );
  if (error) throw error;
}

// Retención (CLAUDE.md Sección 4 / brief Sección 3): "no se guarda nada del
// cliente entre pedidos — al cerrar un pedido, el chat se reinicia por
// completo". Se llama junto con la eliminación del pedido al llegar a un
// estado terminal (ver pedidoRepositoryV2.finalizePedidoRetention).
export async function resetChatHistory(telefono: string): Promise<void> {
  const tel = normalizePhone(String(telefono ?? ""));
  if (!tel) return;

  const supabase = getSupabaseAdmin();
  const metadata = await getClienteMetadata(tel);
  const { error } = await supabase
    .from("clientes")
    .update({ metadata_json: { ...metadata, chat_history: [] } })
    .eq("telefono", tel);
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

// Cancelación en lenguaje natural (CLAUDE.md Sección 5: "la cancelación es
// gratuita solo antes de que la tienda confirme el precio"). Antes solo el
// hard-reset con la frase exacta "pedido nuevo"/"reiniciar" cancelaba algo —
// un cliente real dice "ya no lo quiero", no esa frase específica.
// "cancel"/"anular" como raíz cubre todas las conjugaciones normales
// (cancelar/cancela/cancelalo/cancele/cancelo, anular/anula/anúlalo) sin
// tener que listar cada una — mismo estilo de heurística por substring que
// el resto de este archivo.
export function isCancelIntent(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  return (
    t.includes("cancel") ||
    t.includes("anular") ||
    t.includes("ya no lo quiero") ||
    t.includes("ya no quiero mi pedido") ||
    t.includes("ya no quiero el pedido") ||
    t.includes("ya no quiero continuar") ||
    t.includes("no quiero continuar") ||
    t.includes("no quiero seguir con") ||
    t.includes("olvidalo") ||
    t.includes("detener el pedido") ||
    t.includes("detener mi pedido") ||
    t.includes("ya no va") ||
    t.includes("ya no quiero nada")
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

// Escalamiento de quejas (brief sección 4 paso 9): "si hay una queja o algo
// salió mal, el bot escala directo al número de admin". Heurística de
// prioridad alta — se revisa antes que el resto del flujo, con o sin pedido
// activo (puede llegar después de que la retención ya borró el pedido).
export function isComplaintMessage(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  return (
    t.includes("queja") ||
    t.includes("reclamo") ||
    t.includes("me quejo") ||
    t.includes("no llego") ||
    t.includes("nunca llego") ||
    t.includes("no me llego") ||
    t.includes("no ha llegado") ||
    t.includes("salio mal") ||
    t.includes("esta mal") ||
    t.includes("llego mal") ||
    t.includes("llego incompleto") ||
    t.includes("faltaron") ||
    t.includes("faltan productos") ||
    t.includes("cobraron mal") ||
    t.includes("me cobraron de mas") ||
    t.includes("no es lo que pedi") ||
    t.includes("hablar con alguien") ||
    t.includes("hablar con una persona") ||
    t.includes("atencion al cliente") ||
    t.includes("quiero hablar con el administrador") ||
    t.includes("pesimo") ||
    t.includes("terrible servicio")
  );
}

