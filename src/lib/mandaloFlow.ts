import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getChatCompletion, getOpenAIModel } from "@/lib/openaiClient";
import { buildMandaloSystemPrompt } from "@/lib/mandaloPrompt";
import { normalizeWhatsAppText, waapiSendText } from "@/lib/waapi";
import { detectActorByPhone, normalizePhone } from "@/lib/roles";
import { getEnv } from "@/lib/env";
import { createCaptureEngine } from "@/lib/services/captureEngine";
import * as pedidoRepositoryV2 from "@/lib/repositories/pedidoRepositoryV2";
import * as validationEngine from "@/lib/services/validationEngine";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { createCourierCommandParser } from "@/lib/services/courierCommandParser";
import { calculateFinalPrice, extraerOrdenId, extraerPrecio } from "@/lib/ordenes";
import { isTerminalState, type OrderState } from "@/lib/orderStateMachine";
import {
  extractCoordsFromUbicacion,
  isWithinCoverageArea,
  buildAddressTextFromCoords,
  buildMapsLinkFromCoords,
  resolveMapsLink,
  type Coordinates,
} from "@/lib/services/geo";
import { MandaloAgentResponse, mandaloAgentResponseSchema } from "@/lib/llmResponseSchema";
import {
  fetchRecentChatHistory as fetchHistorialReciente,
  isConversationModeMessage,
  isNewOrderIntent,
  isYesConfirmation,
  normalizeMessageIntentText as normalizeText,
  parseIncomingWhatsAppMessage,
  saveChatMessage as guardarMensajeChat,
  sanitizeCustomerReply,
  type IncomingWhatsAppMessage,
} from "@/lib/messages";
import type { PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import type { PedidoV2Record } from "@/lib/services/captureEngine";

type JsonObject = Record<string, unknown>;
type TiendaRow = { id?: unknown; nombre?: unknown; categoria?: unknown; telefono?: unknown };
type CourierRow = { id?: unknown; nombre?: unknown; telefono?: unknown; activo?: unknown; vehiculo?: unknown };
type HistorialMessage = { texto: string; estado: "cliente" | "bot"; created_at: string };
type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isAdminSender(phone: string): boolean {
  const env = getEnv();
  const admin = normalizePhone(String(env.MANDALO_ADMIN_PHONE ?? ""));
  if (!admin) return false;
  const sender = normalizePhone(String(phone ?? ""));
  if (!sender) return false;
  return sender === admin || sender.slice(-10) === admin.slice(-10);
}

function ensureMxWhatsappIntl(raw: string) {
  const d = normalizePhone(String(raw ?? ""));
  // WhatsApp México suele usar 52 + 10 dígitos (a veces 521 + 10)
  if (d.length === 10) return `52${d}`;
  if (d.length === 12 && d.startsWith("52")) return d;
  if (d.length === 13 && d.startsWith("521")) return d;
  return d;
}

function formatEstimatedArrival(minutesToAdd = 20): string {
  const eta = new Date(Date.now() + minutesToAdd * 60 * 1000);
  return eta.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", hour12: true });
}

function buildSaludoInicial(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Mexico_City" }).format(
      new Date(),
    ),
  );
  const franja = hour >= 6 && hour < 12 ? "¡Buenos días!" : hour >= 12 && hour < 19 ? "¡Buenas tardes!" : "¡Buenas noches!";
  return `${franja} Bienvenido a Mándalo. ¿Qué se te antoja hoy? ¿Buscas algo de la tienda o tienes antojo de comida preparada?`;
}

function ensureSafeLlmOrderState(value: unknown, fallbackStage = "collecting"): MandaloAgentResponse["order_state"] {
  const base = asJsonObject(value);
  const stage = String(base.stage ?? "").trim() || fallbackStage;
  const items = Array.isArray(base.items) ? base.items : [];
  return {
    ...(base as Record<string, unknown>),
    stage,
    items: items as MandaloAgentResponse["order_state"]["items"],
  };
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

function formatItemsForMessage(items: Array<{ nombreProducto: string; cantidad: number | null }>): string {
  if (!items.length) return "(sin productos)";
  return items.map((it) => `- ${it.nombreProducto}${it.cantidad != null ? ` x${it.cantidad}` : ""}`).join("\n");
}

const MANDALO_SERVICE_FEE = 20;
const MANDALO_DELIVERY_FEE = 35;

// Flags ligeros en memoria: solo se usan para no re-preguntar "¿continuar o
// nuevo?" en la misma ráfaga de mensajes justo después de un hard reset.
const sessionFlags = new Map<string, { pedido_en_proceso: boolean; at: number }>();
const SESSION_FLAG_TTL_MS = 10 * 60 * 1000;

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
  sessionFlags.set(normalizePhone(phone), { ...flag, at: Date.now() });
}

export { parseIncomingWhatsAppMessage };
export type { IncomingWhatsAppMessage };

const captureEngine = createCaptureEngine({
  pedidoRepository: pedidoRepositoryV2,
  validationEngine,
});
const courierCommandParser = createCourierCommandParser();

// Cache best-effort para validar remitentes de tienda/repartidor por si
// detectActorByPhone no los reconoce todavía (ventana de caché de 60s).
const tiendaPhoneCache = new Map<string, { isTienda: boolean; at: number }>();
const PHONE_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getLLMResponse(params: {
  historialReciente: Array<{ role: "user" | "assistant"; content: string }>;
  supabaseJson: JsonObject;
  currentOrderState: JsonObject;
  userMessage: string;
}): Promise<MandaloAgentResponse> {
  const supabase = getSupabaseAdmin();
  let tiendas: TiendaRow[] = [];
  try {
    const { data, error } = await supabase.from("tiendas").select("id, nombre, categoria, telefono").limit(500);
    if (error) throw error;
    tiendas = (data ?? []).filter(
      (n) => String((n as TiendaRow)?.nombre ?? "").trim() && String((n as TiendaRow)?.telefono ?? "").trim(),
    );
  } catch (e: unknown) {
    console.error("[mandalo] getLLMResponse: error consultando tiendas", { message: getErrorMessage(e) });
  }

  const tiendas_text = tiendas.length
    ? tiendas
        .map((n) => `- ${String(n.nombre ?? "")}${n.categoria ? ` (${String(n.categoria)})` : ""} [${String(n.telefono ?? "")}]`)
        .join("\n")
    : "(sin tiendas disponibles)";

  const model = getOpenAIModel();
  const system = buildMandaloSystemPrompt({
    negociosDisponibles: tiendas_text,
    repartidoresActivos: String(params.supabaseJson?.repartidores_text ?? "(sin repartidores)"),
    historial: String(params.supabaseJson?.historial_text ?? ""),
    saludoInicial: buildSaludoInicial(),
  });

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    {
      role: "system",
      content: `CONTEXTO ADICIONAL:\n${JSON.stringify(
        { ...params.supabaseJson, tiendas, order_state: params.currentOrderState },
        null,
        2,
      )}`,
    },
    ...params.historialReciente,
    { role: "user", content: params.userMessage },
  ];

  const text = await getChatCompletion({ model, messages, max_tokens: 600, temperature: 0 });

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
        return { ...parsed.data, order_state: ensureSafeLlmOrderState(parsed.data.order_state, "collecting") };
      }
      console.error("Error de validación en IA:", parsed.error);
      console.error("Error de validación en IA (flatten):", parsed.error.flatten());
    } catch (e) {
      console.error("Error al parsear IA (tolerado):", e);
    }
  }

  const plain = trimmed.replace(/\{[\s\S]*\}/, "").trim();
  return {
    customer_reply: plain || trimmed || "¡Entendido! Dame un momento.",
    order_state: { stage: "collecting", items: [] },
  };
}

// --- Resolución de tiendas / repartidores ---

async function resolveTiendaStrictByName(nombre: string) {
  const supabase = getSupabaseAdmin();
  const name = String(nombre ?? "").trim();
  if (!name) return null;

  const exact = await supabase.from("tiendas").select("id, nombre, telefono").eq("nombre", name).limit(1);
  if (!exact.error && exact.data?.[0]?.telefono) {
    return { id: Number(exact.data[0].id), nombre: String(exact.data[0].nombre ?? name), telefono: ensureMxWhatsappIntl(String(exact.data[0].telefono)) };
  }

  const like = await supabase.from("tiendas").select("id, nombre, telefono").ilike("nombre", `%${name}%`).limit(1);
  if (!like.error && like.data?.[0]?.telefono) {
    return { id: Number(like.data[0].id), nombre: String(like.data[0].nombre ?? name), telefono: ensureMxWhatsappIntl(String(like.data[0].telefono)) };
  }

  return null;
}

async function isTiendaSenderPhone(rawPhone: string): Promise<boolean> {
  const phoneNorm = normalizePhone(String(rawPhone ?? ""));
  const key = phoneNorm.length > 10 ? phoneNorm.slice(-10) : phoneNorm;
  const cached = tiendaPhoneCache.get(key);
  if (cached && Date.now() - cached.at < PHONE_CACHE_TTL_MS) return cached.isTienda;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("tiendas").select("telefono").limit(1000);
  if (error) {
    console.error("[mandalo] isTiendaSenderPhone: error consultando tiendas", { message: error.message });
    tiendaPhoneCache.set(key, { isTienda: false, at: Date.now() });
    return false;
  }
  const hit = (data ?? []).some((n: { telefono?: unknown }) => {
    const w = normalizePhone(String(n?.telefono ?? ""));
    const w10 = w.length > 10 ? w.slice(-10) : w;
    return w === phoneNorm || (w10 && key && w10 === key);
  });
  tiendaPhoneCache.set(key, { isTienda: hit, at: Date.now() });
  return hit;
}

async function findActiveCourier(): Promise<CourierRow | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from("repartidores")
      .select("id, nombre, telefono, activo, disponible, vehiculo")
      .eq("activo", true)
      .eq("disponible", true)
      .order("id", { ascending: true })
      .limit(1);
    if (error) {
      console.error("[mandalo] error consultando repartidores:", { message: error.message });
      return null;
    }
    const row = (data ?? [])[0] as CourierRow | undefined;
    if (row?.telefono) return row;
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando repartidores:", { message: getErrorMessage(e) });
  }
  return null;
}

async function findCourierByPhone(phone: string): Promise<CourierRow | null> {
  const supabase = getSupabaseAdmin();
  const phoneNorm = normalizePhone(String(phone ?? ""));
  const phone10 = phoneNorm.length <= 10 ? phoneNorm : phoneNorm.slice(-10);
  try {
    const { data, error } = await supabase.from("repartidores").select("id, nombre, telefono, activo, vehiculo").limit(500);
    if (error) {
      console.error("[mandalo] error consultando repartidores:", { message: error.message });
      return null;
    }
    const hit = (data ?? []).find((r) => {
      const row = r as CourierRow;
      const w = normalizePhone(String(row?.telefono ?? ""));
      const w10 = w.length <= 10 ? w : w.slice(-10);
      return w === phoneNorm || (w10 && phone10 && w10 === phone10);
    });
    if (hit) return hit as CourierRow;
  } catch (e: unknown) {
    console.error("[mandalo] excepción consultando repartidores:", { message: getErrorMessage(e) });
  }
  return null;
}

function logBusinessDispatch(params: { orderId: number; tiendaId?: unknown; tiendaNombre?: unknown; tiendaTelefono?: unknown; to: string; body: string }) {
  console.log("[dispatch][tienda]", {
    orderId: params.orderId,
    tienda_id: params.tiendaId ?? null,
    tienda_nombre: String(params.tiendaNombre ?? "").trim() || null,
    tienda_telefono: String(params.tiendaTelefono ?? "").trim() || null,
    to: params.to,
    bodyPreview: String(params.body ?? "").slice(0, 300),
  });
}

function logCourierDispatch(params: { orderId: number; courierName?: unknown; courierPhone?: unknown; customerPhone?: unknown; mapsLink?: unknown; body: string }) {
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
  const open = await pedidoRepositoryV2.getOpenPedidoByCustomerPhone(telefono).catch(() => null);
  if (open?.snapshot_json && Object.keys(open.snapshot_json).length > 0) return open.snapshot_json as JsonObject;
  return {};
}

async function sendWhatsApp(to: string, body: string): Promise<void> {
  await waapiSendText({ to, body: normalizeWhatsAppText(body) });
}

// --- Cliente ---

async function cancelOpenPedido(pedido: PedidoV2Record, reason: string): Promise<void> {
  await pedidoRepositoryV2.setPedidoEstado({ pedidoId: pedido.id, estado: "cancelado" });
  await pedidoRepositoryV2.appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "cancelado",
    estadoOrigen: pedido.estado,
    estadoDestino: "cancelado",
    actorTipo: "cliente",
    payload: { reason },
  });
}

function buildResumenPedido(pedido: PedidoV2Record): string {
  const snapshot = pedido.snapshot_json;
  const tienda = String(snapshot.businessName ?? "").trim() || "(sin tienda)";
  const direccion = String(snapshot.addressText ?? "").trim() || "(sin dirección)";
  return `Tienda: ${tienda}\n\n🏠 Entrega:\n${direccion}`;
}

async function handleEsperandoConfirmacionInicial(
  telefono: string,
  mensaje: string,
  pedido: PedidoV2Record,
  ubicacionCoords: Coordinates | null,
): Promise<JsonObject> {
  let snapshot = pedido.snapshot_json;

  // Si el cliente comparte (o vuelve a compartir) su ubicación GPS mientras
  // esperamos confirmación, la usamos como dirección exacta de inmediato.
  if (ubicacionCoords) {
    const addressText = buildAddressTextFromCoords(ubicacionCoords);
    snapshot = { ...snapshot, addressText, latitud: ubicacionCoords.latitude, longitud: ubicacionCoords.longitude };
    await pedidoRepositoryV2.updatePedidoSnapshot({
      pedidoId: pedido.id,
      estado: pedido.estado,
      snapshot,
      addressText,
      latitud: ubicacionCoords.latitude,
      longitud: ubicacionCoords.longitude,
    });
  }

  if (!isYesConfirmation(mensaje)) {
    const msg = `✅ Ya tengo tu pedido:\n${buildResumenPedido({ ...pedido, snapshot_json: snapshot })}\n\n¿Es correcto tu pedido? Responde *SÍ* para confirmar. ✅`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
  }

  const full = await pedidoRepositoryV2.getPedidoById(pedido.id);
  if (!full?.tienda?.telefono) {
    console.error("[ERROR CRÍTICO] No se encontró el teléfono de la tienda.", { pedidoId: pedido.id, tienda: full?.tienda ?? null });
    const msg = "⚠️ No pude identificar la tienda para tu pedido.\nDime de qué negocio quieres pedir y lo reintentamos. 🛒";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
  }

  const tiendaTelefono = ensureMxWhatsappIntl(full.tienda.telefono);
  const encabezado =
    `COTIZAR. ORDEN #${full.id}\n` +
    `${full.direccionEntrega ? `Dirección: ${full.direccionEntrega}\n` : ""}` +
    `Pedido:\n${formatItemsForMessage(full.items)}\n\n` +
    `Responde así: ORDEN #${full.id} PRECIO 150`;

  logBusinessDispatch({
    orderId: full.id,
    tiendaId: full.tienda.tiendaId,
    tiendaNombre: full.tienda.nombre,
    tiendaTelefono,
    to: tiendaTelefono,
    body: encabezado,
  });

  try {
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: full.id,
      tipoMensaje: "cotizacion_tienda",
      destinatarioTipo: "negocio",
      destinatarioId: full.tienda.tiendaId,
      telefonoDestino: tiendaTelefono,
      payload: { body: encabezado },
      idempotencyKey: `pedido:${full.id}:cotizacion_tienda:v1`,
    });

    await pedidoRepositoryV2.setPedidoEstado({ pedidoId: full.id, estado: "pendiente_tiendas" });
    await pedidoRepositoryV2.appendPedidoEvento({
      pedidoId: full.id,
      tipoEvento: "dispatch_tienda",
      estadoOrigen: "confirmacion_cliente",
      estadoDestino: "pendiente_tiendas",
      actorTipo: "cliente",
    });
  } catch (e: unknown) {
    console.error("[mandalo] no se pudo encolar o transicionar dispatch a tienda", { pedidoId: full.id, message: getErrorMessage(e) });
    const msg = "⚠️ Hubo un problema al registrar tu pedido para enviarlo a la tienda.\n\nInténtalo de nuevo respondiendo *SÍ*. Si vuelve a fallar, avísame.";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
  }

  const msgCliente = `📩 Tu pedido quedó registrado para envío a *${full.tienda.nombre}*.\n\nTe avisaré en cuanto la tienda confirme el precio.`;
  await sendWhatsApp(telefono, msgCliente);
  await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot" }).catch(() => {});
  return { ok: true, role: "cliente", stage: "pendiente_tiendas", pedidoId: full.id };
}

async function handleConfirmadoTiendas(telefono: string, mensaje: string, pedido: PedidoFullRecord): Promise<JsonObject> {
  if (!isYesConfirmation(mensaje)) {
    const msg = "Procesando tu pedido, por favor espera un momento. ⏳";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmado_tiendas", pedidoId: pedido.id };
  }

  if (!pedido.items.length) {
    console.error("Error: Intento de enviar pedido vacío", { pedidoId: pedido.id });
    const msg = "⚠️ Estoy teniendo un problema para recuperar tu lista de productos, y prefiero no enviar un pedido incompleto.\nDame un momento y te confirmo en breve. 🙏";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: false, role: "cliente", error: "PEDIDO_VACIO", pedidoId: pedido.id };
  }

  const repartidor = await findActiveCourier();
  if (!repartidor) {
    if (pedido.tienda?.telefono) {
      const aviso = "Pedido confirmado por el cliente, pero no hay repartidores activos disponibles.";
      const tiendaTelefono = ensureMxWhatsappIntl(pedido.tienda.telefono);
      logBusinessDispatch({ orderId: pedido.id, tiendaId: pedido.tienda.tiendaId, tiendaNombre: pedido.tienda.nombre, tiendaTelefono, to: tiendaTelefono, body: aviso });
      await outboxRepository.enqueueOutboundMessage({
        pedidoId: pedido.id,
        tipoMensaje: "cotizacion_tienda",
        destinatarioTipo: "negocio",
        destinatarioId: pedido.tienda.tiendaId,
        telefonoDestino: tiendaTelefono,
        payload: { body: aviso },
        idempotencyKey: `pedido:${pedido.id}:store_notice_no_courier:v1`,
      });
    }
    const msg = "⚠️ Por ahora no tengo repartidores activos disponibles.\nEn cuanto haya uno libre, te aviso. 🙏";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmado_tiendas", pedidoId: pedido.id };
  }

  const repartidorNombre = String(repartidor?.nombre ?? "").trim() || "Repartidor";
  const repartidorTelefono = ensureMxWhatsappIntl(String(repartidor?.telefono ?? ""));
  const mapsLink = resolveMapsLink({ latitud: pedido.latitud, longitud: pedido.longitud, addressText: pedido.direccionEntrega });

  const msgRepartidor =
    `Hola ${repartidorNombre}, tienes un nuevo pedido de ${pedido.tienda?.nombre ?? "la tienda"}. 📦\n\n` +
    `📍 Dirección: ${pedido.direccionEntrega || "(sin dirección)"}\n` +
    `${pedido.totalCliente != null ? `💰 Total: $${pedido.totalCliente}\n` : ""}` +
    `📞 Tel cliente: ${telefono}\n` +
    `${mapsLink ? `🗺️ Mapa: ${mapsLink}\n` : ""}` +
    `\nProductos:\n${formatItemsForMessage(pedido.items)}\n\n` +
    `Responde con: #CONFIRMO ${pedido.id}\n` +
    `Luego: #RECOGI ${pedido.id} y #ENTREGADO ${pedido.id}`;

  logCourierDispatch({ orderId: pedido.id, courierName: repartidorNombre, courierPhone: repartidorTelefono, customerPhone: telefono, mapsLink, body: msgRepartidor });

  try {
    await pedidoRepositoryV2.setPedidoEstado({ pedidoId: pedido.id, estado: "dispatch_repartidor_pendiente" });
    await pedidoRepositoryV2.appendPedidoEvento({
      pedidoId: pedido.id,
      tipoEvento: "dispatch_repartidor",
      estadoOrigen: "confirmado_tiendas",
      estadoDestino: "dispatch_repartidor_pendiente",
      actorTipo: "cliente",
    });

    await outboxRepository.enqueueOutboundMessage({
      pedidoId: pedido.id,
      tipoMensaje: "dispatch_repartidor",
      destinatarioTipo: "repartidor",
      destinatarioId: typeof repartidor?.id === "number" ? repartidor.id : null,
      telefonoDestino: repartidorTelefono,
      payload: { body: msgRepartidor, courierId: repartidor?.id ?? null, courierName: repartidorNombre, courierPhone: repartidorTelefono, attemptNumber: 1 },
      idempotencyKey: `pedido:${pedido.id}:dispatch_repartidor:attempt:1`,
    });
  } catch (e: unknown) {
    console.error("[mandalo] no se pudo encolar o transicionar dispatch a repartidor", { pedidoId: pedido.id, message: getErrorMessage(e) });
    const msg = "No pude registrar tu pedido para enviarlo al repartidor. Inténtalo de nuevo en un momento. 🛵";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmado_tiendas", pedidoId: pedido.id };
  }

  const etaText = formatEstimatedArrival(20);
  const msgCliente = `✅ Tu pedido ha sido confirmado.\nLlegará aproximadamente a las ${etaText}.\n\nEstamos coordinando tu entrega con *${repartidorNombre}*.\nTe avisaré en cuanto confirme. 📦`;
  await sendWhatsApp(telefono, msgCliente);
  await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot" }).catch(() => {});
  return { ok: true, role: "cliente", stage: "dispatch_repartidor_pendiente", pedidoId: pedido.id };
}

const TRACKING_MESSAGES: Partial<Record<OrderState, string>> = {
  pendiente_tiendas: "Estoy esperando el precio de la tienda para tu pedido ✨\nEn cuanto me lo confirmen, te aviso con el total. ✅",
  dispatch_repartidor_pendiente: "Tu pedido está confirmado, buscando repartidor. 🛍️",
  repartidor_asignado: "Tu pedido ya va con el repartidor, en camino a recogerlo. 🛵",
  recogiendo: "El repartidor ya recogió tu pedido y va en camino. 🛵",
  en_camino_cliente: "Tu pedido ya va con el repartidor. En cuanto haya una actualización, te aviso. 🛵",
};

async function handleClienteMessage(telefono: string, mensaje: string, ubicacion?: unknown): Promise<JsonObject> {
  const ubicacionCoords = extractCoordsFromUbicacion(ubicacion);

  // Regla de oro #1: si la ubicación cae fuera del radio de cobertura, cancelamos aquí
  // mismo, antes de tocar la base de datos (ni leer ni crear ningún registro de pedido).
  if (ubicacionCoords && !isWithinCoverageArea(ubicacionCoords)) {
    const msg =
      "📍 Por ahora Mándalo solo cubre entregas dentro de Ixtlahuacán del Río, y tu ubicación " +
      "quedó fuera de esa zona.\n\nEn cuanto ampliemos la cobertura te avisamos. ¡Gracias por tu interés! 🙏";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "rechazado_fuera_de_zona" };
  }

  const openPedido = await pedidoRepositoryV2.getOpenPedidoByCustomerPhone(telefono).catch((e: unknown) => {
    console.error("[mandalo] getOpenPedidoByCustomerPhone falló", { message: getErrorMessage(e) });
    return null;
  });
  const hasActivePedido = Boolean(openPedido && !isTerminalState(openPedido.estado));

  // HARD RESET (prioridad absoluta): si el usuario pide pedido nuevo/reiniciar,
  // cancelamos cualquier pedido activo y arrancamos limpio.
  if (isNewOrderIntent(mensaje)) {
    if (hasActivePedido && openPedido) {
      await cancelOpenPedido(openPedido, "hard_reset").catch((e: unknown) => {
        console.error("[mandalo] cancelOpenPedido falló en hard reset", { pedidoId: openPedido.id, message: getErrorMessage(e) });
      });
    }
    setSessionFlag(telefono, { pedido_en_proceso: true });
    const msg = "¡Entendido! Pedido anterior cancelado. ¿Qué te gustaría pedir hoy? 🛒";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "hard_reset" };
  }

  if (hasActivePedido && openPedido) {
    // Ubicación GPS compartida en cualquier punto del flujo: si el pedido ya
    // tiene tienda confirmada, no hay nada más que actualizar con ella aquí
    // (solo aplica mientras seguimos en fase de captura/confirmación).
    if (openPedido.estado === "confirmacion_cliente") {
      return handleEsperandoConfirmacionInicial(telefono, mensaje, openPedido, ubicacionCoords);
    }

    if (openPedido.estado === "confirmado_tiendas") {
      const full = await pedidoRepositoryV2.getPedidoById(openPedido.id);
      if (full) return handleConfirmadoTiendas(telefono, mensaje, full);
    }

    if (openPedido.estado !== "seleccion_productos") {
      const flag = getSessionFlag(telefono);
      if (isRedundantConfirmationMessage(mensaje) || isOrderTrackingQuestion(mensaje) || !flag?.pedido_en_proceso) {
        const trackingMsg = TRACKING_MESSAGES[openPedido.estado] ?? "Tu pedido sigue en proceso. Te aviso en cuanto haya una actualización. 📦";
        await sendWhatsApp(telefono, trackingMsg);
        await guardarMensajeChat({ telefono, texto: trackingMsg, estado: "bot" }).catch(() => {});
        return { ok: true, role: "cliente", stage: openPedido.estado, pedidoId: openPedido.id };
      }
    }
    // estado === "seleccion_productos": seguimos abajo con el flujo de captura.
  }

  // Modo conversación: si el usuario está charlando o expresando emociones,
  // contestamos con IA y NO aplicamos la lógica de captura en este turno.
  if (isConversationModeMessage(mensaje)) {
    await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch(() => {});

    const historial = await fetchHistorialReciente(telefono, 12).catch(() => []);
    const currentOrderState = await getCurrentOrderStateForAgent(telefono);
    const respuesta = await getLLMResponse({
      historialReciente: (historial ?? [])
        .slice()
        .reverse()
        .map((m) => ({ role: m.estado === "bot" ? ("assistant" as const) : ("user" as const), content: String(m.texto ?? "") }))
        .filter((m) => m.content.trim()),
      supabaseJson: { maps_url: ubicacionCoords ? buildMapsLinkFromCoords(ubicacionCoords) : null },
      currentOrderState,
      userMessage: mensaje,
    });

    const customerReplyClean = sanitizeCustomerReply(String(respuesta.customer_reply ?? ""));
    await sendWhatsApp(telefono, customerReplyClean);
    await guardarMensajeChat({ telefono, texto: customerReplyClean, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "modo_conversacion" };
  }

  // Flujo de captura (IA + captureEngine): pedido nuevo o seguimos en seleccion_productos.
  await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch((e: unknown) => {
    console.error("[mandalo] guardarMensajeChat(cliente) falló", { message: getErrorMessage(e) });
  });

  const historial = await fetchHistorialReciente(telefono, 12).catch((e: unknown): HistorialMessage[] => {
    console.error("[mandalo] fetchHistorialReciente falló", { message: getErrorMessage(e) });
    return [];
  });

  const currentOrderState = await getCurrentOrderStateForAgent(telefono);
  const respuesta = await getLLMResponse({
    historialReciente: (historial ?? [])
      .slice()
      .reverse()
      .map((m) => ({ role: m.estado === "bot" ? ("assistant" as const) : ("user" as const), content: String(m.texto ?? "") }))
      .filter((m) => m.content.trim()),
    supabaseJson: { maps_url: ubicacionCoords ? buildMapsLinkFromCoords(ubicacionCoords) : null },
    currentOrderState,
    userMessage: mensaje,
  });

  // El pin de GPS (si vino) es la fuente de verdad para la dirección: siempre gana
  // sobre cualquier dirección de texto que la IA haya interpretado en este turno.
  let llmOrderState: Record<string, unknown> | null = ubicacionCoords
    ? {
        ...ensureSafeLlmOrderState(respuesta.order_state),
        address_text: buildAddressTextFromCoords(ubicacionCoords),
        latitud: ubicacionCoords.latitude,
        longitud: ubicacionCoords.longitude,
      }
    : ((respuesta.order_state ?? null) as Record<string, unknown> | null);

  // La IA reconoce el nombre de la tienda a partir de la lista real que se le
  // inyecta, pero no siempre echa de vuelta un business_id numérico válido.
  // Sin un id real, pedidoRepositoryV2 nunca crea la fila de pedido_tiendas
  // y el pedido se queda atorado — resolvemos por nombre contra la tabla real.
  const llmBusinessId = Number(llmOrderState?.business_id ?? llmOrderState?.businessId);
  const llmBusinessName = String(llmOrderState?.business_name ?? llmOrderState?.businessName ?? "").trim();
  if (llmOrderState && !Number.isFinite(llmBusinessId) && llmBusinessName) {
    const resolved = await resolveTiendaStrictByName(llmBusinessName).catch(() => null);
    if (resolved) {
      llmOrderState = { ...llmOrderState, business_id: resolved.id, business_name: resolved.nombre, business_phone: resolved.telefono };
    }
  }

  const captureResult = await captureEngine.processCustomerCapture({
    customerPhone: telefono,
    customerName: String(currentOrderState?.customerName ?? "").trim() || null,
    userMessage: mensaje,
    currentSnapshot: null,
    llmOrderState: llmOrderState as Record<string, unknown> | null,
  });

  console.log("[captureEngine] pedido:", {
    pedidoId: captureResult.pedidoId,
    nextState: captureResult.nextState,
    readyForConfirmation: captureResult.readyForConfirmation,
    itemCount: captureResult.items.length,
    missingFields: captureResult.validation.missingFields,
  });

  // Mientras falte información, dejamos que hable la IA: ya trae el hilo de la
  // conversación (historial + order_state) y el prompt le pide preguntar una
  // sola cosa a la vez sin repetirse. El mensaje fijo de captureEngine se
  // reserva para el resumen final de confirmación, donde sí necesitamos texto
  // exacto/estructurado (tienda, productos, dirección) y no una paráfrasis.
  const llmReplyClean = sanitizeCustomerReply(String(respuesta.customer_reply ?? ""));
  const customerMessage = captureResult.readyForConfirmation
    ? captureResult.customerMessage
    : llmReplyClean || captureResult.customerMessage;

  await sendWhatsApp(telefono, customerMessage);
  await guardarMensajeChat({ telefono, texto: customerMessage, estado: "bot" }).catch((e: unknown) => {
    console.error("[mandalo] guardarMensajeChat(bot) falló", { message: getErrorMessage(e) });
  });

  return {
    ok: true,
    role: "cliente",
    pedidoId: captureResult.pedidoId,
    stage: captureResult.nextState,
    readyForConfirmation: captureResult.readyForConfirmation,
  };
}

// --- Tienda ---

async function handleTiendaMessage(telefono: string, mensaje: string, tiendaId: number): Promise<JsonObject> {
  const ordenId = extraerOrdenId(String(mensaje));
  const precio = extraerPrecio(String(mensaje));
  if (!ordenId || precio == null || Number.isNaN(precio)) {
    return { ok: true, role: "tienda" };
  }

  const pedido = await pedidoRepositoryV2.getPedidoById(ordenId);
  if (!pedido) {
    const msg = `⚠️ No encontré el pedido ${ordenId}. Verifica el número e intenta de nuevo.`;
    await sendWhatsApp(telefono, msg);
    return { ok: true, role: "tienda", ordenId, error: "PEDIDO_NO_ENCONTRADO" };
  }

  if (!pedido.tienda || pedido.tienda.tiendaId !== tiendaId) {
    const msg = "⚠️ Ese pedido no corresponde a tu negocio. Verifica el número de orden.";
    await sendWhatsApp(telefono, msg);
    return { ok: true, role: "tienda", ordenId, error: "TIENDA_NO_CORRESPONDE" };
  }

  if (pedido.estado !== "pendiente_tiendas") {
    const msg = `Ese pedido ya no está esperando cotización (estado actual: ${pedido.estado}).`;
    await sendWhatsApp(telefono, msg);
    return { ok: true, role: "tienda", ordenId, error: "ESTADO_INVALIDO" };
  }

  const subtotal = Number(precio);
  const total = calculateFinalPrice(subtotal);

  await pedidoRepositoryV2.setPedidoTiendaCotizacion({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, subtotal });
  await pedidoRepositoryV2.setPedidoTotales({ pedidoId: ordenId, servicioRepartidor: MANDALO_DELIVERY_FEE, totalCliente: total });
  await pedidoRepositoryV2.setPedidoEstado({ pedidoId: ordenId, estado: "confirmado_tiendas" });
  await pedidoRepositoryV2.appendPedidoEvento({
    pedidoId: ordenId,
    tipoEvento: "cotizacion_recibida",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "confirmado_tiendas",
    actorTipo: "tienda",
    payload: { subtotal, total },
  });

  const msg =
    `Ya me contestó *${pedido.tienda.nombre ?? "la tienda"}* ✅\n\n` +
    `Subtotal: $${subtotal}\n` +
    `Servicio Mándalo: $${MANDALO_SERVICE_FEE}\n` +
    `Envío: $${MANDALO_DELIVERY_FEE}\n` +
    `Total a pagar: $${total}\n\n` +
    `¿Confirmas tu pedido? (Responde SÍ)`;
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: ordenId,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: msg },
    idempotencyKey: `pedido:${ordenId}:cliente:cotizacion_recibida:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msg, estado: "bot" }).catch(() => {});

  return { ok: true, role: "tienda", ordenId, total };
}

// --- Repartidor ---

async function handleRepartidorMessage(telefono: string, mensaje: string): Promise<JsonObject> {
  const text = String(mensaje ?? "");
  const parseResult = await courierCommandParser.handleIncomingCommand({ senderPhone: telefono, text });

  if (!parseResult.ok) {
    await sendWhatsApp(telefono, parseResult.courierMessage);
    return { ok: true, role: "repartidor", accion: parseResult.action, ordenId: parseResult.pedidoId ?? null };
  }

  const pedido = await pedidoRepositoryV2.getPedidoById(parseResult.pedidoId);
  const telefonoCliente = pedido?.clienteTelefono ?? null;

  if (parseResult.action === "confirmed") {
    if (telefonoCliente) {
      const msgCliente = `✅ ¡Excelente! *${parseResult.courierName}* aceptó tu pedido.\nEn cuanto lo recoja, te aviso. 📦`;
      await outboxRepository.enqueueOutboundMessage({
        pedidoId: parseResult.pedidoId,
        tipoMensaje: "notificacion_cliente",
        destinatarioTipo: "cliente",
        telefonoDestino: telefonoCliente,
        payload: { body: msgCliente },
        idempotencyKey: `pedido:${parseResult.pedidoId}:cliente:repartidor_confirmado:v1`,
      });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }

    if (parseResult.tiendaTelefono) {
      const msgTienda = `El pedido #${parseResult.pedidoId} ha sido tomado por el repartidor ${parseResult.courierName}.`;
      const tiendaTelefono = ensureMxWhatsappIntl(parseResult.tiendaTelefono);
      logBusinessDispatch({ orderId: parseResult.pedidoId, tiendaId: parseResult.tiendaId, tiendaNombre: parseResult.tiendaNombre, tiendaTelefono, to: tiendaTelefono, body: msgTienda });
      await outboxRepository.enqueueOutboundMessage({
        pedidoId: parseResult.pedidoId,
        tipoMensaje: "cotizacion_tienda",
        destinatarioTipo: "negocio",
        destinatarioId: parseResult.tiendaId,
        telefonoDestino: tiendaTelefono,
        payload: { body: msgTienda },
        idempotencyKey: `pedido:${parseResult.pedidoId}:store_notice_courier_accepted:v1`,
      });
    }

    const ack = `✅ Aceptación registrada para el pedido ${parseResult.pedidoId}.`;
    await sendWhatsApp(telefono, ack);
    return { ok: true, role: "repartidor", accion: "aceptado", ordenId: parseResult.pedidoId, repartidorNombre: parseResult.courierName };
  }

  if (parseResult.action === "picked_up") {
    if (telefonoCliente) {
      const msgCliente = `📦 ¡${parseResult.courierName} ya tiene tu pedido y está en camino!`;
      await outboxRepository.enqueueOutboundMessage({
        pedidoId: parseResult.pedidoId,
        tipoMensaje: "notificacion_cliente",
        destinatarioTipo: "cliente",
        telefonoDestino: telefonoCliente,
        payload: { body: msgCliente },
        idempotencyKey: `pedido:${parseResult.pedidoId}:cliente:pedido_recogido:v1`,
      });
      await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
    }
    const ack = `✅ Recogida registrada para el pedido ${parseResult.pedidoId}.`;
    await sendWhatsApp(telefono, ack);
    return { ok: true, role: "repartidor", accion: "en_camino", ordenId: parseResult.pedidoId };
  }

  // delivered
  if (telefonoCliente) {
    const msgCliente = "✅ Pedido entregado. ¡Gracias por tu compra y por confiar en nosotros! 🙌";
    await outboxRepository.enqueueOutboundMessage({
      pedidoId: parseResult.pedidoId,
      tipoMensaje: "notificacion_cliente",
      destinatarioTipo: "cliente",
      telefonoDestino: telefonoCliente,
      payload: { body: msgCliente },
      idempotencyKey: `pedido:${parseResult.pedidoId}:cliente:pedido_entregado:v1`,
    });
    await guardarMensajeChat({ telefono: telefonoCliente, texto: msgCliente, estado: "bot" }).catch(() => {});
  }
  const ack = `✅ Entrega registrada para el pedido ${parseResult.pedidoId}.`;
  await sendWhatsApp(telefono, ack);
  // Nota: la regla de retención (borrar el pedido al llegar a entregado) se
  // implementa aparte, en la Fase 4 — todavía no aquí.
  return { ok: true, role: "repartidor", accion: "completado", ordenId: parseResult.pedidoId };
}

export async function processMandaloWebhook(incoming: IncomingWhatsAppMessage): Promise<JsonObject> {
  // Backdoor admin: RESET_BOT <NUMERO_TELEFONO>
  const bodyTextRaw = String(incoming.body ?? "");
  if (isAdminSender(incoming.from)) {
    const m = bodyTextRaw.match(/^\s*RESET_BOT\s+([0-9+\-\s]{8,})\s*$/i);
    if (m?.[1]) {
      const target = normalizePhone(m[1]);
      const openPedido = await pedidoRepositoryV2.getOpenPedidoByCustomerPhone(target).catch(() => null);
      if (openPedido && !isTerminalState(openPedido.estado)) {
        await cancelOpenPedido(openPedido, "reset_bot_admin").catch(() => {});
      }
      sessionFlags.delete(target);
      const msg = `✅ RESET aplicado. Número desbloqueado: ${target}`;
      await sendWhatsApp(normalizePhone(incoming.from), msg);
      await guardarMensajeChat({ telefono: normalizePhone(incoming.from), texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "admin", accion: "reset_bot", target };
    }
  }

  const actor = await detectActorByPhone(incoming.from);

  if (actor.role === "tienda") {
    return handleTiendaMessage(actor.telefono, incoming.body, actor.tiendaId);
  }

  if (actor.role === "repartidor") {
    return handleRepartidorMessage(actor.telefono, incoming.body);
  }

  // Fallback conservador: mensaje con forma "ORDEN ... PRECIO ..." desde un
  // número que no se reconoció por rol pero sí está en la tabla de tiendas
  // (protege contra staleness de la caché de 60s de detectActorByPhone).
  const bodyText = bodyTextRaw;
  const looksLikeTiendaPrecio = /\borden\b/i.test(bodyText) && /\bprecio\b/i.test(bodyText);
  if (looksLikeTiendaPrecio) {
    const senderPhone = normalizePhone(String(incoming.from));
    const okTienda = await isTiendaSenderPhone(incoming.from);
    if (okTienda) {
      const explicitOrderId = extraerOrdenId(bodyText);
      const pedido = explicitOrderId ? await pedidoRepositoryV2.getPedidoById(explicitOrderId) : null;
      if (pedido?.tienda) {
        return handleTiendaMessage(senderPhone, bodyText, pedido.tienda.tiendaId);
      }
    } else {
      console.error("[mandalo] ORDEN+PRECIO recibido desde número no validado como tienda; ignorando fallback", { from: incoming.from });
    }
  }

  // Fallback: si detectActorByPhone no reconoce al repartidor (caché stale),
  // intentamos matchear directo contra repartidores.
  const courier = await findCourierByPhone(incoming.from);
  if (courier) {
    return handleRepartidorMessage(normalizePhone(String(incoming.from)), incoming.body);
  }

  return handleClienteMessage(actor.telefono, incoming.body, incoming.location);
}
