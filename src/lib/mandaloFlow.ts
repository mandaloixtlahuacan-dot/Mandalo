import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getOpenAI, getOpenAIModel } from "@/lib/openaiClient";
import { buildMandaloSystemPrompt } from "@/lib/mandaloPrompt";
import { normalizeWhatsAppText, waapiSendText } from "@/lib/waapi";
import { detectActorByPhone } from "@/lib/roles";
import { normalizePhone } from "@/lib/roles";
import { getEnv } from "@/lib/env";
import {
  actualizarOrden,
  calculateFinalPrice,
  crearOrden,
  extraerOrdenId,
  extraerPrecio,
  getActiveOrderByCustomerPhone,
  getOrderById,
  transitionOrderState,
} from "@/lib/ordenes";
import { MandaloAgentResponse, mandaloAgentResponseSchema } from "@/lib/llmResponseSchema";
import {
  fetchRecentChatHistory as fetchHistorialReciente,
  formatCustomerOrderSummary as formatResumenParaCliente,
  formatPedidoForBusiness,
  isContinueIntent,
  isConversationModeMessage,
  isCourierStatusUpdate,
  isNewOrderIntent,
  isYesConfirmation,
  normalizeMessageIntentText as normalizeText,
  parseIncomingWhatsAppMessage,
  saveChatMessage as guardarMensajeChat,
  sanitizeCustomerReply,
  type IncomingWhatsAppMessage,
} from "@/lib/messages";

type JsonObject = Record<string, unknown>;
type NegocioRow = { id?: unknown; nombre?: unknown; categoria?: unknown; whatsapp?: unknown };
type CourierRow = { id?: unknown; nombre?: unknown; whatsapp?: unknown; activo?: unknown; vehiculo?: unknown };
type PedidoRow = {
  id?: unknown;
  estado?: unknown;
  detalle_pedido?: unknown;
  created_at?: unknown;
  total?: unknown;
  telefono_cliente?: unknown;
};
type HistorialMessage = { texto: string; estado: "cliente" | "bot"; created_at: string };
type LlmMessage = { role: "system" | "user" | "assistant"; content: string };
type ResolvedNegocio = { id?: unknown; nombre?: unknown; whatsapp: string; categoria?: unknown };
type DispatchBusiness = { id?: unknown; nombre?: string; whatsapp: string };
type MissingCriticalField = "business" | "address" | "items";
type ActiveAssignedOrder = { orderId: number; state: JsonObject };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function phonesMatch(a: unknown, b: unknown): boolean {
  const left = normalizePhone(String(a ?? ""));
  const right = normalizePhone(String(b ?? ""));
  if (!left || !right) return false;
  if (left === right) return true;
  return left.slice(-10) === right.slice(-10);
}

function getPhoneVariants(rawPhone: string): string[] {
  const sid = normalizePhone(String(rawPhone ?? ""));
  const last10 = sid.length > 10 ? sid.slice(-10) : sid;
  return Array.from(
    new Set([sid, last10, `52${last10}`, `521${last10}`].map((x) => String(x ?? "").trim()).filter(Boolean)),
  );
}

function isAdminSender(phone: string): boolean {
  const env = getEnv();
  const admin = normalizePhone(String(env.MANDALO_ADMIN_PHONE ?? ""));
  if (!admin) return false;
  const sender = normalizePhone(String(phone ?? ""));
  if (!sender) return false;
  return sender === admin || sender.slice(-10) === admin.slice(-10);
}

function hasSelectedBusiness(order: JsonObject): boolean {
  return [order.business_id, order.businessId, order.business_phone, order.businessPhone, order.business_name, order.businessName]
    .some((value) => String(value ?? "").trim() !== "");
}

function hasUsableAddress(order: JsonObject): boolean {
  const address = String(order.address_text ?? order.addressText ?? "").trim();
  return address.length >= 8;
}

function hasUsableItems(order: JsonObject): boolean {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) return false;

  return items.some((item) => {
    const row = asJsonObject(item);
    const name = String(row.name ?? "").trim();
    const qty = String(row.qty ?? "").trim();
    const details = String(row.details ?? "").trim();
    return name.length > 0 && (qty.length > 0 || details.length > 0 || items.length === 1);
  });
}

export function getMissingCriticalFields(order: JsonObject): MissingCriticalField[] {
  const missing: MissingCriticalField[] = [];
  if (!hasSelectedBusiness(order)) missing.push("business");
  if (!hasUsableAddress(order)) missing.push("address");
  if (!hasUsableItems(order)) missing.push("items");
  return missing;
}

export function isOrderReadyForConfirmation(order: JsonObject): boolean {
  return getMissingCriticalFields(order).length === 0;
}

export function isOrderReadyForBusinessDispatch(order: JsonObject): boolean {
  return isOrderReadyForConfirmation(order);
}

function buildMissingCriticalFieldsMessage(order: JsonObject): string {
  const missing = getMissingCriticalFields(order);
  const first = missing[0];

  if (first === "business") {
    return "Antes de seguir, necesito que me digas de qué negocio quieres pedir. 🛒";
  }
  if (first === "address") {
    return "Antes de seguir, necesito tu dirección completa para poder coordinar el pedido. 📍";
  }
  if (first === "items") {
    return "Antes de seguir, necesito que me confirmes bien los productos que quieres pedir. 🛒";
  }

  return "Todavía me falta información crítica para continuar con tu pedido. 🙏";
}

function isConfirmedCustomerState(rawEstado: unknown): boolean {
  const v = String(rawEstado ?? "").trim().toLowerCase();
  return (
    v === "confirmado" ||
    v === "en_proceso" ||
    v === "repartidor_asignado" ||
    v === "asignado" ||
    v === "en_camino" ||
    v === "llegado" ||
    v === "completado" ||
    v === "entregado"
  );
}

function isRedundantConfirmationMessage(text: string): boolean {
  const normalized = normalizeText(text);
  return isYesConfirmation(text) || normalized.includes("confirmar") || normalized.includes("confirmado");
}

function isOrderTrackingQuestion(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    normalized.includes("donde esta mi pedido") ||
    normalized.includes("dónde está mi pedido") ||
    normalized.includes("donde viene") ||
    normalized.includes("como va mi pedido") ||
    normalized.includes("cómo va mi pedido") ||
    normalized.includes("repartidor") ||
    normalized.includes("ya salio") ||
    normalized.includes("ya salió")
  );
}

const MANDALO_SERVICE_FEE = 20;
const MANDALO_DELIVERY_FEE = 35;

function formatEstimatedArrival(minutesToAdd = 20): string {
  const eta = new Date(Date.now() + minutesToAdd * 60 * 1000);
  return eta.toLocaleTimeString("es-MX", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function ensureSafeLlmOrderState(
  value: unknown,
  fallbackStage = "collecting",
): MandaloAgentResponse["order_state"] {
  const base = asJsonObject(value);
  const stage = String(base.stage ?? "").trim() || fallbackStage;
  const items = Array.isArray(base.items) ? base.items : [];
  return {
    ...(base as Record<string, unknown>),
    stage,
    items: items as MandaloAgentResponse["order_state"]["items"],
  };
}

// Archivo sobrescrito desde cero (Bloques 1 + 2).
// Nota: parseIncomingWhatsAppMessage se re-exporta desde "@/lib/messages" para compatibilidad con /api/webhook.

// Flags ligeros en memoria (best-effort). En entornos serverless no se garantiza persistencia,
// pero ayuda a evitar bucles cuando llegan mensajes consecutivos.
const sessionFlags = new Map<string, { pedido_en_proceso: boolean; at: number }>();
const SESSION_FLAG_TTL_MS = 10 * 60 * 1000; // 10 min
export { parseIncomingWhatsAppMessage };
export type { IncomingWhatsAppMessage };

// Cache best-effort para validar remitentes de tienda (evita bypass por fallback de ORDEN+PRECIO)
const negocioPhoneCache = new Map<string, { isNegocio: boolean; at: number }>();
const NEGOCIO_PHONE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export async function getLLMResponse(params: {
  historialReciente: Array<{ role: "user" | "assistant"; content: string }>;
  supabaseJson: JsonObject;
  currentOrderState: JsonObject;
  userMessage: string;
}): Promise<MandaloAgentResponse> {
  // Consulta inteligente: siempre inyectamos negocios reales desde Supabase antes de procesar.
  const supabase = getSupabaseAdmin();
  let negocios: NegocioRow[] = [];
  try {
    const { data, error } = await supabase
      .from("negocios")
      .select("id, nombre, categoria, whatsapp")
      .limit(500);
    if (error) throw error;
    negocios = (data ?? []).filter(
      (n) => String((n as NegocioRow)?.nombre ?? "").trim() && String((n as NegocioRow)?.whatsapp ?? "").trim(),
    );
  } catch (e: unknown) {
    console.error("[mandalo] getLLMResponse: error consultando negocios", { message: getErrorMessage(e) });
  }

  const negocios_text =
    negocios.length
      ? negocios
          .map((n) => `- ${String(n.nombre ?? "")}${n.categoria ? ` (${String(n.categoria)})` : ""} [${String(n.whatsapp ?? "")}]`)
          .join("\n")
      : "(sin negocios disponibles)";

  const openai = getOpenAI();
  const model = getOpenAIModel() || "gpt-4o-mini";
  const system = buildMandaloSystemPrompt({
    negociosDisponibles: negocios_text,
    repartidoresActivos: String(params.supabaseJson?.repartidores_text ?? "(sin repartidores)"),
    historial: String(params.supabaseJson?.historial_text ?? ""),
  });

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    {
      role: "system",
      content: `CONTEXTO ADICIONAL:\n${JSON.stringify(
        { ...params.supabaseJson, negocios, order_state: params.currentOrderState },
        null,
        2,
      )}`,
    },
    ...params.historialReciente,
    { role: "user", content: params.userMessage },
  ];

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: 600,
    temperature: 0.6,
  });

  const text = String(completion.choices?.[0]?.message?.content ?? "");

  // Reparación del parser:
  // - NUNCA hacemos JSON.parse sobre texto sin antes extraer un bloque {...} por regex.
  // - Si no hay bloque JSON, seguimos conversando con texto plano.
  // - Si el parseo falla, NO lanzamos error: regresamos texto plano.
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);

  if (jsonMatch?.[0]) {
    const candidate = jsonMatch[0].trim();
    try {
      const parsedJson = JSON.parse(candidate);
      const parsed = mandaloAgentResponseSchema.safeParse(parsedJson);
      if (parsed.success) {
        return {
          ...parsed.data,
          order_state: ensureSafeLlmOrderState(parsed.data.order_state, "collecting"),
        };
      }
      console.error("Error de validación en IA:", parsed.error);
      console.error("Error de validación en IA (flatten):", parsed.error.flatten());
    } catch (e) {
      console.error("Error al parsear IA (tolerado):", e);
    }
  }

  // Fallback: texto plano (sin bloquear el flujo)
  const plain = trimmed.replace(/\{[\s\S]*\}/, "").trim();
  return {
    customer_reply: plain || trimmed || "¡Entendido! Dame un momento.",
    order_state: { stage: "collecting", items: [] },
  };
}

// --- BLOQUE 2: Lógica de manejo de actores y Webhook ---

function extractDireccionFromDetalle(detalle: string): string | null {
  const d = String(detalle ?? "").trim();
  if (!d) return null;

  // 1) Si es JSON (order_state), buscamos campos comunes
  try {
    const j = JSON.parse(d);
    const address =
      j?.address_text ??
      j?.direccion ??
      j?.direccion_texto ??
      j?.order_state?.address_text ??
      j?.order_state?.direccion ??
      null;
    if (address && String(address).trim()) return String(address).trim();
  } catch {
    // ignore
  }

  // 2) Google Maps
  const maps = d.match(/https?:\/\/(?:www\.)?maps\.google\.com\/\?q=[^ \n]+/i)?.[0];
  if (maps) return maps.trim();

  // 3) Texto con etiqueta "dirección:"
  const m =
    d.match(/direcci[oó]n\s*:\s*([^\n]+)$/i)?.[1] ??
    d.match(/direccion\s*:\s*([^\n]+)$/i)?.[1];
  if (m && String(m).trim()) return String(m).trim();

  return null;
}

async function fetchDireccionGuardadaDesdePedidos(telefono: string) {
  const active = await getActiveOrderByCustomerPhone(telefono).catch(() => null);
  const activeDir = extractDireccionFromDetalle(String(active?.record?.detalle_pedido ?? ""));
  if (activeDir) return activeDir;

  const recovered = await recoverLatestOrderStateWithItems(telefono);
  const recoveredDir = extractDireccionFromDetalle(JSON.stringify(recovered ?? {}));
  if (recoveredDir) return recoveredDir;

  return null;
}

function safeParseDetalleJson(detalle: unknown): JsonObject | null {
  try {
    return asJsonObject(JSON.parse(String(detalle ?? "{}")));
  } catch {
    return null;
  }
}

async function recoverLatestOrderStateWithItems(telefono: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("detalle_pedido, estado, created_at")
    .eq("telefono_cliente", telefono)
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema)")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    console.error("[mandalo] recoverLatestOrderStateWithItems error:", error.message);
    return null;
  }

  for (const row of data ?? []) {
    const state = safeParseDetalleJson((row as PedidoRow)?.detalle_pedido);
    const items = Array.isArray(state?.items) ? state.items : [];
    if (items.length > 0) return state;
  }
  return null;
}

async function ensureItemsNotEmpty(params: {
  telefono: string;
  currentState: JsonObject;
  orderIdToUpdate?: number;
}) {
  const items = Array.isArray(params.currentState?.items) ? params.currentState.items : [];
  if (items.length > 0) return params.currentState;

  const recovered = await recoverLatestOrderStateWithItems(params.telefono);
  if (!recovered) return params.currentState;

  // Si recuperamos items, los persistimos en la orden actual (si se indicó)
  if (params.orderIdToUpdate) {
    const merged = { ...(params.currentState ?? {}), ...(recovered ?? {}) };
    await actualizarOrden(params.orderIdToUpdate, { detalle_pedido: JSON.stringify(merged) }).catch(() => {});
    return merged;
  }

  return { ...(params.currentState ?? {}), ...(recovered ?? {}) };
}

function getSessionFlag(phone: string) {
  const key = normalizePhone(phone);
  const f = sessionFlags.get(key);
  if (!f) return null;
  if (Date.now() - f.at > SESSION_FLAG_TTL_MS) {
    sessionFlags.delete(key);
    return null;
  }
  return f;
}

function setSessionFlag(phone: string, flag: { pedido_en_proceso: boolean }) {
  const key = normalizePhone(phone);
  sessionFlags.set(key, { ...flag, at: Date.now() });
}

async function isNegocioSenderPhone(rawPhone: string): Promise<boolean> {
  const phoneNorm = normalizePhone(String(rawPhone ?? ""));
  const key = phoneNorm.length > 10 ? phoneNorm.slice(-10) : phoneNorm;
  const cached = negocioPhoneCache.get(key);
  if (cached && Date.now() - cached.at < NEGOCIO_PHONE_CACHE_TTL_MS) return cached.isNegocio;

  const supabase = getSupabaseAdmin();
  // Intento exacto (rápido)
  const exact = await supabase.from("negocios").select("whatsapp").eq("whatsapp", phoneNorm).limit(1);
  if (!exact.error && exact.data?.[0]?.whatsapp) {
    negocioPhoneCache.set(key, { isNegocio: true, at: Date.now() });
    return true;
  }

  // Fallback conservador: comparamos últimos 10 dígitos
  const { data, error } = await supabase.from("negocios").select("whatsapp").limit(1000);
  if (error) {
    console.error("[mandalo] isNegocioSenderPhone: error consultando negocios", { message: error.message });
    negocioPhoneCache.set(key, { isNegocio: false, at: Date.now() });
    return false;
  }
  const hit = (data ?? []).some((n: { whatsapp?: unknown }) => {
    const w = normalizePhone(String(n?.whatsapp ?? ""));
    const w10 = w.length > 10 ? w.slice(-10) : w;
    return w === phoneNorm || (w10 && key && w10 === key);
  });
  negocioPhoneCache.set(key, { isNegocio: hit, at: Date.now() });
  return hit;
}

async function cancelActiveOrdersBySenderId(senderId: string) {
  const supabase = getSupabaseAdmin();
  const sid = normalizePhone(String(senderId ?? ""));
  const last10 = sid.length > 10 ? sid.slice(-10) : sid;
  const variants = Array.from(
    new Set(
      [sid, last10, `52${last10}`, `521${last10}`]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean),
    ),
  );

  const orderIds = new Set<number>();

  // 1) Intento explícito consultando columna "whatsapp" (si existiera), sin mutar estado directo.
  try {
    const r = await supabase
      .from("pedidos")
      .select("id, estado")
      .eq("whatsapp", sid)
      .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema,cancelado,completado)");
    console.log("[DEBUG] Resultado de cancelación en DB:", r.data, r.error);
    for (const row of (r.data ?? []) as Array<{ id?: unknown }>) {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0) orderIds.add(id);
    }
  } catch (e: unknown) {
    console.log("[DEBUG] Resultado de cancelación en DB:", null, { message: getErrorMessage(e) });
  }

  // 2) Fallback real: columna correcta usada en este proyecto = telefono_cliente
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado")
    .in("telefono_cliente", variants)
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema,cancelado,completado)")
    .order("created_at", { ascending: false });
  console.log("[DEBUG] Resultado de cancelación en DB:", data, error);
  if (error) return false;

  for (const row of (data ?? []) as Array<{ id?: unknown }>) {
    const id = Number(row.id);
    if (Number.isFinite(id) && id > 0) orderIds.add(id);
  }

  let ok = true;
  for (const orderId of orderIds) {
    try {
      await transitionOrderState({ orderId, to: "cancelado" });
    } catch (e: unknown) {
      ok = false;
      console.error("[mandalo] transición fallida a cancelado", {
        orderId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return ok;
}

async function limpiarSesion(senderId: string) {
  // Limpieza en memoria (best-effort)
  try {
    sessionFlags.delete(normalizePhone(senderId));
  } catch {
    // no-op
  }
  // Limpieza en DB (obligatoria)
  await cancelActiveOrdersBySenderId(senderId);
}

function ensureMxWhatsappIntl(raw: string) {
  const d = normalizePhone(String(raw ?? ""));
  // WhatsApp México suele usar 52 + 10 dígitos (a veces 521 + 10)
  if (d.length === 10) return `52${d}`;
  if (d.length === 12 && d.startsWith("52")) return d;
  if (d.length === 13 && d.startsWith("521")) return d;
  // Si viene con otro largo, lo regresamos como está (pero ya normalizado)
  return d;
}

async function findActiveCourier() {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("repartidores")
      .select("id, nombre, whatsapp, activo, vehiculo")
      .eq("activo", true)
      .order("id", { ascending: true })
      .limit(1);
    if (error) {
      console.error("[mandalo] error consultando tabla repartidores:", { message: error.message });
      return null;
    }
    const row = (data ?? [])[0] as CourierRow | undefined;
    if (row?.whatsapp) return row;
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando tabla repartidores:", { message: getErrorMessage(e) });
  }
  return null;
}

async function findCourierByPhone(phone: string) {
  const supabase = getSupabaseAdmin();
  const phoneNorm = normalizePhone(String(phone ?? ""));
  const phone10 = phoneNorm.length <= 10 ? phoneNorm : phoneNorm.slice(-10);
  try {
    const { data, error } = await supabase
      .from("repartidores")
      .select("id, nombre, whatsapp, activo, vehiculo")
      .limit(500);
    if (error) {
      console.error("[mandalo] error consultando tabla repartidores:", { message: error.message });
      return null;
    }
    const hit = (data ?? []).find((r) => {
      const row = r as CourierRow;
      const w = normalizePhone(String(row?.whatsapp ?? ""));
      const w10 = w.length <= 10 ? w : w.slice(-10);
      return w === phoneNorm || (w10 && phone10 && w10 === phone10);
    });
    if (hit) return hit as CourierRow;
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando tabla repartidores:", { message: getErrorMessage(e) });
  }
  return null;
}

async function resolveBusinessWhatsappStrictByName(tiendaNombre: string) {
  const supabase = getSupabaseAdmin();
  const name = String(tiendaNombre ?? "").trim();
  if (!name) return null;

  // 1) Match exacto
  const exact = await supabase
    .from("negocios")
    .select("nombre, whatsapp")
    .eq("nombre", name)
    .limit(1);
  if (!exact.error && exact.data?.[0]?.whatsapp) {
    return {
      nombre: String(exact.data[0].nombre ?? name),
      whatsapp: ensureMxWhatsappIntl(String(exact.data[0].whatsapp)),
    };
  }

  // 2) Fallback por ilike (por si hay variaciones mínimas)
  const like = await supabase
    .from("negocios")
    .select("nombre, whatsapp")
    .ilike("nombre", `%${name}%`)
    .limit(1);
  if (!like.error && like.data?.[0]?.whatsapp) {
    return {
      nombre: String(like.data[0].nombre ?? name),
      whatsapp: ensureMxWhatsappIntl(String(like.data[0].whatsapp)),
    };
  }

  return null;
}

async function resolveNegocioFromDb(params: { id?: unknown; nombre?: unknown; whatsapp?: unknown }): Promise<ResolvedNegocio | null> {
  const supabase = getSupabaseAdmin();

  // 1) Por id
  if (params.id != null && String(params.id).trim() !== "") {
    const { data, error } = await supabase
      .from("negocios")
      .select("id, nombre, whatsapp, categoria")
      .eq("id", params.id)
      .maybeSingle();
    if (!error && data?.whatsapp) return { ...(data as NegocioRow), whatsapp: normalizePhone(String(data.whatsapp)) };
  }

  // 2) Por whatsapp
  if (params.whatsapp && String(params.whatsapp).trim()) {
    const w = String(params.whatsapp).trim();
    // Intento exacto
    const { data, error } = await supabase
      .from("negocios")
      .select("id, nombre, whatsapp, categoria")
      .eq("whatsapp", w)
      .maybeSingle();
    if (!error && data?.whatsapp) return { ...(data as NegocioRow), whatsapp: normalizePhone(String(data.whatsapp)) };

    // Fallback por normalización (comparamos últimos 10 dígitos)
    const wNorm = normalizePhone(w);
    const w10 = wNorm.length <= 10 ? wNorm : wNorm.slice(-10);
    const { data: all, error: e2 } = await supabase
      .from("negocios")
      .select("id, nombre, whatsapp, categoria")
      .limit(1000);
    if (!e2 && all?.length) {
      const hit = (all as NegocioRow[]).find((n) => {
        const db = normalizePhone(String(n.whatsapp ?? ""));
        const db10 = db.length <= 10 ? db : db.slice(-10);
        return db === wNorm || db10 === w10;
      });
      if (hit?.whatsapp) return { ...hit, whatsapp: normalizePhone(String(hit.whatsapp)) };
    }
  }

  // 3) Por nombre (ilike)
  if (params.nombre && String(params.nombre).trim()) {
    const name = String(params.nombre).trim();
    const { data, error } = await supabase
      .from("negocios")
      .select("id, nombre, whatsapp, categoria")
      .ilike("nombre", `%${name}%`)
      .limit(1);
    if (!error && data?.[0]?.whatsapp) {
      const row = data[0] as NegocioRow;
      return { ...row, whatsapp: normalizePhone(String(row.whatsapp)) };
    }
  }

  return null;
}

async function resolveBusinessForDispatch(state: JsonObject): Promise<DispatchBusiness | null> {
  const businessId = state.business_id ?? state.businessId ?? null;
  const businessPhone = state.business_phone ?? state.businessPhone ?? null;
  const businessName = state.business_name ?? state.businessName ?? null;

  const primary = await resolveNegocioFromDb({
    id: businessId,
    whatsapp: businessPhone,
    nombre: businessName,
  }).catch((e: unknown) => {
    console.error("[mandalo] resolveBusinessForDispatch: resolveNegocioFromDb falló", {
      business_id: businessId,
      business_phone: businessPhone,
      business_name: businessName,
      message: getErrorMessage(e),
    });
    return null;
  });

  if (primary?.whatsapp) {
    return {
      id: primary.id ?? businessId ?? null,
      nombre: String(primary.nombre ?? businessName ?? "").trim() || undefined,
      whatsapp: ensureMxWhatsappIntl(String(primary.whatsapp)),
    };
  }

  const strictName = String(businessName ?? "").trim();
  if (strictName) {
    const fallback = await resolveBusinessWhatsappStrictByName(strictName).catch((e: unknown) => {
      console.error("[mandalo] resolveBusinessForDispatch: fallback por nombre falló", {
        business_id: businessId,
        business_phone: businessPhone,
        business_name: strictName,
        message: getErrorMessage(e),
      });
      return null;
    });
    if (fallback?.whatsapp) {
      return {
        id: businessId ?? null,
        nombre: String(fallback.nombre ?? strictName).trim() || undefined,
        whatsapp: ensureMxWhatsappIntl(String(fallback.whatsapp)),
      };
    }
  }

  console.error("[mandalo] resolveBusinessForDispatch: negocio no encontrado", {
    business_id: businessId,
    business_phone: businessPhone,
    business_name: businessName,
  });
  return null;
}

function logBusinessDispatch(params: {
  orderId: number;
  businessId?: unknown;
  businessName?: unknown;
  businessPhone?: unknown;
  to: string;
  body: string;
}) {
  console.log("[dispatch][business]", {
    orderId: params.orderId,
    business_id: params.businessId ?? null,
    business_name: String(params.businessName ?? "").trim() || null,
    business_phone: String(params.businessPhone ?? "").trim() || null,
    to: params.to,
    bodyPreview: String(params.body ?? "").slice(0, 300),
  });
}

function logCourierDispatch(params: {
  orderId: number;
  courierName?: unknown;
  courierPhone?: unknown;
  customerPhone?: unknown;
  mapsLink?: unknown;
  body: string;
}) {
  console.log("[dispatch][courier]", {
    orderId: params.orderId,
    courier_name: String(params.courierName ?? "").trim() || null,
    courier_phone: String(params.courierPhone ?? "").trim() || null,
    customer_phone: String(params.customerPhone ?? "").trim() || null,
    mapsLink: String(params.mapsLink ?? "").trim() || null,
    bodyPreview: String(params.body ?? "").slice(0, 300),
  });
}

async function getCurrentOrderStateForAgent(telefono: string): Promise<JsonObject> {
  const active = await getActiveOrderByCustomerPhone(telefono).catch(() => null);
  if (active?.snapshot && Object.keys(active.snapshot).length > 0) return active.snapshot as JsonObject;

  const recovered = await recoverLatestOrderStateWithItems(telefono);
  if (recovered && Object.keys(recovered).length > 0) return recovered;

  return {};
}

async function findActiveOrderForAssignedPhone(params: {
  role: "tienda" | "repartidor";
  senderPhone: string;
  preferredOrderId?: number | null;
}): Promise<ActiveAssignedOrder | null> {
  const senderPhone = normalizePhone(String(params.senderPhone ?? ""));
  if (!senderPhone) return null;

  const getAssignedPhoneForRole = (state: JsonObject) => {
    if (params.role === "tienda") {
      return normalizePhone(String(state.business_phone ?? state.businessPhone ?? ""));
    }
    return normalizePhone(String(state.courier_phone ?? state.courierPhone ?? state.repartidor_whatsapp ?? ""));
  };

  const matchesRole = (state: JsonObject, context: { orderId: number | null; source: string }) => {
    const assignedPhone = getAssignedPhoneForRole(state);
    const match = phonesMatch(senderPhone, assignedPhone);
    console.log("[DEBUG][role-match]", {
      role: params.role,
      source: context.source,
      orderId: context.orderId,
      senderPhone,
      assignedPhone,
      match,
    });
    return match;
  };

  if (params.preferredOrderId && Number.isFinite(params.preferredOrderId) && params.preferredOrderId > 0) {
    try {
      const order = await getOrderById(params.preferredOrderId);
      const state = (order.snapshot ?? {}) as JsonObject;
      if (matchesRole(state, { orderId: params.preferredOrderId, source: "preferredOrderId" })) {
        return { orderId: params.preferredOrderId, state };
      }
      return null;
    } catch (e: unknown) {
      console.error("[mandalo] findActiveOrderForAssignedPhone: preferredOrderId falló", {
        role: params.role,
        senderPhone,
        preferredOrderId: params.preferredOrderId,
        message: getErrorMessage(e),
      });
    }
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos")
    .select("id, estado, detalle_pedido, created_at")
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema,cancelado,completado,entregado)")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[mandalo] findActiveOrderForAssignedPhone error:", {
      role: params.role,
      senderPhone,
      message: error.message,
    });
    return null;
  }

  for (const row of data ?? []) {
    const record = row as PedidoRow;
    const orderId = Number(record.id);
    const state = safeParseDetalleJson(record.detalle_pedido) ?? {};
    if (Number.isFinite(orderId) && matchesRole(state, { orderId, source: "activeOrdersScan" })) {
      return { orderId, state };
    }
  }

  return null;
}

async function handleClienteMessage(telefono: string, mensaje: string, ubicacion?: unknown) {
  const supabase = getSupabaseAdmin();
  const phoneVariants = getPhoneVariants(telefono);

  // Debug del flujo: siempre logueamos el mensaje + estado actual en DB (si existe).
  const { data: lastRow, error: lastErr } = await supabase
    .from("pedidos")
    .select("id, estado")
    .in("telefono_cliente", phoneVariants)
    // Evitar tomar filas de "chat" como si fueran estado de orden
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) console.error("[mandalo] error consultando estadoActual:", lastErr.message);
  const estadoActual = String((lastRow as PedidoRow | null)?.estado ?? "(sin estado)");
  console.log("[DEBUG] Mensaje recibido:", String(mensaje ?? ""), "Estado detectado:", estadoActual);

  // FRENO DE SEGURIDAD (confirmación obligatoria):
  // Si existe un pedido esperando confirmación, NO enviamos a tienda hasta recibir "SÍ".
  const { data: esperando, error: esperandoErr } = await supabase
    .from("pedidos")
    .select("id, estado, detalle_pedido, created_at")
    .in("telefono_cliente", phoneVariants)
    .in("estado", ["esperando_confirmacion", "awaiting_confirmation"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (esperandoErr) console.error("[mandalo] error consultando esperando_confirmacion:", esperandoErr.message);
  if (esperando?.id) {
    const ordenId = Number((esperando as PedidoRow).id);
    const state = safeParseDetalleJson((esperando as PedidoRow)?.detalle_pedido) ?? {};
    const tiendaNombre = String(state?.business_name ?? state?.businessName ?? "").trim();

    // Si NO confirma, solo re-mostramos el resumen y pedimos SÍ (sin enviar a tienda).
    if (!isYesConfirmation(mensaje)) {
      const resumen = formatResumenParaCliente(state);
      const msgCliente =
        `✅ Ya tengo tu pedido:\n${resumen}\n\n` +
        "¿Es correcto tu pedido? Responde *SÍ* para confirmar. ✅";
      console.log("Cambio de estado:", "esperando_confirmacion");
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot", legacyPedidoId: ordenId }).catch(
        () => {},
      );
      return { ok: true, role: "cliente", stage: "esperando_confirmacion", ordenId };
    }

    // Confirmó: ahora sí enviamos a la tienda
    if (!isOrderReadyForBusinessDispatch(state)) {
      const msgCliente = buildMissingCriticalFieldsMessage(state);
      console.log("[mandalo] dispatch bloqueado por capa determinista", {
        orderId: ordenId,
        missing: getMissingCriticalFields(state),
      });
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot", legacyPedidoId: ordenId }).catch(
        () => {},
      );
      return { ok: true, role: "cliente", stage: "esperando_confirmacion", ordenId, missing: getMissingCriticalFields(state) };
    }

    if (!tiendaNombre) {
      const msgCliente =
        "⚠️ No pude identificar la tienda para tu pedido.\n" +
        "Dime de qué negocio quieres pedir (elige uno de la lista) y lo reintentamos. 🛒";
      console.log("--- INTENTANDO ENVIAR A WAAPI ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot", legacyPedidoId: ordenId }).catch(
        () => {},
      );
      return { ok: true, role: "cliente", stage: "esperando_confirmacion", ordenId };
    }

    const negocioResolved = await resolveBusinessForDispatch(state);
    const negocioFallback = !negocioResolved && tiendaNombre
      ? await resolveBusinessWhatsappStrictByName(tiendaNombre)
      : null;
    const negocio: DispatchBusiness | null = negocioResolved
      ? negocioResolved
      : negocioFallback?.whatsapp
        ? { id: state.business_id ?? state.businessId ?? null, nombre: negocioFallback.nombre, whatsapp: negocioFallback.whatsapp }
        : null;
    if (!negocio?.whatsapp) {
      console.error("[ERROR CRÍTICO] No se encontró el WhatsApp de la tienda en Supabase.", {
        orderId: ordenId,
        business_id: state.business_id ?? state.businessId ?? null,
        business_phone: state.business_phone ?? state.businessPhone ?? null,
        business_name: tiendaNombre,
      });
      return { ok: false, role: "cliente", error: "TIENDA_SIN_WHATSAPP" };
    }

    const customerName = String(state?.customer_name ?? "").trim();
    const addressText = String(state?.address_text ?? "").trim();
    const pedidoDetalle = formatPedidoForBusiness(state);
    const extraNotes = String(state?.pending_business_message ?? "").trim();
    const items = Array.isArray(state?.items) ? state.items : [];
    const negocioId =
      typeof negocio.id === "number" || typeof negocio.id === "string"
        ? negocio.id
        : typeof state.business_id === "number" || typeof state.business_id === "string"
          ? state.business_id
          : typeof state.businessId === "number" || typeof state.businessId === "string"
            ? state.businessId
            : null;
    const mapsLink = addressText
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`
      : null;

    try {
      const persisted = await getOrderById(ordenId);
      await transitionOrderState({
        orderId: ordenId,
        to: "pendiente_cotizacion_tienda",
        snapshotPatch: {
          ...(persisted.snapshot ?? {}),
          ...(addressText ? { address_text: addressText } : {}),
          ...(items.length ? { items } : {}),
          business_id: negocioId,
          business_name: String(negocio.nombre ?? tiendaNombre).trim(),
          business_phone: negocio.whatsapp,
          stage: "awaiting_quote",
        },
        contextOverrides: {
          customerPhone: telefono,
          businessId: negocioId,
          businessName: String(negocio.nombre ?? tiendaNombre).trim(),
          businessPhone: negocio.whatsapp,
          addressText,
          items,
          mapsLink,
        },
      });
      console.log("Cambio de estado:", "awaiting_quote");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida esperando_confirmacion -> pendiente_cotizacion_tienda", {
        orderId: ordenId,
        message: e instanceof Error ? e.message : String(e),
      });
      const msgCorreccion =
        !addressText
          ? "⚠️ No puedo mandar tu pedido todavía porque me falta tu dirección completa. Escríbemela por favor. 📍"
          : !negocio.whatsapp
            ? "⚠️ No puedo mandar tu pedido todavía porque no pude identificar correctamente la tienda. Dime de qué negocio te lo pido. 🛒"
            : "⚠️ No puedo mandar tu pedido todavía porque no pude recuperar bien tus productos. ¿Me ayudas a confirmarlos? 🛒";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCorreccion) });
      await guardarMensajeChat({ telefono, texto: msgCorreccion, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "esperando_confirmacion", ordenId };
    }

    const encabezado =
      `COTIZAR. ORDEN #${ordenId}\n` +
      `${customerName ? `Cliente: ${customerName}\n` : ""}` +
      `${addressText ? `Dirección: ${addressText}\n` : ""}` +
      `Pedido:\n${pedidoDetalle}\n\n` +
      `Responde así: ORDEN #${ordenId} PRECIO 150`;
    const formatoParaTienda = extraNotes ? `${encabezado}\n\nNotas:\n${extraNotes}` : encabezado;

    logBusinessDispatch({
      orderId: ordenId,
      businessId: negocio.id ?? state.business_id ?? state.businessId ?? null,
      businessName: negocio.nombre ?? tiendaNombre,
      businessPhone: negocio.whatsapp,
      to: negocio.whatsapp,
      body: formatoParaTienda,
    });
    await waapiSendText({ to: negocio.whatsapp, body: normalizeWhatsAppText(formatoParaTienda) });

    const msgCliente =
      `✅ Perfecto. Ya envié tu pedido a *${String(negocio.nombre ?? tiendaNombre).trim()}*.\n` +
      "En cuanto me confirmen el precio final, te paso el total. 💰";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCliente) });
    await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot", legacyPedidoId: ordenId }).catch(
      () => {},
    );

    return { ok: true, role: "cliente", stage: "awaiting_quote", ordenId };
  }

  // HARD RESET (prioridad absoluta): si el usuario pide pedido nuevo/reiniciar,
  // interrumpimos cualquier otra lógica y reiniciamos el estado desde DB.
  if (isNewOrderIntent(mensaje)) {
    // Estado limpio: en memoria + DB
    await limpiarSesion(telefono);

    const nuevoState = {
      stage: "collecting",
      items: [],
      address_text: null,
      customer_name: null,
    };
    await crearOrden({
      telefonoCliente: telefono,
      resumenPedido: JSON.stringify(nuevoState),
      estado: "collecting",
    });

    // Flag: ya se decidió "nuevo", no volver a preguntar por el anterior inmediatamente.
    setSessionFlag(telefono, { pedido_en_proceso: true });

    const msg = "¡Entendido! Pedido anterior cancelado. ¿Qué te gustaría pedir hoy? 🛒";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "hard_reset" };
  }

  // Bloqueo de ubicación: no procesamos ubicaciones automáticas por seguridad/precisión.
  const msgLower = String(mensaje ?? "").toLowerCase();
  const looksLikeLocation =
    Boolean(ubicacion) ||
    msgLower.includes("compartir ubicación") ||
    msgLower.includes("compartir ubicacion") ||
    msgLower.includes("location") ||
    (msgLower.trim() === "ubicación" || msgLower.trim() === "ubicacion");
  if (looksLikeLocation) {
    const msg =
      "⚠️ Por seguridad y precisión, no puedo procesar ubicaciones automáticas.\n" +
      "Por favor, escríbeme tu dirección manualmente para que el repartidor llegue sin errores. 📍";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "bloqueo_ubicacion" };
  }

  // Modo conversación: si el usuario está charlando o expresando emociones,
  // contestamos con IA y NO aplicamos la validación de pedido pendiente en este turno.
  // (La IA decidirá si pregunta por productos/tienda/etc.)
  if (isConversationModeMessage(mensaje)) {
    // Guardar mensaje entrante en bitácora
    await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch(() => {});

    const historial = await fetchHistorialReciente(telefono, 12).catch(() => []);
    const currentOrderState = await getCurrentOrderStateForAgent(telefono);
    const respuesta = await getLLMResponse({
      historialReciente: (historial ?? [])
        .slice()
        .reverse()
        .map((m) => ({
          role: m.estado === "bot" ? ("assistant" as const) : ("user" as const),
          content: String(m.texto ?? ""),
        }))
        .filter((m) => m.content.trim()),
      supabaseJson: { maps_url: ubicacion ?? null },
      currentOrderState,
      userMessage: mensaje,
    });

    const customerReplyClean = sanitizeCustomerReply(String(respuesta.customer_reply ?? ""));
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(customerReplyClean) });
    await guardarMensajeChat({ telefono, texto: customerReplyClean, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "modo_conversacion" };
  }

  // Limpieza de estado / prevención de bucles:
  // Si hay un pedido pendiente y el usuario no está respondiendo a un paso esperado, preguntamos continuar/nuevo.
  // NOTA: si el usuario acaba de reiniciar (flag en sesión), no preguntamos por el anterior.
  const flag = getSessionFlag(telefono);
  // Database-first: si no hay pedido activo real en DB, limpiamos cualquier flag/caché local.
  const { data: activeCheck } = await supabase
    .from("pedidos")
    .select("id")
    .in("telefono_cliente", phoneVariants)
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema,cancelado,completado,entregado)")
    .limit(1);
  if (!activeCheck?.length && flag) {
    sessionFlags.delete(normalizePhone(telefono));
  }
  if (flag?.pedido_en_proceso) {
    // saltamos la pregunta "continuar o nuevo" por un periodo corto
  } else {
  const { data: pending, error: pendingErr } = await supabase
    .from("pedidos")
    .select("id, estado")
    .in("telefono_cliente", phoneVariants)
    .not("estado", "in", "(cliente,bot,tienda,repartidor,sistema,cancelado,completado)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingErr) console.error("[mandalo] error consultando pedido pendiente:", pendingErr.message);

  if (pending?.id) {
    const pendingRow = pending as PedidoRow;
    const estadoPendiente = String(pendingRow.estado ?? "");
    console.log("[DEBUG] Estado actual del pedido:", Number(pendingRow.id), "Status:", estadoPendiente);

    if (isRedundantConfirmationMessage(mensaje) && isConfirmedCustomerState(estadoPendiente)) {
      const msg = "Tu pedido ya está confirmado, estamos trabajando en él. ✅";
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", accion: "confirmacion_ignorada", ordenId: Number(pendingRow.id) };
    }

    if (isOrderTrackingQuestion(mensaje)) {
      if (estadoPendiente === "en_proceso") {
        const msg = "Tu pedido está siendo preparado en la tienda, el repartidor está por asignarse. 🛍️";
        await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
        await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
        return { ok: true, role: "cliente", accion: "seguimiento_preparacion", ordenId: Number(pendingRow.id) };
      }

      if (estadoPendiente === "repartidor_asignado" || estadoPendiente === "asignado" || estadoPendiente === "en_camino") {
        const msg = "Tu pedido ya va con el repartidor. En cuanto haya una actualización, te aviso. 🛵";
        await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
        await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
        return { ok: true, role: "cliente", accion: "seguimiento_repartidor", ordenId: Number(pendingRow.id) };
      }
    }

    // Si el pedido ya fue notificado al repartidor, bloqueamos reenvíos.
    if (estadoPendiente === "en_proceso") {
      const msg =
        "📦 Tu pedido ya está en proceso con el repartidor.\n" +
        "En cuanto tenga una actualización, te aviso. ✅";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "en_proceso", ordenId: Number(pendingRow.id) };
    }

    if (isNewOrderIntent(mensaje)) {
      try {
        await transitionOrderState({
          orderId: Number(pendingRow.id),
          to: "cancelado",
        });
      } catch (e: unknown) {
        console.error("[mandalo] transición fallida a cancelado desde pedido pendiente", {
          orderId: Number(pendingRow.id),
          message: getErrorMessage(e),
        });
        const msg =
          "⚠️ No pude cancelar tu pedido anterior en este momento.\n" +
          "Inténtalo de nuevo en un momento, por favor. 🙏";
        console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
        await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
        await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
        return { ok: true, role: "cliente", accion: "cancelacion_fallida" };
      }
      const msg =
        "✅ Perfecto, cancelé tu pedido anterior.\n" +
        "Ahora sí: ¿qué se te antoja pedir hoy? 🛒";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", accion: "pedido_cancelado" };
    }

    const t = normalizeText(mensaje);
    const isExpected =
      isYesConfirmation(mensaje) || isContinueIntent(mensaje) || isCourierStatusUpdate(mensaje) || t.includes("precio") || t.includes("orden");

    if (!isExpected && !isContinueIntent(mensaje)) {
      const msg =
        "Tengo un pedido pendiente contigo. 🤝\n" +
        "¿Deseas continuar con tu pedido anterior o empezar uno nuevo?\n" +
        "Responde *continuar* o *nuevo*. ✅";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", accion: "pregunta_continuar_o_nuevo" };
    }
  }
  }

  // Paso 0 (Aceptación logística): después de la cotización final y el SÍ del cliente,
  // notificamos al repartidor activo. NO antes.
  const { data: awaitingTotal, error: awaitingTotalErr } = await supabase
    .from("pedidos")
    .select("id, estado, detalle_pedido, total")
    .in("telefono_cliente", phoneVariants)
    .eq("estado", "awaiting_confirm")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (awaitingTotalErr) {
    console.error("[mandalo] error consultando awaiting_confirm:", awaitingTotalErr.message);
  }
  if (awaitingTotal?.id) {
    // Guardamos mensaje entrante
    await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch(() => {});

    const awaitingRow = awaitingTotal as PedidoRow;
    let state: JsonObject = safeParseDetalleJson(awaitingRow?.detalle_pedido) ?? {};
    const ordenId = Number(awaitingTotal.id);

    if (String(state.final_confirmation_started_at ?? "").trim()) {
      const msg = "Procesando tu pedido, por favor espera un momento. ⏳";
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "awaiting_confirm", ordenId, accion: "final_confirmation_locked" };
    }

    if (!isYesConfirmation(mensaje)) {
      const msg = "Procesando tu pedido, por favor espera un momento. ⏳";
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "awaiting_confirm", ordenId: Number(awaitingTotal.id) };
    }

    // Lock atómico liviano para cortar reentradas mientras se procesa la confirmación final.
    state.final_confirmation_started_at = new Date().toISOString();
    await actualizarOrden(ordenId, { detalle_pedido: JSON.stringify(state) }).catch((e: unknown) => {
      console.error("[mandalo] no se pudo persistir final_confirmation_started_at", {
        orderId: ordenId,
        message: getErrorMessage(e),
      });
    });

    // Cliente confirmó total: notificar al repartidor activo
    // Sincronización: si items viene vacío, intentamos recuperar la última versión con items en DB.
    state = await ensureItemsNotEmpty({ telefono, currentState: state, orderIdToUpdate: Number(awaitingTotal.id) });
    console.log("[DEBUG] Estado actual del pedido:", ordenId, "Status:", String(awaitingRow?.estado ?? "awaiting_confirm"));
    const customerName = String(state?.customer_name ?? "").trim();
    const addressText = String(state?.address_text ?? "").trim();
    const pedidoDetalle = formatPedidoForBusiness(state);
    const total = Number(awaitingRow?.total ?? state?.total ?? 0) || undefined;
    const mapsLink = addressText
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`
      : "";

    // Debug necesario
    console.log("[DEBUG] Productos detectados antes de enviar a repartidor:", state?.items);

    // Validación estricta: si sigue vacío, NO pedimos reingreso (evita bucle); detenemos y registramos.
    const productosArr = Array.isArray(state?.items) ? state.items : [];
    if (!productosArr || productosArr.length === 0) {
      console.error("Error: Intento de enviar pedido vacío");
      const msg =
        "⚠️ Estoy teniendo un problema para recuperar tu lista de productos, y prefiero no enviar un pedido incompleto.\n" +
        "Dame un momento y te confirmo en breve. 🙏";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: false, role: "cliente", error: "PEDIDO_VACIO", ordenId };
    }

    const repartidor = await findActiveCourier();
    if (!repartidor) {
      // Aviso a tienda si no hay repartidores
      const negocio = await resolveBusinessForDispatch(state);
      if (negocio?.whatsapp) {
        const aviso = "Pedido enviado, pero no hay repartidores activos disponibles.";
        logBusinessDispatch({
          orderId: ordenId,
          businessId: negocio.id ?? state.business_id ?? state.businessId ?? null,
          businessName: negocio.nombre ?? state.business_name ?? state.businessName ?? null,
          businessPhone: negocio.whatsapp,
          to: negocio.whatsapp,
          body: aviso,
        });
        await waapiSendText({ to: negocio.whatsapp, body: normalizeWhatsAppText(aviso) });
      }
      const msg =
        "⚠️ Por ahora no tengo repartidores activos disponibles.\n" +
        "En cuanto haya uno libre, te aviso. 🙏";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "awaiting_confirm", ordenId };
    }

    const repartidorNombre = String(repartidor?.nombre ?? "").trim() || "Repartidor";
    const repartidorWhatsapp = ensureMxWhatsappIntl(String(repartidor?.whatsapp ?? ""));
    console.log("[DEBUG] Notificando a repartidor:", repartidorNombre, "Número:", repartidorWhatsapp);

    try {
      await transitionOrderState({
        orderId: ordenId,
        to: "pendiente_aceptacion_repartidor",
        snapshotPatch: {
          ...state,
          total: total ?? null,
          repartidor_nombre: repartidorNombre,
          courier_phone: repartidorWhatsapp,
        },
        contextOverrides: {
          customerPhone: telefono,
          addressText,
          mapsLink,
          items: productosArr,
          total: total ?? null,
          courierAvailable: true,
          courierPhone: repartidorWhatsapp,
        },
      });
      console.log("Cambio de estado:", "en_proceso");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida pendiente_aprobacion_total -> pendiente_aceptacion_repartidor", {
        orderId: ordenId,
        message: e instanceof Error ? e.message : String(e),
      });
      const msgSeguro =
        !addressText
          ? "No puedo mandar tu pedido aún porque falta tu dirección completa. 📍"
          : !productosArr.length
            ? "No puedo mandar tu pedido aún porque no puedo recuperar productos. 🛒"
            : "No puedo mandar tu pedido aún porque no tengo repartidores activos disponibles. 🛵";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgSeguro) });
      await guardarMensajeChat({ telefono, texto: msgSeguro, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "awaiting_confirm", ordenId };
    }

    const negocioNombre = String(state?.business_name ?? "").trim() || "la tienda";
    const msgRepartidor =
      `Hola ${repartidorNombre}, tienes un nuevo pedido de ${negocioNombre}. 📦\n\n` +
      `👤 Cliente: ${customerName || "(sin nombre)"}\n` +
      `📍 Dirección: ${addressText || "(sin dirección)"}\n` +
      `${total != null ? `💰 Total: $${total}\n` : ""}` +
      `📞 Tel cliente: ${telefono}\n` +
      `${mapsLink ? `🗺️ Mapa: ${mapsLink}\n` : ""}` +
      `\nProductos:\n${pedidoDetalle}\n\n` +
      "¿Aceptas el servicio? Responde SÍ para confirmar.\n" +
      `Para actualizar, responde: ORDEN #${ordenId} YA RECOGÍ / YA LLEGUÉ / ENTREGADO.`;

    logCourierDispatch({
      orderId: ordenId,
      courierName: repartidorNombre,
      courierPhone: repartidorWhatsapp,
      customerPhone: telefono,
      mapsLink,
      body: msgRepartidor,
    });
    await waapiSendText({ to: repartidorWhatsapp, body: normalizeWhatsAppText(msgRepartidor) });

    const etaText = formatEstimatedArrival(20);
    const msgCliente =
      `✅ Tu pedido ha sido confirmado.\n` +
      `Llegará aproximadamente a las ${etaText}.\n\n` +
      `Ya le pasé tu pedido a *${repartidorNombre}*.\n` +
      "En cuanto lo acepte, te aviso. 📦";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgCliente) });
    await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot" }).catch(() => {});

    return { ok: true, role: "cliente", stage: "awaiting_confirm", ordenId };
  }

  // Bloqueo de cambios mientras esperamos cotización/precio
  const { data: awaiting, error: awaitingErr } = await supabase
    .from("pedidos")
    .select("id, estado")
    .in("telefono_cliente", phoneVariants)
    .eq("estado", "awaiting_quote")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (awaitingErr) {
    console.error("[mandalo] error consultando awaiting_quote:", awaitingErr.message);
  }
  if (awaiting?.id) {
    const msg =
      "Estoy esperando el precio de la tienda para tu pedido ✨\n" +
      "En cuanto me lo confirmen, te aviso con el total. ✅";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "awaiting_quote", ordenId: Number(awaiting.id) };
  }

  // 0) Guardar el mensaje entrante ANTES de llamar a la IA (para evitar “amnesia”)
  await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch((e: unknown) => {
    console.error("[mandalo] guardarMensajeChat(cliente) falló", { message: getErrorMessage(e) });
  });

  // 1) Obtener historial real (mensajes previos)
  const historial = await fetchHistorialReciente(telefono, 12).catch((e: unknown): HistorialMessage[] => {
    console.error("[mandalo] fetchHistorialReciente falló", { message: getErrorMessage(e) });
    return [];
  });

  // Debug: confirmar si está llegando vacío
  console.log("[mandalo] historialReciente count:", Array.isArray(historial) ? historial.length : 0);

  // 1.5) Dirección guardada (desde pedidos.detalle_pedido) si existe
  const direccionGuardada = await fetchDireccionGuardadaDesdePedidos(telefono).catch((e: unknown) => {
    console.error("[mandalo] fetchDireccionGuardadaDesdePedidos falló", { message: getErrorMessage(e) });
    return null;
  });
  if (direccionGuardada) {
    console.log("[mandalo] dirección_guardada detectada:", direccionGuardada);
  }

  // 2. Llamar a la IA
  const currentOrderState = await getCurrentOrderStateForAgent(telefono);
  const respuesta = await getLLMResponse({
    historialReciente: (historial ?? [])
      .slice()
      .reverse() // importante: orden cronológico
      .map((m) => ({
        role: m.estado === "bot" ? ("assistant" as const) : ("user" as const),
        content: String(m.texto ?? ""),
      }))
      .filter((m) => m.content.trim()),
    supabaseJson: {
      maps_url: ubicacion ?? null,
      ...(direccionGuardada
        ? {
            direccion_conocida: direccionGuardada,
            direccion_conocida_texto: `Dirección conocida del cliente: ${direccionGuardada}`,
          }
        : {}),
    },
    currentOrderState,
    userMessage: mensaje,
  });

  console.log("[DEBUG] IA Stage:", respuesta.order_state?.stage);
  console.log("[DEBUG] IA Dispatch:", JSON.stringify(respuesta.dispatch));
  if (respuesta.dispatch?.business_message) {
    console.log("[DEBUG] ÉXITO: Dispatch detectado y entrando a rama de confirmación");
  } else {
    console.log("[DEBUG] FALLA: IA no generó dispatch.business_message");
  }

  // 3) Prioridad al Dispatch:
  // Si la IA manda dispatch.business_message, procesamos el flujo de cotización SIN depender
  // de que el texto del cliente o customer_reply contenga "COTIZAR.".
  const dispatch = respuesta.dispatch ?? null;
  if (dispatch?.business_message) {
    const safeOrderState = ensureSafeLlmOrderState(respuesta.order_state, "esperando_confirmacion");
    const baseState: JsonObject = { ...currentOrderState, ...safeOrderState };
    if (!isOrderReadyForConfirmation(baseState)) {
      const msg = buildMissingCriticalFieldsMessage(baseState);
      console.log("[mandalo] confirmación bloqueada por capa determinista", {
        missing: getMissingCriticalFields(baseState),
      });
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "collecting", missing: getMissingCriticalFields(baseState) };
    }

    // Resolver negocio SIEMPRE desde DB (fuente de verdad).
    const negocioDb = await resolveNegocioFromDb({
      id: baseState.business_id,
      nombre: baseState.business_name,
      whatsapp: dispatch?.to_business_phone,
    }).catch((e: unknown) => {
      console.error("[mandalo] resolveNegocioFromDb falló:", getErrorMessage(e));
      return null;
    });

    if (!negocioDb?.whatsapp) {
      console.error("[DEBUG] No se pudo resolver negocioDb.whatsapp", {
        business_id: baseState?.business_id,
        business_name: baseState?.business_name,
        dispatch_to_business_phone: dispatch?.to_business_phone,
      });
      // No tenemos a dónde enviarlo: pedir selección de tienda al cliente (según regla de oro).
      const msg =
        "¿De cuál negocio te lo pido? 🛒\n" +
        "Dime el nombre exacto de la tienda para mandarle tu pedido.";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "collecting" };
    }

    const tiendaNombre = String(negocioDb?.nombre ?? "la tienda").trim();
    const tiendaWhatsApp = ensureMxWhatsappIntl(String(negocioDb?.whatsapp ?? "").trim());

    // FRENO DE SEGURIDAD:
    // Guardamos el pedido y pedimos confirmación al cliente. NO enviamos a la tienda hasta recibir "SÍ".
    const addressText =
      String(baseState?.address_text ?? "").trim() ||
      String(direccionGuardada ?? "").trim() ||
      "";

    const orderState: JsonObject = {
      ...baseState,
      stage: "awaiting_confirmation",
      business_name: tiendaNombre,
      business_id: negocioDb?.id ?? baseState?.business_id,
      business_phone: tiendaWhatsApp,
      // Guardamos el mensaje tal cual (sin limpieza) para no perder intención/información.
      pending_business_message: String(dispatch.business_message ?? "").trim(),
      ...(addressText ? { address_text: addressText } : {}),
    };
    const ordenId = await crearOrden({
      telefonoCliente: telefono,
      resumenPedido: JSON.stringify(orderState),
      estado: "esperando_confirmacion",
    });
    console.log("Cambio de estado:", "esperando_confirmacion");

    const resumen = formatResumenParaCliente(orderState);
    const resumenParaCliente =
      `✅ Ya tengo tu pedido:\n${resumen}\n\n` +
      "¿Es correcto tu pedido? Responde *SÍ* para confirmar. ✅";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(resumenParaCliente) });
    await guardarMensajeChat({ telefono, texto: resumenParaCliente, estado: "bot" }).catch(() => {});

    return { ok: true, role: "cliente", stage: "esperando_confirmacion", ordenId };
  }

  // 4) Respuesta normal al cliente (sin “COTIZAR.” + sin JSON/código)
  const customerReplyClean = sanitizeCustomerReply(
    String(respuesta.customer_reply ?? "").replace(/COTIZAR\./g, ""),
  );
  console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
  await waapiSendText({ to: telefono, body: normalizeWhatsAppText(customerReplyClean) });
  await guardarMensajeChat({ telefono, texto: customerReplyClean, estado: "bot" }).catch((e: unknown) => {
    console.error("[mandalo] guardarMensajeChat(bot) falló", { message: getErrorMessage(e) });
  });
  return { ok: true, role: "cliente", respuesta: customerReplyClean };
}

async function handleTiendaMessage(telefono: string, mensaje: string) {
  void telefono;
  // Si viene precio, pasamos de awaiting_quote -> awaiting_confirm y avisamos al cliente
  const ordenId = extraerOrdenId(String(mensaje));
  const precio = extraerPrecio(String(mensaje));
  if (!ordenId || precio == null || Number.isNaN(precio)) {
    return { ok: true, role: "tienda" };
  }

  const subtotal = Number(precio);
  const total = calculateFinalPrice(subtotal);

  const supabase = getSupabaseAdmin();
  const { data: ord, error } = await supabase
    .from("pedidos")
    .select("telefono_cliente, detalle_pedido")
    .eq("id", ordenId)
    .maybeSingle();
  if (error) throw error;

  const ordRow = ord as PedidoRow | null;
  const telefonoCliente = String(ordRow?.telefono_cliente ?? "");
  const state: JsonObject = safeParseDetalleJson(ordRow?.detalle_pedido) ?? {};
  state.total = total;
  state.stage = "awaiting_confirm";

  try {
    await transitionOrderState({
      orderId: ordenId,
      to: "pendiente_aprobacion_total",
      snapshotPatch: {
        ...state,
        total,
        stage: "awaiting_confirm",
      },
      dbPatch: { total },
    });
    console.log("Cambio de estado:", "awaiting_confirm");
  } catch (e: unknown) {
    console.error("[mandalo] transición fallida pendiente_cotizacion_tienda -> pendiente_aprobacion_total", {
      orderId: ordenId,
      message: e instanceof Error ? e.message : String(e),
    });
    return { ok: true, role: "tienda", ordenId, error: "TRANSITION_TO_PENDING_APPROVAL_FAILED" };
  }

  if (telefonoCliente) {
    const tiendaNombre = String(state?.business_name ?? "la tienda");
    const msg =
      `Ya me contestó *${tiendaNombre}* ✅\n\n` +
      `Subtotal: $${subtotal}\n` +
      `Servicio Mándalo: $${MANDALO_SERVICE_FEE}\n` +
      `Envío: $${MANDALO_DELIVERY_FEE}\n` +
      `Total a pagar: $${total}\n\n` +
      `¿Confirmas tu pedido? (Responde SÍ)`;
    await waapiSendText({ to: telefonoCliente, body: normalizeWhatsAppText(msg) });
    await guardarMensajeChat({ telefono: telefonoCliente, texto: msg, estado: "bot", legacyPedidoId: ordenId }).catch(
      () => {},
    );
  }

  return { ok: true, role: "tienda", ordenId, total };
}

async function handleRepartidorMessage(telefono: string, mensaje: string, repartidorId: number) {
  const supabase = getSupabaseAdmin();
  void repartidorId;

  // Log del mensaje del repartidor en bitácora (pedidos)
  try {
    await supabase
      .from("pedidos")
      .insert({
        telefono_cliente: telefono,
        detalle_pedido: String(mensaje ?? ""),
        estado: "repartidor",
      });
  } catch {
    // no-op
  }

  const text = String(mensaje ?? "");
  const t = text.toLowerCase();

  // Ideal: ORDEN #id viene en el mensaje
  const ordenId = extraerOrdenId(text) ?? null;
  let pedidoId = ordenId ? Number(ordenId) : null;
  const hasExplicitOrderId = pedidoId != null;

  // Fallback legacy: si no vino ORDEN, intentamos resolver una orden reciente.
  // OJO: para mutaciones de estado ya no se usará si no hay referencia inequívoca.
  if (!pedidoId) {
    const { data, error } = await supabase
      .from("pedidos")
      .select("id, detalle_pedido, estado, created_at")
      .in("estado", ["repartidor_asignado", "en_camino", "llegado", "awaiting_confirm", "awaiting_quote"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const latestRow = (data ?? [])[0] as PedidoRow | undefined;
    pedidoId = latestRow?.id ? Number(latestRow.id) : null;
  }

  if (!pedidoId) {
    console.error("[mandalo] repartidor: no se pudo determinar pedidoId");
    return { ok: false, role: "repartidor", error: "NO_ORDER_FOUND" };
  }

  const { data: ord, error: ordErr } = await supabase
    .from("pedidos")
    .select("telefono_cliente, detalle_pedido")
    .eq("id", pedidoId)
    .maybeSingle();
  if (ordErr) throw ordErr;

  const ordRow = ord as PedidoRow | null;
  const telefonoCliente = String(ordRow?.telefono_cliente ?? "").trim();
  const state: JsonObject = safeParseDetalleJson(ordRow?.detalle_pedido) ?? {};

  const courier = await findCourierByPhone(telefono);
  const repartidorNombre = String(courier?.nombre ?? "").trim() || "Repartidor";

  if ((isYesConfirmation(text) || t.includes("ya recog") || t.includes("ya lleg") || t.includes("entregado")) && !hasExplicitOrderId) {
    const msg = "⚠️ Para actualizar el pedido, por favor responde con el formato: ORDEN #id + tu mensaje.";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
    return { ok: true, role: "repartidor", accion: "order_id_requerido" };
  }

  if ((isYesConfirmation(text) || t.includes("ya recog") || t.includes("ya lleg") || t.includes("entregado")) && !courier) {
    const msg = "⚠️ No pude validar tu número como repartidor activo. Usa tu número registrado o contacta al administrador.";
    console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
    await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
    return { ok: true, role: "repartidor", accion: "repartidor_no_validado" };
  }

  // Paso 0: Aceptación del servicio (SÍ)
  if (isYesConfirmation(text)) {
    state.repartidor_nombre = repartidorNombre;
    state.repartidor_whatsapp = ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono));
    try {
      await transitionOrderState({
        orderId: pedidoId,
        to: "repartidor_confirmado",
        snapshotPatch: {
          ...state,
          repartidor_nombre: repartidorNombre,
          courier_phone: String(state.repartidor_whatsapp ?? ""),
        },
        contextOverrides: {
          courierPhone: telefono,
          courier: { name: repartidorNombre, phone: String(state.repartidor_whatsapp ?? "") },
        },
      });
      console.log("Cambio de estado:", "repartidor_asignado");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida pendiente_aceptacion_repartidor -> repartidor_confirmado", {
        orderId: pedidoId,
        message: e instanceof Error ? e.message : String(e),
      });
      const ordenRef = ordenId ? `ORDEN #${ordenId}` : "ORDEN #id";
      const msgRepartidor = `⚠️ No pude confirmar tu aceptación. Por favor responde ${ordenRef} SÍ.`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msgRepartidor) });
      return { ok: true, role: "repartidor", accion: "aceptacion_no_confirmada", ordenId: pedidoId };
    }

    if (telefonoCliente) {
      const msgCliente =
        `✅ ¡Excelente! *${repartidorNombre}* aceptó tu pedido.\n` +
        "En cuanto lo recoja, te aviso. 📦";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefonoCliente, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }

    const negocio = await resolveBusinessForDispatch(state);
    if (negocio?.whatsapp) {
      const msgTienda = `El pedido ha sido tomado por el repartidor ${repartidorNombre}`;
      logBusinessDispatch({
        orderId: pedidoId,
        businessId: negocio.id ?? state.business_id ?? state.businessId ?? null,
        businessName: negocio.nombre ?? state.business_name ?? state.businessName ?? null,
        businessPhone: negocio.whatsapp,
        to: negocio.whatsapp,
        body: msgTienda,
      });
      await waapiSendText({ to: negocio.whatsapp, body: normalizeWhatsAppText(msgTienda) });
    }

    return { ok: true, role: "repartidor", accion: "aceptado", ordenId: pedidoId, repartidorNombre };
  }

  // Paso 1: Recogida
  if (t.includes("ya recog")) {
    try {
      await transitionOrderState({
        orderId: pedidoId,
        to: "pedido_recogido",
        snapshotPatch: {
          ...state,
          repartidor_nombre: repartidorNombre,
          courier_phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
        },
        contextOverrides: {
          courierPhone: telefono,
          courier: {
            name: repartidorNombre,
            phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
          },
        },
      });
      console.log("Cambio de estado:", "en_camino");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida repartidor_confirmado -> pedido_recogido", {
        orderId: pedidoId,
        message: e instanceof Error ? e.message : String(e),
      });
      const msg = `⚠️ No pude marcar la recogida del pedido ORDEN #${pedidoId}. Reintenta con: ORDEN #${pedidoId} YA RECOGÍ.`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      return { ok: true, role: "repartidor", accion: "recogida_no_confirmada", ordenId: pedidoId };
    }
    if (telefonoCliente) {
      const msgCliente = `📦 ¡${repartidorNombre} ya tiene tu pedido y está en camino!`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefonoCliente, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }
    return { ok: true, role: "repartidor", accion: "en_camino", ordenId: pedidoId };
  }

  // Paso 2: Llegada
  if (t.includes("ya lleg")) {
    try {
      await transitionOrderState({
        orderId: pedidoId,
        to: "repartidor_en_destino",
        snapshotPatch: {
          ...state,
          repartidor_nombre: repartidorNombre,
          courier_phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
        },
        contextOverrides: {
          courierPhone: telefono,
          courier: {
            name: repartidorNombre,
            phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
          },
        },
      });
      console.log("Cambio de estado:", "llegado");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida pedido_recogido -> repartidor_en_destino", {
        orderId: pedidoId,
        message: e instanceof Error ? e.message : String(e),
      });
      const msg = `⚠️ No pude marcar la llegada del pedido ORDEN #${pedidoId}. Reintenta con: ORDEN #${pedidoId} YA LLEGUÉ.`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      return { ok: true, role: "repartidor", accion: "llegada_no_confirmada", ordenId: pedidoId };
    }
    if (telefonoCliente) {
      const msgCliente = `🔔 ¡${repartidorNombre} está afuera de tu domicilio!`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefonoCliente, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }
    return { ok: true, role: "repartidor", accion: "llegado", ordenId: pedidoId };
  }

  // Paso 3: Entrega
  if (t.includes("entregado")) {
    try {
      await transitionOrderState({
        orderId: pedidoId,
        to: "entregado",
        snapshotPatch: {
          ...state,
          repartidor_nombre: repartidorNombre,
          courier_phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
        },
        contextOverrides: {
          courierPhone: telefono,
          courier: {
            name: repartidorNombre,
            phone: String(state.repartidor_whatsapp ?? ensureMxWhatsappIntl(String(courier?.whatsapp ?? telefono))),
          },
        },
      });
      console.log("Cambio de estado:", "completado");
    } catch (e: unknown) {
      console.error("[mandalo] transición fallida repartidor_en_destino -> entregado", {
        orderId: pedidoId,
        message: e instanceof Error ? e.message : String(e),
      });
      const msg = `⚠️ No pude marcar la entrega del pedido ORDEN #${pedidoId}. Reintenta con: ORDEN #${pedidoId} ENTREGADO.`;
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefono, body: normalizeWhatsAppText(msg) });
      return { ok: true, role: "repartidor", accion: "entrega_no_confirmada", ordenId: pedidoId };
    }
    if (telefonoCliente) {
      const msgCliente = "✅ Pedido entregado. ¡Gracias por usar Mándalo! 🙌";
      console.log("--- INTENTANDO ENVIAR A ULTRA MSG ---");
      await waapiSendText({ to: telefonoCliente, body: normalizeWhatsAppText(msgCliente) });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }
    return { ok: true, role: "repartidor", accion: "completado", ordenId: pedidoId };
  }

  return { ok: true, role: "repartidor", accion: "ignorado" };
}

export async function processMandaloWebhook(incoming: IncomingWhatsAppMessage) {
  // Backdoor admin: RESET_BOT <NUMERO_TELEFONO>
  const bodyTextRaw = String(incoming.body ?? "");
  if (isAdminSender(incoming.from)) {
    const m = bodyTextRaw.match(/^\s*RESET_BOT\s+([0-9+\-\s]{8,})\s*$/i);
    if (m?.[1]) {
      const target = normalizePhone(m[1]);
      await limpiarSesion(target);
      const msg = `✅ RESET aplicado. Número desbloqueado: ${target}`;
      await waapiSendText({ to: normalizePhone(incoming.from), body: normalizeWhatsAppText(msg) });
      await guardarMensajeChat({ telefono: normalizePhone(incoming.from), texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "admin", accion: "reset_bot", target };
    }
  }

  // Lógica de detección de actor y ruteo principal
  const actor = await detectActorByPhone(incoming.from);

  // Fallback controlado: si llega ORDEN + PRECIO, lo tratamos como respuesta de tienda
  // solo si el remitente corresponde a un negocio registrado.
  const bodyText = bodyTextRaw;
  const explicitOrderId = extraerOrdenId(bodyText);
  const looksLikeTiendaPrecio = /\borden\b/i.test(bodyText) && /\bprecio\b/i.test(bodyText);
  if (actor.role === "tienda") {
    const activeBusinessOrder = await findActiveOrderForAssignedPhone({
      role: "tienda",
      senderPhone: actor.telefono,
      preferredOrderId: explicitOrderId,
    });
    if (!activeBusinessOrder) {
      console.warn("[mandalo] excepción: mensaje de tienda no corresponde a orden activa", {
        from: actor.telefono,
        explicitOrderId,
      });
      return { ok: true, role: "tienda", accion: "orden_activa_no_corresponde", orderId: explicitOrderId ?? null };
    }
    return await handleTiendaMessage(actor.telefono, incoming.body);
  }
  if (looksLikeTiendaPrecio) {
    const okNegocio = await isNegocioSenderPhone(incoming.from);
    if (okNegocio) {
      const activeBusinessOrder = await findActiveOrderForAssignedPhone({
        role: "tienda",
        senderPhone: normalizePhone(String(incoming.from)),
        preferredOrderId: explicitOrderId,
      });
      if (activeBusinessOrder) return await handleTiendaMessage(normalizePhone(String(incoming.from)), bodyText);
      console.warn("[mandalo] excepción: fallback ORDEN+PRECIO sin orden activa válida para tienda", {
        from: incoming.from,
        explicitOrderId,
      });
      return { ok: true, role: "tienda", accion: "orden_activa_no_corresponde", orderId: explicitOrderId ?? null };
    }
    console.error("[mandalo] ORDEN+PRECIO recibido desde número no validado como negocio; ignorando fallback", {
      from: incoming.from,
    });
  }
  if (actor.role === "repartidor") {
    const activeCourierOrder = await findActiveOrderForAssignedPhone({
      role: "repartidor",
      senderPhone: actor.telefono,
      preferredOrderId: explicitOrderId,
    });
    if (!activeCourierOrder) {
      console.warn("[mandalo] excepción: mensaje de repartidor no corresponde a orden activa", {
        from: actor.telefono,
        explicitOrderId,
      });
      return { ok: true, role: "repartidor", accion: "orden_activa_no_corresponde", orderId: explicitOrderId ?? null };
    }
    return await handleRepartidorMessage(actor.telefono, incoming.body, actor.repartidorId);
  }

  // Fallback: si detectActorByPhone no reconoce al repartidor (porque no está en su tabla),
  // intentamos matchear con la tabla canónica "repartidores".
  const courier = await findCourierByPhone(incoming.from);
  if (courier) {
    const activeCourierOrder = await findActiveOrderForAssignedPhone({
      role: "repartidor",
      senderPhone: normalizePhone(String(incoming.from)),
      preferredOrderId: explicitOrderId,
    });
    if (!activeCourierOrder) {
      console.warn("[mandalo] excepción: fallback repartidor sin orden activa válida", {
        from: incoming.from,
        explicitOrderId,
      });
      return { ok: true, role: "repartidor", accion: "orden_activa_no_corresponde", orderId: explicitOrderId ?? null };
    }
    return await handleRepartidorMessage(normalizePhone(String(incoming.from)), incoming.body, 0);
  }

  return await handleClienteMessage(actor.telefono, incoming.body, incoming.location);
}

// --- FIN DEL ARCHIVO ---
