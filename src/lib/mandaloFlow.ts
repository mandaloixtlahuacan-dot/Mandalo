import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getChatCompletion, getOpenAIModel } from "@/lib/openaiClient";
import { buildMandaloSystemPrompt } from "@/lib/mandaloPrompt";
import { normalizeWhatsAppText, waapiSendText } from "@/lib/waapi";
import { detectActorByPhone, ensureMxWhatsappIntl, normalizePhone } from "@/lib/roles";
import { createCaptureEngine, formatItems as formatSnapshotItems } from "@/lib/services/captureEngine";
import * as pedidoRepositoryV2 from "@/lib/repositories/pedidoRepositoryV2";
import { getAdminPhone } from "@/lib/repositories/configRepository";
import * as metricsRepository from "@/lib/repositories/metricsRepository";
import * as validationEngine from "@/lib/services/validationEngine";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { createCourierCommandParser } from "@/lib/services/courierCommandParser";
import { buildOrderTimeoutMetadata, buildEsperandoAperturaMetadata } from "@/lib/services/orderTimeouts";
import { checkTiendaSchedule } from "@/lib/services/businessHours";
import { dispatchCotizacionToStore } from "@/lib/services/storeDispatch";
import { calculateFinalPrice, extraerNoDisponible, extraerOrdenId, extraerPrecio, formatMoney } from "@/lib/ordenes";
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
  isCancelIntent,
  isComplaintMessage,
  isDropProductIntent,
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
type TiendaRow = {
  id?: unknown;
  nombre?: unknown;
  categoria?: unknown;
  telefono?: unknown;
  hora_apertura?: unknown;
  hora_cierre?: unknown;
};
type CourierRow = { id?: unknown; nombre?: unknown; telefono?: unknown; activo?: unknown; vehiculo?: unknown };
type HistorialMessage = { texto: string; estado: "cliente" | "bot"; created_at: string };
type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

async function isAdminSender(phone: string): Promise<boolean> {
  const admin = await getAdminPhone();
  if (!admin) return false;
  const sender = normalizePhone(String(phone ?? ""));
  if (!sender) return false;
  return sender === admin || sender.slice(-10) === admin.slice(-10);
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

// Antes tenía su propio includes("confirmar")/includes("confirmado") además
// de isYesConfirmation — duplicaba el mismo defecto que causaba que una
// pregunta con la palabra "confirmar" adentro (ej. "antes de confirmar,
// hasta dónde tienes servicio") se tratara como redundante. isYesConfirmation
// ya distingue eso correctamente; no hace falta un segundo chequeo aparte.
function isRedundantConfirmationMessage(text: string): boolean {
  return isYesConfirmation(text);
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

// Zonas de cobertura confirmadas (calles/colonias dentro del radio de
// 1.5km) — lista blanca que Víctor mantiene directo en Supabase (ver
// supabase/migrations/20260823_zonas_cobertura.sql). Se usa en dos lugares
// del mismo turno: aquí para inyectarla al prompt, y en handleClienteMessage
// para que validationEngine verifique contra la lista real lo que sugiera
// la IA — mismo patrón que resolveTiendaStrictByName con el nombre de tienda.
async function fetchZonasCobertura(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.from("zonas_cobertura").select("nombre").eq("activa", true).limit(500);
    if (error) throw error;
    return (data ?? [])
      .map((row) => String((row as { nombre?: unknown })?.nombre ?? "").trim())
      .filter(Boolean);
  } catch (e: unknown) {
    console.error("[mandalo] fetchZonasCobertura: error consultando zonas_cobertura", { message: getErrorMessage(e) });
    return [];
  }
}

export async function getLLMResponse(params: {
  historialReciente: Array<{ role: "user" | "assistant"; content: string }>;
  supabaseJson: JsonObject;
  currentOrderState: JsonObject;
  userMessage: string;
}): Promise<MandaloAgentResponse> {
  const supabase = getSupabaseAdmin();
  let tiendas: TiendaRow[] = [];
  let tiendasCerradas: TiendaRow[] = [];
  try {
    const { data, error } = await supabase
      .from("tiendas")
      .select("id, nombre, categoria, telefono, hora_apertura, hora_cierre")
      .eq("activa", true)
      .limit(500);
    if (error) throw error;
    const activas = (data ?? []).filter(
      (n) => String((n as TiendaRow)?.nombre ?? "").trim() && String((n as TiendaRow)?.telefono ?? "").trim(),
    ) as TiendaRow[];
    // Horario de tienda (Sección 5 regla 6, Mándalo 24/7): una tienda cerrada
    // ya no se ofrece de entrada, pero SÍ debe seguir siendo reconocible por
    // nombre si el cliente la nombra explícitamente — de lo contrario la IA
    // nunca sabe que existe y le dice al cliente que "no la tiene registrada",
    // en vez de reconocerla y ofrecer programar el pedido para cuando abra
    // (bug encontrado en producción agosto 2026: Agua Santa cerrada quedaba
    // invisible por completo, incluso nombrada de forma explícita). Por eso
    // se separan en dos listas en vez de filtrar la cerrada fuera del todo.
    tiendas = activas.filter(
      (row) =>
        checkTiendaSchedule({
          horaApertura: row.hora_apertura == null ? null : String(row.hora_apertura),
          horaCierre: row.hora_cierre == null ? null : String(row.hora_cierre),
        }).withinSchedule,
    );
    tiendasCerradas = activas.filter((row) => !tiendas.includes(row));
  } catch (e: unknown) {
    console.error("[mandalo] getLLMResponse: error consultando tiendas", { message: getErrorMessage(e) });
  }

  const tiendas_text = tiendas.length
    ? tiendas
        .map((n) => `- ${String(n.nombre ?? "")}${n.categoria ? ` (${String(n.categoria)})` : ""} [${String(n.telefono ?? "")}]`)
        .join("\n")
    : "(sin tiendas disponibles)";

  const tiendasCerradas_text = tiendasCerradas.length
    ? tiendasCerradas
        .map(
          (n) =>
            `- ${String(n.nombre ?? "")}${n.categoria ? ` (${String(n.categoria)})` : ""} — cerrada ahora, abre a las ${String(n.hora_apertura ?? "?")}`,
        )
        .join("\n")
    : "(ninguna)";

  const zonasCoberturaNombres = await fetchZonasCobertura();
  const zonasCobertura_text = zonasCoberturaNombres.length
    ? zonasCoberturaNombres.map((z) => `- ${z}`).join("\n")
    : "(sin zonas confirmadas)";

  const model = getOpenAIModel();
  const system = buildMandaloSystemPrompt({
    negociosDisponibles: tiendas_text,
    negociosCerrados: tiendasCerradas_text,
    repartidoresActivos: String(params.supabaseJson?.repartidores_text ?? "(sin repartidores)"),
    zonasCobertura: zonasCobertura_text,
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

  // 900 (antes 600): justo después de elegir tienda, el JSON que debe
  // devolver la IA crece de golpe (tiene que repetir business_name/id/phone
  // + la lista completa de items, BLOQUE 4). Con 600 tokens, la IA a veces
  // se quedaba sin espacio y omitía "customer_reply" para priorizar terminar
  // bien el order_state — ver nota más abajo sobre qué pasaba en ese caso.
  const text = await getChatCompletion({ model, messages, max_tokens: 900, temperature: 0 });

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
        // Si la IA omite la clave "customer_reply" (JSON válido pero
        // incompleto), el schema la rellena con un texto de relleno
        // ("¡Entendido! Dame un momento.") que no invita a nada — el cliente
        // se quedaba sin saber qué sigue hasta que insistía con otro
        // mensaje. Tratamos ese caso como respuesta vacía para que cada
        // llamador use su propio mensaje de respaldo real en vez de este
        // relleno genérico.
        const hadRealReply =
          typeof (parsedJson as Record<string, unknown>).customer_reply === "string" &&
          String((parsedJson as Record<string, unknown>).customer_reply).trim().length > 0;
        return {
          ...parsed.data,
          customer_reply: hadRealReply ? parsed.data.customer_reply : "",
          order_state: ensureSafeLlmOrderState(parsed.data.order_state, "collecting"),
        };
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

type TiendaResolution =
  | { status: "found"; id: number; nombre: string; telefono: string }
  | { status: "closed"; id: number; nombre: string; telefono: string; horaApertura: string; horaCierre: string }
  | { status: "not_found" };

const TIENDA_RESOLUTION_SELECT = "id, nombre, telefono, activa, hora_apertura, hora_cierre";

function resolveTiendaRow(row: {
  id: unknown;
  nombre: unknown;
  telefono: unknown;
  activa: unknown;
  hora_apertura: unknown;
  hora_cierre: unknown;
} | null | undefined, fallbackName: string): TiendaResolution {
  if (!row?.telefono || row.activa === false) return { status: "not_found" };

  const schedule = checkTiendaSchedule({
    horaApertura: row.hora_apertura == null ? null : String(row.hora_apertura),
    horaCierre: row.hora_cierre == null ? null : String(row.hora_cierre),
  });
  if (!schedule.withinSchedule) {
    return {
      status: "closed",
      id: Number(row.id),
      nombre: String(row.nombre ?? fallbackName),
      telefono: ensureMxWhatsappIntl(String(row.telefono)),
      horaApertura: schedule.horaApertura,
      horaCierre: schedule.horaCierre,
    };
  }

  return {
    id: Number(row.id),
    nombre: String(row.nombre ?? fallbackName),
    telefono: ensureMxWhatsappIntl(String(row.telefono)),
    status: "found",
  };
}

// Horario de tienda (brief sección 3): validado antes de asignar, no solo al
// listarla — un cliente puede nombrar directamente una tienda que el bot no
// mostró en este turno (la recuerda de un turno anterior, o la escribió de
// memoria), así que la resolución por nombre también tiene que revisar
// horario, no solo la lista que arma getLLMResponse.
async function resolveTiendaStrictByName(nombre: string): Promise<TiendaResolution> {
  const supabase = getSupabaseAdmin();
  const name = String(nombre ?? "").trim();
  if (!name) return { status: "not_found" };

  const exact = await supabase.from("tiendas").select(TIENDA_RESOLUTION_SELECT).eq("nombre", name).limit(1);
  if (!exact.error && exact.data?.[0]) {
    const resolved = resolveTiendaRow(exact.data[0], name);
    if (resolved.status !== "not_found") return resolved;
  }

  const like = await supabase.from("tiendas").select(TIENDA_RESOLUTION_SELECT).ilike("nombre", `%${name}%`).limit(1);
  if (!like.error && like.data?.[0]) {
    const resolved = resolveTiendaRow(like.data[0], name);
    if (resolved.status !== "not_found") return resolved;
  }

  return { status: "not_found" };
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

async function cancelOpenPedido(pedido: PedidoV2Record, telefono: string, reason: string): Promise<void> {
  await pedidoRepositoryV2.setPedidoEstado({ pedidoId: pedido.id, estado: "cancelado" });
  await pedidoRepositoryV2.appendPedidoEvento({
    pedidoId: pedido.id,
    tipoEvento: "cancelado",
    estadoOrigen: pedido.estado,
    estadoDestino: "cancelado",
    actorTipo: "cliente",
    payload: { reason },
  });

  // Reporte semanal (brief sección 5): contador agregado, no guarda nada del
  // pedido en sí. Best-effort — nunca debe tumbar el cierre real del pedido.
  await metricsRepository.incrementMetric("pedidos_cancelados").catch((e: unknown) => {
    console.error("[mandalo] incrementMetric falló (pedidos_cancelados)", { pedidoId: pedido.id, message: getErrorMessage(e) });
  });

  // Retención (CLAUDE.md Sección 4): borra el pedido y reinicia el chat del
  // cliente. Va al final: nada más queda pendiente de encolar sobre este
  // pedidoId después de este punto en ninguno de los dos llamadores.
  await pedidoRepositoryV2.finalizePedidoRetention({ pedidoId: pedido.id, customerPhone: telefono });
}

// Folio corto y visible (brief sección 3): el id numérico del pedido hace de
// folio ("pedido #12") en todo mensaje de seguimiento al cliente, para que
// tenga una referencia rápida a mano si necesita escribir por una queja.
function buildResumenPedido(pedido: PedidoV2Record): string {
  const snapshot = pedido.snapshot_json;
  const tienda = String(snapshot.businessName ?? "").trim() || "(sin tienda)";
  const direccion = String(snapshot.addressText ?? "").trim() || "(sin dirección)";
  const items = formatSnapshotItems(snapshot.items ?? []);
  return `🧾 Pedido #${pedido.id}\n\nTienda: ${tienda}\n\n🛒 Productos:\n${items}\n\n🏠 Entrega:\n${direccion}`;
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
    const addressText = buildAddressTextFromCoords();
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

  // Se trae aquí (antes solo se traía tras el SÍ) porque ahora hace falta en
  // las dos ramas: para avisar en el resumen si la tienda está cerrada
  // (Sección 5 regla 6 — Víctor pidió que el cliente se entere antes de
  // confirmar, no después) y para decidir, tras el SÍ, si se despacha ya o
  // se programa.
  const full = await pedidoRepositoryV2.getPedidoById(pedido.id);
  if (!full?.tienda?.telefono) {
    console.error("[ERROR CRÍTICO] No se encontró el teléfono de la tienda.", { pedidoId: pedido.id, tienda: full?.tienda ?? null });

    // Red de seguridad: sin tienda vinculada no hay a quién mandarle la
    // cotización. Antes esto dejaba el pedido varado en confirmacion_cliente
    // para siempre (el cliente no tenía forma de recuperarse). Regresamos a
    // captura con el negocio invalidado para que la IA vuelva a pedirlo y
    // mandaloFlow reintente resolveTiendaStrictByName en el siguiente turno.
    const resetSnapshot = { ...snapshot, businessId: null, businessName: null, businessPhone: null };
    await pedidoRepositoryV2.updatePedidoSnapshot({
      pedidoId: pedido.id,
      estado: "seleccion_productos",
      snapshot: resetSnapshot,
      addressText: snapshot.addressText ?? null,
      latitud: snapshot.latitud ?? null,
      longitud: snapshot.longitud ?? null,
    });
    await pedidoRepositoryV2.appendPedidoEvento({
      pedidoId: pedido.id,
      tipoEvento: "tienda_no_resuelta_reintento",
      estadoOrigen: "confirmacion_cliente",
      estadoDestino: "seleccion_productos",
      actorTipo: "sistema",
    });

    const msg = "⚠️ No pude identificar la tienda para tu pedido.\nDime el nombre exacto del negocio y seguimos. 🛒";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "seleccion_productos", pedidoId: pedido.id };
  }

  const schedule = checkTiendaSchedule({ horaApertura: full.tienda.horaApertura, horaCierre: full.tienda.horaCierre });

  if (!isYesConfirmation(mensaje)) {
    const avisoCerrada = !schedule.withinSchedule
      ? `\n\n⏰ Ojo: *${full.tienda.nombre}* está cerrada ahora. Se la voy a mandar en cuanto abra, a las ${schedule.horaApertura}.`
      : "";
    const msg = `✅ Ya tengo tu pedido:\n${buildResumenPedido({ ...pedido, snapshot_json: snapshot })}${avisoCerrada}\n\n¿Es correcto tu pedido? Responde *SÍ* para confirmar. ✅`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
  }

  // Tienda cerrada: no se despacha todavía — se programa. La tienda no se
  // entera hasta que abra (decisión de Víctor); scheduledDispatchWorker.ts
  // hace el disparo real cuando checkTiendaSchedule diga que ya abrió.
  if (!schedule.withinSchedule) {
    try {
      await pedidoRepositoryV2.setPedidoEstado({
        pedidoId: full.id,
        estado: "esperando_apertura_tienda",
        metadataPatch: buildEsperandoAperturaMetadata(),
      });
      await pedidoRepositoryV2.appendPedidoEvento({
        pedidoId: full.id,
        tipoEvento: "pedido_programado",
        estadoOrigen: "confirmacion_cliente",
        estadoDestino: "esperando_apertura_tienda",
        actorTipo: "cliente",
      });
    } catch (e: unknown) {
      console.error("[mandalo] no se pudo programar el pedido para apertura de tienda", { pedidoId: full.id, message: getErrorMessage(e) });
      const msg = "⚠️ Hubo un problema al programar tu pedido.\n\nInténtalo de nuevo respondiendo *SÍ*. Si vuelve a fallar, avísame.";
      await sendWhatsApp(telefono, msg);
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
    }

    const msgCliente = `✅ Pedido #${full.id} programado.\n\nSe lo voy a mandar a *${full.tienda.nombre}* en cuanto abra, a las ${schedule.horaApertura}. Te aviso apenas se lo mande. 📦`;
    await sendWhatsApp(telefono, msgCliente);
    await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "esperando_apertura_tienda", pedidoId: full.id };
  }

  const dispatchResult = await dispatchCotizacionToStore(full, { fromEstado: "confirmacion_cliente", actorTipo: "cliente" }).catch(
    (e: unknown) => {
      console.error("[mandalo] no se pudo encolar o transicionar dispatch a tienda", { pedidoId: full.id, message: getErrorMessage(e) });
      return { ok: false as const, reason: "dispatch_failed" as const };
    },
  );

  if (!dispatchResult.ok) {
    const msg = "⚠️ Hubo un problema al registrar tu pedido para enviarlo a la tienda.\n\nInténtalo de nuevo respondiendo *SÍ*. Si vuelve a fallar, avísame.";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmacion_cliente", pedidoId: pedido.id };
  }

  const msgCliente = `📩 Pedido #${full.id} quedó registrado para envío a *${full.tienda.nombre}*.\n\nTe avisaré en cuanto la tienda confirme el precio.`;
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
    const msg = `⚠️ Pedido #${pedido.id}: por ahora no tengo repartidores activos disponibles.\nEn cuanto haya uno libre, te aviso. 🙏`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "confirmado_tiendas", pedidoId: pedido.id };
  }

  const repartidorNombre = String(repartidor?.nombre ?? "").trim() || "Repartidor";
  const repartidorTelefono = ensureMxWhatsappIntl(String(repartidor?.telefono ?? ""));
  const mapsLink = resolveMapsLink({ latitud: pedido.latitud, longitud: pedido.longitud });

  const msgRepartidor =
    `Hola ${repartidorNombre}, tienes un nuevo pedido 📦\n\n` +
    `🧾 Pedido #${pedido.id} — ${pedido.tienda?.nombre ?? "la tienda"}\n\n` +
    `🏪 Recoger en:\n${pedido.tienda?.direccion || "(sin dirección de tienda registrada, confirma con la tienda)"}\n\n` +
    `📍 Entregar en:\n${pedido.direccionEntrega || "(sin dirección)"}\n` +
    `${mapsLink ? `🗺️ Mapa: ${mapsLink}\n` : ""}\n` +
    `🛒 Productos:\n${formatItemsForMessage(pedido.items)}\n\n` +
    `${pedido.totalCliente != null ? `*Cobrar: ${formatMoney(pedido.totalCliente)}*\n` : ""}` +
    `📞 Tel. cliente: ${telefono}\n\n` +
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
  const msgCliente = `✅ Pedido #${pedido.id} confirmado.\nLlegará aproximadamente a las ${etaText}.\n\nEstamos coordinando tu entrega con *${repartidorNombre}*.\nTe avisaré en cuanto confirme. 📦`;
  await sendWhatsApp(telefono, msgCliente);
  await guardarMensajeChat({ telefono, texto: msgCliente, estado: "bot" }).catch(() => {});
  return { ok: true, role: "cliente", stage: "dispatch_repartidor_pendiente", pedidoId: pedido.id };
}

// Contraparte del cliente para handleTiendaProductoNoDisponible: decide si
// continúa sin el producto (isDropProductIntent) o lo cambia por otro
// (cualquier otro texto se toma como la descripción del reemplazo — mismo
// principio que "no inventes el nombre exacto" de BLOQUE 4 del prompt, aquí
// aplicado a texto que ya viene directo del cliente, sin pasar por la IA).
// Reusa dispatchCotizacionToStore para volver a pendiente_tiendas y re-cotizar
// con la tienda — mismo mecanismo que el dispatch inicial.
async function handleAjusteProducto(telefono: string, mensaje: string, pedido: PedidoFullRecord): Promise<JsonObject> {
  if (!pedido.tienda) {
    console.error("[mandalo] ajuste_producto sin tienda vinculada", { pedidoId: pedido.id });
    const msg = "⚠️ Hubo un problema con tu pedido. Ya avisé a nuestro equipo. 🙏";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "ajuste_producto", pedidoId: pedido.id };
  }
  const pedidoTiendaId = pedido.tienda.pedidoTiendaId;

  const itemNombre = String(pedido.metadata.product_adjustment_item_nombre ?? "ese producto");
  const itemIdRaw = pedido.metadata.product_adjustment_item_id;
  const itemId = typeof itemIdRaw === "number" ? itemIdRaw : Number(itemIdRaw);

  if (!Number.isFinite(itemId)) {
    const msg = `Sigo esperando tu decisión sobre un producto de tu pedido #${pedido.id}.\n\nEscríbeme "sin él" para quitarlo, o dime por cuál producto lo cambio.`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "ajuste_producto", pedidoId: pedido.id };
  }

  async function reDispatchTrasAjuste(resumenCambio: string): Promise<JsonObject> {
    await pedidoRepositoryV2.setPedidoTiendaEstado({ pedidoTiendaId, estadoTienda: "pendiente" });
    const fresh = await pedidoRepositoryV2.getPedidoById(pedido.id);
    if (!fresh) {
      const msg = "⚠️ Hubo un problema al actualizar tu pedido. Inténtalo de nuevo en un momento.";
      await sendWhatsApp(telefono, msg);
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", stage: "ajuste_producto", pedidoId: pedido.id };
    }

    const dispatchResult = await dispatchCotizacionToStore(fresh, { fromEstado: "ajuste_producto", actorTipo: "cliente" }).catch(
      (e: unknown) => {
        console.error("[mandalo] no se pudo re-despachar tras ajuste_producto", { pedidoId: pedido.id, message: getErrorMessage(e) });
        return { ok: false as const, reason: "dispatch_failed" as const };
      },
    );

    const msg = dispatchResult.ok
      ? `${resumenCambio}\n\nTu pedido ahora es:\n${formatItemsForMessage(fresh.items)}\n\nLe avisé a *${pedido.tienda?.nombre ?? "la tienda"}* para que confirme el nuevo precio. 🧾`
      : `${resumenCambio}\n\nHubo un problema al avisarle a la tienda — dame un momento y lo reintento. 🙏`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "ajuste_resuelto", pedidoId: pedido.id };
  }

  if (isDropProductIntent(mensaje)) {
    await pedidoRepositoryV2.removePedidoItem(itemId);
    const restantes = pedido.items.filter((it) => it.id !== itemId);

    if (!restantes.length) {
      await cancelOpenPedido(
        { id: pedido.id, estado: pedido.estado, snapshot_json: pedido.snapshot },
        telefono,
        "sin_productos_tras_ajuste",
      );
      const msg =
        `De acuerdo, quité "${itemNombre}" — pero era el único producto de tu pedido #${pedido.id}, así que lo cancelé. 🙏\n\n` +
        `Cuando quieras, hacemos uno nuevo. 🛒`;
      await sendWhatsApp(telefono, msg);
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", accion: "cancelado_sin_productos", pedidoId: pedido.id };
    }

    return reDispatchTrasAjuste(`✅ Listo, quité "${itemNombre}" de tu pedido #${pedido.id}.`);
  }

  const nuevoTexto = String(mensaje ?? "").trim();
  if (!nuevoTexto) {
    const msg = `Dime "sin él" para quitar "${itemNombre}" de tu pedido, o el nombre del producto por el que lo cambio.`;
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", stage: "ajuste_producto", pedidoId: pedido.id };
  }

  await pedidoRepositoryV2.replacePedidoItemText(itemId, nuevoTexto);
  return reDispatchTrasAjuste(`✅ Listo, cambié "${itemNombre}" por "${nuevoTexto}" en tu pedido #${pedido.id}.`);
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

  // Escalamiento de quejas (brief sección 4 paso 9): prioridad más alta que
  // el hard reset — si alguien está molesto o algo salió mal, no lo recibimos
  // con "¿qué se te antoja hoy?": lo conectamos directo con el admin, con o
  // sin pedido activo (puede llegar después de que la retención ya borró el
  // pedido que originó la queja).
  if (isComplaintMessage(mensaje)) {
    await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch(() => {});
    await outboxRepository
      .enqueueAdminNotification({
        pedidoId: openPedido?.id ?? null,
        tipo: "queja_cliente",
        contenido:
          `Queja de cliente\n\n` +
          `Tel: ${telefono}\n` +
          `${openPedido ? `Pedido relacionado: #${openPedido.id}\n` : ""}` +
          `Mensaje: ${mensaje}`,
      })
      .catch((e: unknown) => {
        console.error("[mandalo] no se pudo escalar queja al admin", { message: getErrorMessage(e) });
      });
    const msg = "🙏 Ya avisé a nuestro equipo de lo que pasó. Te van a contactar directo para resolverlo.\n\nGracias por avisarnos.";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: "queja_escalada" };
  }

  // Cancelación / hard reset (prioridad absoluta): dispara igual sin importar
  // si la frase fue el reset explícito ("pedido nuevo") o lenguaje natural de
  // cancelación ("ya no lo quiero"). CLAUDE.md Sección 5: "la cancelación es
  // gratuita solo antes de que la tienda confirme el precio" — de
  // confirmado_tiendas en adelante ya no es autoservicio simple, así que en
  // vez de cancelar y borrar solo, escalamos al admin (mismo mecanismo que
  // isComplaintMessage) porque puede haber un repartidor ya en camino físico.
  const wantsNewOrder = isNewOrderIntent(mensaje);
  const wantsCancel = isCancelIntent(mensaje);
  if (wantsNewOrder || wantsCancel) {
    const PAST_FREE_CANCEL_WINDOW: OrderState[] = [
      "confirmado_tiendas",
      "dispatch_repartidor_pendiente",
      "repartidor_asignado",
      "recogiendo",
      "en_camino_cliente",
    ];
    const pastFreeCancelWindow =
      hasActivePedido && openPedido != null && PAST_FREE_CANCEL_WINDOW.includes(openPedido.estado);

    if (pastFreeCancelWindow && openPedido) {
      await guardarMensajeChat({ telefono, texto: String(mensaje ?? ""), estado: "cliente" }).catch(() => {});
      await outboxRepository
        .enqueueAdminNotification({
          pedidoId: openPedido.id,
          tipo: "cancelacion_tardia",
          contenido:
            `Cliente pide cancelar un pedido ya avanzado\n\n` +
            `Tel: ${telefono}\n` +
            `Pedido: #${openPedido.id}\n` +
            `Estado actual: ${openPedido.estado}\n` +
            `Mensaje: ${mensaje}`,
        })
        .catch((e: unknown) => {
          console.error("[mandalo] no se pudo escalar cancelación tardía al admin", { message: getErrorMessage(e) });
        });
      const msg = `⚠️ Tu pedido #${openPedido.id} ya está en proceso avanzado, así que no puedo cancelarlo yo solo.\n\nYa avisé a nuestro equipo — te van a contactar directo. 🙏`;
      await sendWhatsApp(telefono, msg);
      await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
      return { ok: true, role: "cliente", accion: "cancelacion_escalada", pedidoId: openPedido.id };
    }

    if (hasActivePedido && openPedido) {
      await cancelOpenPedido(openPedido, telefono, wantsNewOrder ? "hard_reset" : "cliente_cancelo").catch((e: unknown) => {
        console.error("[mandalo] cancelOpenPedido falló", { pedidoId: openPedido.id, message: getErrorMessage(e) });
      });
    }
    setSessionFlag(telefono, { pedido_en_proceso: true });
    const msg = wantsNewOrder
      ? "¡Entendido! Pedido anterior cancelado. ¿Qué te gustaría pedir hoy? 🛒"
      : "✅ Listo, cancelé tu pedido.\n\nCuando quieras hacer uno nuevo, aquí estoy. 🛒";
    await sendWhatsApp(telefono, msg);
    await guardarMensajeChat({ telefono, texto: msg, estado: "bot" }).catch(() => {});
    return { ok: true, role: "cliente", accion: wantsNewOrder ? "hard_reset" : "cancelado_por_cliente" };
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

    // A diferencia de pendiente_tiendas/esperando_apertura_tienda (estados
    // pasivos, el cliente solo espera), en ajuste_producto SÍ hay algo que
    // decidir — no puede caer en el branch genérico de abajo, que solo manda
    // un mensaje de "tu pedido sigue en proceso" sin procesar la respuesta.
    if (openPedido.estado === "ajuste_producto") {
      const full = await pedidoRepositoryV2.getPedidoById(openPedido.id);
      if (full) return handleAjusteProducto(telefono, mensaje, full);
    }

    if (openPedido.estado !== "seleccion_productos") {
      const flag = getSessionFlag(telefono);
      if (isRedundantConfirmationMessage(mensaje) || isOrderTrackingQuestion(mensaje) || !flag?.pedido_en_proceso) {
        // esperando_apertura_tienda es un estado pasivo como pendiente_tiendas
        // (el cliente no tiene nada que responder, solo espera) — a diferencia
        // de confirmacion_cliente/confirmado_tiendas, que sí necesitan
        // interpretar isYesConfirmation. El mensaje no puede ser estático
        // porque depende de qué tienda y a qué hora abre, así que se arma
        // dinámico aquí en vez de vivir en TRACKING_MESSAGES.
        let trackingBody = TRACKING_MESSAGES[openPedido.estado] ?? "Tu pedido sigue en proceso. Te aviso en cuanto haya una actualización. 📦";
        if (openPedido.estado === "esperando_apertura_tienda") {
          const full = await pedidoRepositoryV2.getPedidoById(openPedido.id);
          const tiendaNombre = full?.tienda?.nombre ?? "la tienda";
          const schedule = full?.tienda
            ? checkTiendaSchedule({ horaApertura: full.tienda.horaApertura, horaCierre: full.tienda.horaCierre })
            : null;
          trackingBody =
            schedule && !schedule.withinSchedule
              ? `Sigue programado para *${tiendaNombre}*. Se lo voy a mandar en cuanto abra, a las ${schedule.horaApertura}. 🕗`
              : `*${tiendaNombre}* ya debería estar abierta — en un momento te aviso que se mandó tu pedido. 📦`;
        }
        const trackingMsg = `Pedido #${openPedido.id}: ${trackingBody}`;
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

    // A diferencia del flujo de captura (que puede caer al mensaje
    // estructurado de captureEngine si la IA no trae customer_reply), este
    // modo no tiene ningún respaldo estructurado propio — necesita su propio
    // mensaje genérico para no mandar un WhatsApp vacío.
    const customerReplyClean =
      sanitizeCustomerReply(String(respuesta.customer_reply ?? "")) ||
      "¿En qué te ayudo? Cuéntame qué se te antoja o qué necesitas. 🛒";
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
        address_text: buildAddressTextFromCoords(),
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
    const resolved = await resolveTiendaStrictByName(llmBusinessName).catch(
      (): TiendaResolution => ({ status: "not_found" }),
    );

    // Horario de tienda (Sección 5 regla 6, agosto 2026): una tienda cerrada
    // ya NO rechaza el pedido — se sigue armando igual (items, dirección) y
    // se programa para dispararse en cuanto abra. El aviso de "está cerrada,
    // se le mandará a las X" se lo decimos en el resumen de confirmación
    // (handleEsperandoConfirmacionInicial), no aquí — ahí es donde Víctor
    // pidió que el cliente se entere, antes de decir SÍ.
    if (resolved.status === "found" || resolved.status === "closed") {
      llmOrderState = { ...llmOrderState, business_id: resolved.id, business_name: resolved.nombre, business_phone: resolved.telefono };
    }
  }

  const knownZoneNames = await fetchZonasCobertura();
  const captureResult = await captureEngine.processCustomerCapture({
    customerPhone: telefono,
    customerName: String(currentOrderState?.customerName ?? "").trim() || null,
    userMessage: mensaje,
    currentSnapshot: null,
    llmOrderState: llmOrderState as Record<string, unknown> | null,
    knownZoneNames,
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

// Cierra el estado ajuste_producto (CLAUDE.md Sección 6 paso 5, existía en la
// máquina de estados sin lógica real detrás): la tienda reporta que un
// producto puntual no está disponible mientras cotiza, ANTES de mandar
// #PRECIO. El pedido completo no se cancela — se pausa solo ese producto y el
// cliente decide (handleAjusteProducto abajo). Mismas validaciones de
// ownership/estado que handleTiendaMessage porque comparte el mismo
// remitente/comando de "ORDEN #<id> ...".
async function handleTiendaProductoNoDisponible(
  telefono: string,
  tiendaId: number,
  ordenId: number,
  productoTexto: string,
): Promise<JsonObject> {
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

  const item = await pedidoRepositoryV2.findPedidoItemByText(pedido.tienda.pedidoTiendaId, productoTexto);
  if (!item) {
    const msg =
      `No encontré "${productoTexto}" en el pedido #${ordenId}.\n\n` +
      `Productos del pedido:\n${formatItemsForMessage(pedido.items)}\n\n` +
      `Escribe el nombre tal como aparece arriba, ej: ORDEN #${ordenId} NO_DISPONIBLE ${pedido.items[0]?.nombreProducto ?? "producto"}`;
    await sendWhatsApp(telefono, msg);
    return { ok: true, role: "tienda", ordenId, error: "PRODUCTO_NO_ENCONTRADO" };
  }

  await pedidoRepositoryV2.setPedidoItemDisponible(item.id, false);
  await pedidoRepositoryV2.setPedidoTiendaEstado({ pedidoTiendaId: pedido.tienda.pedidoTiendaId, estadoTienda: "ajuste_producto" });
  await pedidoRepositoryV2.setPedidoEstado({
    pedidoId: ordenId,
    estado: "ajuste_producto",
    metadataPatch: {
      ...buildOrderTimeoutMetadata("product_adjustment"),
      product_adjustment_item_id: item.id,
      product_adjustment_item_nombre: item.nombreProducto,
    },
  });
  await pedidoRepositoryV2.appendPedidoEvento({
    pedidoId: ordenId,
    tipoEvento: "producto_no_disponible",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "ajuste_producto",
    actorTipo: "tienda",
    payload: { itemId: item.id, itemNombre: item.nombreProducto },
  });

  const msgCliente =
    `📦 *${pedido.tienda.nombre ?? "La tienda"}* no tiene disponible:\n"${item.nombreProducto}"\n\n` +
    `¿Quieres continuar tu pedido sin este producto, o prefieres cambiarlo por otro?\n\n` +
    `Responde "sin él" para quitarlo, o dime el producto por el que lo cambias. 🙏`;
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: ordenId,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: msgCliente },
    idempotencyKey: `pedido:${ordenId}:cliente:producto_no_disponible:${item.id}:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msgCliente, estado: "bot" }).catch(() => {});

  await sendWhatsApp(
    telefono,
    `Recibido, gracias — ya le avisé al cliente que "${item.nombreProducto}" no está disponible. En cuanto me diga qué hacer, seguimos. 🙏`,
  );

  return { ok: true, role: "tienda", ordenId, accion: "producto_no_disponible", itemId: item.id };
}

async function handleTiendaMessage(telefono: string, mensaje: string, tiendaId: number): Promise<JsonObject> {
  const ordenId = extraerOrdenId(String(mensaje));
  const noDisponible = extraerNoDisponible(String(mensaje));

  if (ordenId && noDisponible) {
    return handleTiendaProductoNoDisponible(telefono, tiendaId, ordenId, noDisponible.productoTexto);
  }

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
  await pedidoRepositoryV2.setPedidoEstado({
    pedidoId: ordenId,
    estado: "confirmado_tiendas",
    metadataPatch: buildOrderTimeoutMetadata("final_confirmation"),
  });
  await pedidoRepositoryV2.appendPedidoEvento({
    pedidoId: ordenId,
    tipoEvento: "cotizacion_recibida",
    estadoOrigen: "pendiente_tiendas",
    estadoDestino: "confirmado_tiendas",
    actorTipo: "tienda",
    payload: { subtotal, total },
  });

  const msg =
    `✅ *${pedido.tienda.nombre ?? "La tienda"}* ya respondió — este es tu total:\n\n` +
    `🧾 Pedido #${ordenId}\n` +
    `Subtotal: ${formatMoney(subtotal)}\n` +
    `Servicio Mándalo: ${formatMoney(MANDALO_SERVICE_FEE)}\n` +
    `Envío: ${formatMoney(MANDALO_DELIVERY_FEE)}\n` +
    `*Total a pagar: ${formatMoney(total)}*\n\n` +
    `¿Confirmas tu pedido? Responde *SÍ* ✅`;
  await outboxRepository.enqueueOutboundMessage({
    pedidoId: ordenId,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    telefonoDestino: pedido.clienteTelefono,
    payload: { body: msg },
    idempotencyKey: `pedido:${ordenId}:cliente:cotizacion_recibida:v1`,
  });
  await guardarMensajeChat({ telefono: pedido.clienteTelefono, texto: msg, estado: "bot" }).catch(() => {});

  // Confirmación corta a la tienda misma — sin esto, el dueño manda el precio
  // y no vuelve a saber nada, no tiene forma de confirmar que su mensaje se
  // procesó bien (a diferencia del repartidor, que sí recibe un ack aquí abajo).
  await sendWhatsApp(telefono, `Recibido, gracias — ya le avisé al cliente el total del pedido #${ordenId}.`);

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
      const msgCliente = `✅ Pedido #${parseResult.pedidoId}: ¡Excelente! *${parseResult.courierName}* aceptó tu pedido.\nEn cuanto lo recoja, te aviso. 📦`;
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
      const msgCliente = `📦 Pedido #${parseResult.pedidoId}: ¡${parseResult.courierName} ya tiene tu pedido y está en camino!`;
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
    const msgCliente = `✅ Pedido #${parseResult.pedidoId} entregado. ¡Gracias por tu compra y por confiar en nosotros! 🙌`;
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

  // Reporte semanal (brief sección 5): contador agregado, no guarda nada del
  // pedido en sí.
  await metricsRepository.incrementMetric("pedidos_entregados").catch((e: unknown) => {
    console.error("[mandalo] incrementMetric falló (pedidos_entregados)", { pedidoId: parseResult.pedidoId, message: getErrorMessage(e) });
  });
  if (pedido?.totalCliente != null) {
    await metricsRepository.incrementMetric("ingresos_entregados", pedido.totalCliente).catch((e: unknown) => {
      console.error("[mandalo] incrementMetric falló (ingresos_entregados)", { pedidoId: parseResult.pedidoId, message: getErrorMessage(e) });
    });
  }

  // Retención (CLAUDE.md Sección 4): va al final, después de encolar el
  // mensaje de cierre al cliente — admin_notificaciones.pedido_id no acepta
  // un id que ya no exista.
  if (telefonoCliente) {
    await pedidoRepositoryV2
      .finalizePedidoRetention({ pedidoId: parseResult.pedidoId, customerPhone: telefonoCliente })
      .catch((e: unknown) => {
        console.error("[mandalo] finalizePedidoRetention falló tras entrega", {
          pedidoId: parseResult.pedidoId,
          message: getErrorMessage(e),
        });
      });
  }
  return { ok: true, role: "repartidor", accion: "completado", ordenId: parseResult.pedidoId };
}

export async function processMandaloWebhook(incoming: IncomingWhatsAppMessage): Promise<JsonObject> {
  // Backdoor admin: RESET_BOT <NUMERO_TELEFONO>
  const bodyTextRaw = String(incoming.body ?? "");
  if (await isAdminSender(incoming.from)) {
    const m = bodyTextRaw.match(/^\s*RESET_BOT\s+([0-9+\-\s]{8,})\s*$/i);
    if (m?.[1]) {
      const target = normalizePhone(m[1]);
      const openPedido = await pedidoRepositoryV2.getOpenPedidoByCustomerPhone(target).catch(() => null);
      if (openPedido && !isTerminalState(openPedido.estado)) {
        await cancelOpenPedido(openPedido, target, "reset_bot_admin").catch(() => {});
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
