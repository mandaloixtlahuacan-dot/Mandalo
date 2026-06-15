import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { mirrorChatMessage } from "@/lib/dualWrite";

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

const incomingSchema = z
  .object({
    from: z.string().min(3).optional(),
    body: z.string().min(1).optional(),
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

  const latitude = parsed.data?.latitude;
  const longitude = parsed.data?.longitude;
  const location =
    typeof latitude === "number" && typeof longitude === "number"
      ? { latitude, longitude }
      : undefined;

  return { from, body, raw: payload, location };
}

export async function saveChatMessage(params: {
  telefono: string;
  texto: string;
  estado: ChatMessageRole;
  legacyPedidoId?: number;
  pedidoV2Id?: number;
  telefonoDestino?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("pedidos").insert({
    telefono_cliente: params.telefono,
    detalle_pedido: params.texto,
    estado: params.estado,
  });
  if (error) throw error;

  // Dual write best-effort (no rompe legacy).
  try {
    await mirrorChatMessage({
      rolMensaje: params.estado,
      contenido: params.texto,
      telefonoOrigen: params.telefono,
      telefonoDestino: params.telefonoDestino ?? null,
      canal: "whatsapp",
      legacyPedidoId: params.legacyPedidoId ?? null,
      pedidoV2Id: params.pedidoV2Id ?? null,
      telefonoCliente: params.telefono,
    });
  } catch {
    // mirrorChatMessage ya es best-effort, pero blindamos doble.
  }
}

export async function fetchRecentChatHistory(
  telefono: string,
  limit = 10,
): Promise<ChatHistoryItem[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("detalle_pedido, estado, created_at")
    .eq("telefono_cliente", telefono)
    .in("estado", ["cliente", "bot"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((x) => ({
    texto: String((x as { detalle_pedido?: unknown }).detalle_pedido ?? ""),
    estado:
      String((x as { estado?: unknown }).estado ?? "cliente") === "bot" ? "bot" : "cliente",
    created_at: String((x as { created_at?: unknown }).created_at ?? ""),
  }));
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

export type OrderItem = {
  name: string;
  qty?: string | null;
  details?: string | null;
};

function asOrderItems(value: unknown): OrderItem[] {
  if (!Array.isArray(value)) return [];
  const out: OrderItem[] = [];
  for (const it of value) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!name) continue;
    const qty = o.qty == null ? null : String(o.qty);
    const details = o.details == null ? null : String(o.details);
    out.push({ name, qty, details });
  }
  return out;
}

export function formatPedidoForBusiness(orderState: unknown): string {
  const o = (orderState ?? {}) as Record<string, unknown>;
  const items = asOrderItems(o.items);
  if (!items.length) {
    const raw = String(o.notes ?? "").trim();
    return raw ? raw : "(sin detalle)";
  }
  return items
    .map((it) => {
      const parts = [String(it.qty ?? "").trim(), it.name].filter(Boolean).join(" ").trim();
      return `- ${parts}${it.details ? ` (${String(it.details).trim()})` : ""}`.trim();
    })
    .join("\n");
}

export function formatCustomerOrderSummary(state: unknown): string {
  const o = (state ?? {}) as Record<string, unknown>;
  const items = asOrderItems(o.items);
  const lista = items.length
    ? items
        .map((it) => {
          const parts = [String(it.qty ?? "").trim(), it.name].filter(Boolean).join(" ").trim();
          return `• ${parts}${it.details ? ` (${String(it.details).trim()})` : ""}`.trim();
        })
        .join("\n")
    : "• (sin productos)";

  const dir = String((o.address_text ?? o.addressText ?? "") as string).trim();
  return `${lista}${dir ? `\n\n📍 Dirección: ${dir}` : ""}`.trim();
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

export function isContinueIntent(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  return t.includes("continuar") || t.includes("seguir") || t === "si" || t === "ok" || t === "va";
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

export function isCourierStatusUpdate(text: string): boolean {
  const t = normalizeMessageIntentText(text);
  return t.includes("ya recogi") || t.includes("ya llegue") || t.includes("entregado");
}

export function formatBusinessQuoteRequest(params: {
  orderId: number;
  customerName?: string | null;
  addressText?: string | null;
  items: OrderItem[];
  notes?: string | null;
}): string {
  const pedido = params.items.length
    ? params.items
        .map((it) => {
          const parts = [String(it.qty ?? "").trim(), it.name].filter(Boolean).join(" ").trim();
          return `- ${parts}${it.details ? ` (${String(it.details).trim()})` : ""}`.trim();
        })
        .join("\n")
    : "(sin detalle)";

  const header =
    `COTIZAR. ORDEN #${params.orderId}\n` +
    `${params.customerName ? `Cliente: ${params.customerName}\n` : ""}` +
    `${params.addressText ? `Dirección: ${params.addressText}\n` : ""}` +
    `Pedido:\n${pedido}\n\n` +
    `Responde así: ORDEN #${params.orderId} PRECIO 150`;

  const notes = String(params.notes ?? "").trim();
  return notes ? `${header}\n\nNotas:\n${notes}` : header;
}

export function formatCourierAssignmentMessage(params: {
  courierName: string;
  customerName?: string | null;
  customerPhone: string;
  addressText?: string | null;
  mapsLink?: string | null;
  total?: number | null;
  items: OrderItem[];
  orderId: number;
}): string {
  const pedido = params.items.length
    ? params.items
        .map((it) => {
          const parts = [String(it.qty ?? "").trim(), it.name].filter(Boolean).join(" ").trim();
          return `• ${parts}${it.details ? ` (${String(it.details).trim()})` : ""}`.trim();
        })
        .join("\n")
    : "• (sin productos)";

  const totalLine =
    typeof params.total === "number" && Number.isFinite(params.total) && params.total > 0
      ? `💰 Total: $${params.total}\n`
      : "";

  const mapsLine = params.mapsLink ? `🗺️ Mapa: ${params.mapsLink}\n` : "";

  return (
    `Hola ${params.courierName}, tienes un nuevo servicio. 📦\n\n` +
    `🧾 ORDEN #${params.orderId}\n` +
    `👤 Cliente: ${params.customerName || "(sin nombre)"}\n` +
    `📞 Tel cliente: ${params.customerPhone}\n` +
    `📍 Dirección: ${params.addressText || "(sin dirección)"}\n` +
    totalLine +
    mapsLine +
    `\nProductos:\n${pedido}\n\n` +
    "¿Aceptas el servicio? Responde SÍ para confirmar."
  );
}
