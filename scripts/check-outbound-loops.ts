/**
 * Auditoría offline de bucles y de los textos fijos.
 * Sin OpenAI, sin secretos y sin base.
 * Correr: npx tsx scripts/check-outbound-loops.ts
 */
import {
  LIVE_LOCATION_REPLY,
  TEXT_ONLY_REPLY,
  WEBHOOK_PROCESS_ERROR_REPLY,
  classifyInbound,
} from "../src/lib/inboundMessage";
import { ADDRESS_ASK_MESSAGE } from "../src/lib/services/captureEngine";
import {
  customerFlowFallback,
  outboundDecision,
  recordOutbound,
  resetOutboundGuard,
  wasRecentlySent,
} from "../src/lib/outboundGuard";
import { classifyRoleChatter, isBotInstructionPaste, isOwnOutboundCopy, planStoreFreeText } from "../src/lib/reliability";
import { extraerComandoNoDisponible, extraerPrecio, MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "../src/lib/ordenes";
import { COURIER_COMMAND_HELP, isExactCourierCommand } from "../src/lib/services/courierCommandParser";
import { buildCourierOfferMessage } from "../src/lib/services/courierAvailability";
import { canTransition } from "../src/lib/orderStateMachine";
import { formatShortEditHelp } from "../src/lib/categoryCopy";
import {
  ABARROTES_PRODUCT_REQUEST,
  buildGreeting,
  formatAbarrotesStoreAck,
  formatCatalogMenuCaption,
  formatCustomerFeeLine,
  formatCustomerQuoteMessage,
  formatNoCourierCustomer,
  formatStoreCommandHelp,
  type UxStore,
} from "../src/lib/customerUx";
import {
  cartSwitchQuestion,
  routeCustomerFlow,
  type CustomerFlowPhase,
  type CustomerMedia,
} from "../src/lib/flowRouter";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const pekes: UxStore = {
  id: 7,
  nombre: "Mini Super Peke's",
  categoria: "Abarrotes",
  telefono: "5213377777777",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const george: UxStore = {
  id: 8,
  nombre: "Hamburguesas Hotdogs George",
  categoria: "Restaurante",
  telefono: "5213388888888",
  abierta: false,
  abreTexto: "abre mañana a las 7pm",
  horarioTexto: "7pm a 9pm",
  usaCatalogoFijo: true,
};
const central: UxStore = {
  id: 11,
  nombre: "Carnicería La Central",
  categoria: "Carnicerías",
  telefono: "5213399999999",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: true,
};
const stores = [pekes, george, central];
const now = 1_760_568_000_000;
const customer = "5213300000101";
const storePhone = "5213300000102";
const driverPhone = "5213300000103";
const adminPhone = "5213300000104";

function customerDecision(message: string, phase: CustomerFlowPhase, extra?: { media?: CustomerMedia; store?: UxStore | null; items?: Array<{ nombre_producto: string; cantidad: number }>; lastBot?: string }) {
  return routeCustomerFlow({
    message,
    phase,
    nicheId: phase === "tienda" ? "abarrotes" : null,
    store: extra?.store === undefined ? (phase === "categoria" || phase === "tienda" ? null : pekes) : extra.store,
    stores,
    items: extra?.items ?? (phase === "pedido" || phase === "resumen" ? [{ nombre_producto: "Coca-Cola 600 ml", cantidad: 2 }] : []),
    lastBotText: extra?.lastBot ?? "",
    awaitingProductConfirm: false,
    media: extra?.media ?? "text",
    locationInsideCoverage: null,
    orderId: 12,
  });
}

function replyFor(role: "cliente" | "tienda" | "repartidor", text: string, phase: CustomerFlowPhase): string | null {
  if (role !== "cliente" && classifyRoleChatter(text) !== "message") return null;
  if (isOwnOutboundCopy(text)) return null;
  if (role === "tienda") {
    const plan = planStoreFreeText({ text, openOrderIds: [12] });
    if (plan.action !== "guide") return null;
    return plan.body;
  }
  if (role === "repartidor") {
    if (isExactCourierCommand(text)) return "✅ *Aceptación registrada*\n\nPedido *#12*.";
    return COURIER_COMMAND_HELP;
  }
  const decision = customerDecision(text, phase);
  if (decision.effect === "fallthrough" || !decision.text.trim()) return null;
  return decision.text;
}

function burst(phone: string, role: "cliente" | "tienda" | "repartidor", inboundOf: (round: number, lastBot: string) => string, rounds: number, phase: CustomerFlowPhase, seed: string | null): number {
  let sends = 0;
  let lastBot = seed ?? "";
  if (seed) recordOutbound(phone, seed, now);
  for (let round = 0; round < rounds; round += 1) {
    const inbound = inboundOf(round, lastBot);
    if (wasRecentlySent(phone, inbound, now)) continue;
    const reply = replyFor(role, inbound, phase);
    if (!reply) continue;
    if (outboundDecision(phone, reply, now) !== "send") continue;
    recordOutbound(phone, reply, now);
    lastBot = reply;
    sends += 1;
  }
  return sends;
}

resetOutboundGuard();
const noise = [
  { from_me: true, type: "text", text: { body: "eco propio" } },
  { type: "unknown", source: "system", from_me: false },
  { type: "reaction", reaction: { emoji: "👍" } },
  { type: "receipt" },
  { type: "call" },
  { type: "call_log" },
  { type: "edit", text: { body: "corregido" } },
  { type: "deleted" },
  { type: "revoked" },
  { type: "protocol", subtype: "message_edit" },
];
let noiseSends = 0;
for (const message of noise) {
  const inbound = classifyInbound({
    messages: [{ id: String(message.type), from: customer, chat_id: `${customer}@s.whatsapp.net`, ...message }],
    event: { type: "messages", event: "post" },
  });
  if (inbound.kind !== "ignore") noiseSends += 1;
}
const chats = [
  `${customer}@g.us`,
  "status@broadcast",
  "120363000000000000@newsletter",
  "5213300000199@broadcast",
];
for (const chatId of chats) {
  const inbound = classifyInbound({
    messages: [{ id: chatId, from: customer, chat_id: chatId, from_me: false, type: "text", text: { body: "hola grupo" } }],
  });
  assert(inbound.kind === "ignore", `${chatId} no se contesta`);
}
const statusEvent = classifyInbound({
  event: { type: "statuses", event: "post" },
  statuses: [{ id: "s1", status: "delivered" }],
});
assert(statusEvent.kind === "ignore", "un acuse con event objeto no es un mensaje");
assert(noiseSends === 0, "from_me, system, reacción, recibo, llamada, edición y borrado no se contestan");

const systemBurst = Array.from({ length: 5 }, (_, index) =>
  classifyInbound({
    messages: [
      {
        id: `sys-${index}`,
        from_me: false,
        type: "unknown",
        source: "system",
        from: customer,
        chat_id: `${customer}@s.whatsapp.net`,
      },
    ],
  }),
);
assert(systemBurst.every((item) => item.kind === "ignore"), "cinco eventos system unknown se ignoran");

resetOutboundGuard();
const greeting = buildGreeting();
assert(burst(customer, "cliente", () => greeting, 20, "categoria", greeting) === 0, "un cliente que repite el saludo del bot no genera otra salida");
assert(burst(storePhone, "tienda", (_round, last) => last, 20, "categoria", formatStoreCommandHelp([12])) === 0, "la tienda que hace eco del aviso no se cotiza ni se re-pregunta");
assert(
  burst(driverPhone, "repartidor", (_round, last) => last, 20, "categoria", buildCourierOfferMessage({
    courierName: "Mateo",
    pedidoId: 12,
    storeName: pekes.nombre,
    pickupAddress: "Calle Hidalgo 20",
    dropoffAddress: "Calle Morelos 8",
    mapsLink: null,
    itemsText: "2 Coca-Cola 600 ml",
    chargeLine: "Cobrar: $80",
    customerPhone: customer,
  })) === 0,
  "el repartidor que hace eco de la oferta no manda #CONFIRMO solo",
);

resetOutboundGuard();
assert(burst(storePhone, "tienda", () => "ok", 20, "categoria", null) === 0, "la tienda que contesta ok no recibe otra guía");
assert(burst(driverPhone, "repartidor", () => "recibido", 20, "categoria", null) === 0, "el repartidor que contesta recibido no recibe el comando otra vez");
assert(burst(storePhone, "tienda", () => "no tengo la coca de 600", 20, "categoria", null) === 1, "un texto de la tienda que no es precio recibe la guía una vez");
assert(burst(driverPhone, "repartidor", () => "no puedo salir hoy", 20, "categoria", null) === 1, "un texto del repartidor que no es comando recibe la ayuda una vez");
assert(burst(adminPhone, "cliente", () => "ok", 20, "categoria", null) === 1, "un admin que escribe ok, como cliente, no se queda en ping-pong");
assert(burst(customer, "cliente", (round) => `ruido ${round}`, 20, "categoria", null) === 1, "veinte ruidos distintos en el menú solo repregunta una vez");
resetOutboundGuard();
assert(burst(storePhone, "tienda", (round) => `ruido tienda ${round}`, 20, "categoria", null) === 1, "la tienda con textos distintos no recibe la guía en bucle");
resetOutboundGuard();
assert(burst(driverPhone, "repartidor", (round) => `ruido repa ${round}`, 20, "categoria", null) === 1, "el repartidor con textos distintos no recibe el comando en bucle");

function freshSends(phone: string, role: "cliente" | "tienda" | "repartidor", inbound: string, phase: CustomerFlowPhase): number {
  let sends = 0;
  for (let round = 0; round < 20; round += 1) {
    resetOutboundGuard();
    if (wasRecentlySent(phone, inbound, now)) continue;
    const reply = replyFor(role, inbound, phase);
    if (!reply) continue;
    if (outboundDecision(phone, reply, now) !== "send") continue;
    sends += 1;
  }
  return sends;
}
assert(freshSends(storePhone, "tienda", formatStoreCommandHelp([12]), "categoria") === 0, "un proceso nuevo tampoco contesta el eco de la guía");
assert(freshSends(customer, "cliente", greeting, "categoria") === 0, "un proceso nuevo tampoco contesta el eco del saludo");
assert(freshSends(storePhone, "tienda", "ok", "categoria") === 0, "un acuse suelto de la tienda no arranca un ida y vuelta");

resetOutboundGuard();
const reminder =
  "⏰ *Recordatorio*\n\nEl pedido #12 sigue esperando tu precio.\n\n*Responde así:*\nORDEN #12 PRECIO 150\n\n¿Te falta algún producto?\n\n*Responde:*\nORDEN #12 NO_DISPONIBLE nombre del producto";
const quoteNotice =
  "🏪 *Cotizar. ORDEN #12*\n\n*Responde así:*\nORDEN #12 PRECIO 150\n\n¿Te falta algún producto?\n\n*Responde:*\nORDEN #12 NO_DISPONIBLE nombre del producto";
assert(isBotInstructionPaste(reminder) && isBotInstructionPaste(quoteNotice), "el aviso a la tienda se reconoce como instrucción nuestra");
assert(extraerPrecio(quoteNotice) === 150, "sin el filtro, el ejemplo del aviso se leería como precio 150");
assert(extraerComandoNoDisponible(quoteNotice)?.productoTexto.toLowerCase().includes("nombre del producto") === true, "sin el filtro, el ejemplo se leería como faltante");
assert(classifyRoleChatter(reminder) === "echo" && classifyRoleChatter(quoteNotice) === "echo", "el aviso a la tienda no se procesa como comando");
assert(planStoreFreeText({ text: reminder, openOrderIds: [12] }).action === "ignore", "el recordatorio no se cobra como precio 150");
assert(planStoreFreeText({ text: quoteNotice, openOrderIds: [12] }).action === "ignore", "el aviso de cotizar no se cobra como precio 150");
const realQuote = planStoreFreeText({ text: "ORDEN #12 PRECIO 80", openOrderIds: [12] });
assert(realQuote.action === "price" && realQuote.amount === 80, "una cotización real de la tienda sí entra");
assert(!isExactCourierCommand(buildCourierOfferMessage({
  courierName: "Roberto",
  pedidoId: 12,
  storeName: george.nombre,
  pickupAddress: "Centro",
  dropoffAddress: "Calle Hidalgo 12",
  mapsLink: null,
  itemsText: "1 hamburguesa",
  chargeLine: null,
  customerPhone: customer,
})), "la oferta completa no es un #CONFIRMO");
assert(isExactCourierCommand("#CONFIRMO 12"), "#CONFIRMO 12 sigue siendo el comando");

resetOutboundGuard();
const live = customerDecision("", "ubicacion", { media: "live_location" });
const liveAgain = customerDecision("", "ubicacion", { media: "live_location" });
assert(live.text.includes(LIVE_LOCATION_REPLY) && live.text === liveAgain.text, "la ubicación en tiempo real pide el pin o la dirección, y el texto no cambia");
assert(outboundDecision(customer, live.text, now) === "send", "la primera ubicación en tiempo real sí se contesta");
recordOutbound(customer, live.text, now);
assert(outboundDecision(customer, liveAgain.text, now + 1000) === "duplicate", "la segunda ubicación en tiempo real no repite el aviso");
const audio = customerDecision("", "pedido", { media: "audio" });
const image = customerDecision("", "pedido", { media: "image" });
assert(audio.text.includes(TEXT_ONLY_REPLY), "el audio pide solo texto");
assert(image.text.includes("Escríbeme tu pedido") && !image.text.includes(TEXT_ONLY_REPLY), "la imagen a media orden pide el pedido por escrito");
const stickerIdle = customerDecision("", "categoria", { media: "sticker", store: null, items: [] });
assert(stickerIdle.action === "ignore" && stickerIdle.text === "", "un sticker fuera del pedido no se contesta");
assert(outboundDecision("5213300000191", audio.text, now) === "send", "el primer audio sí se contesta");
recordOutbound("5213300000191", audio.text, now);
assert(outboundDecision("5213300000191", audio.text, now + 1000) === "duplicate", "el segundo audio no repite el aviso");

resetOutboundGuard();
assert(outboundDecision(customer, WEBHOOK_PROCESS_ERROR_REPLY, now) === "send", "el aviso de error sale la primera vez");
recordOutbound(customer, WEBHOOK_PROCESS_ERROR_REPLY, now);
assert(outboundDecision(customer, WEBHOOK_PROCESS_ERROR_REPLY, now + 1000) === "duplicate", "el aviso de error sale una vez");
const listAgain = "OK, pediste:\n\n🛒 *Tu pedido*\n\n*¿Están bien estos productos?*";
const listFallback = customerFlowFallback(listAgain);
assert(listFallback != null && listFallback !== listAgain && listFallback.includes("sí"), "una lista repetida se vuelve a pedir con otro texto");
assert(customerFlowFallback(listFallback ?? "") === null, "el aviso distinto sale una sola vez");
const genericFallback = customerFlowFallback("Va, de Mini Super Peke's.");
assert(genericFallback != null && genericFallback !== "Va, de Mini Super Peke's." && genericFallback.includes("Aquí sigo"), "un texto de cliente repetido no se queda en silencio");
assert(customerFlowFallback(genericFallback ?? "") === null, "el aquí sigo sale una sola vez");
const brandAsk = "Va. La leche, ¿de qué marca y entera, deslactosada o light?";
const brandFallback = customerFlowFallback(brandAsk);
assert(brandFallback != null && brandFallback !== brandAsk && /marca|tamaño|número/.test(brandFallback), "una pregunta repetida no se queda en silencio");
const pinFallback = customerFlowFallback(ADDRESS_ASK_MESSAGE);
assert(pinFallback != null && pinFallback !== ADDRESS_ASK_MESSAGE && pinFallback.includes("pin"), "la ubicación repetida pide el pin con otras palabras");

const phases: CustomerFlowPhase[] = ["categoria", "tienda", "ejemplo", "pedido", "ubicacion", "resumen", "esperando_tienda", "esperando_repartidor", "precio"];
for (const phase of phases) {
  const cancel = customerDecision("ya no", phase, { store: phase === "categoria" || phase === "tienda" ? null : pekes });
  assert(cancel.action === "confirm_cancel" && cancel.text.includes("¿Quieres cancelar el pedido?"), `${phase}: ya no pregunta si quiere cancelar`);
  assert(!cancel.text.includes("undefined") && !cancel.text.includes("NaN") && !cancel.text.includes("[object Object]"), `${phase}: el aviso de cancelar no trae basura`);
}
const switchAsk = cartSwitchQuestion(pekes.nombre, [{ nombre_producto: "Coca-Cola 600 ml", cantidad: 2 }], george.nombre);
resetOutboundGuard();
recordOutbound(customer, switchAsk, now);
assert(wasRecentlySent(customer, switchAsk, now), "la pregunta de cambiar tienda es un mensaje nuestro");
const stay = customerDecision("no", "pedido", { lastBot: switchAsk });
assert(stay.action === "reprompt" && stay.clearCart === false, "no a cambiar de tienda deja el pedido");
const move = customerDecision("sí", "pedido", { lastBot: switchAsk });
assert(move.action === "switch_store" && move.clearCart === true, "sí a cambiar de tienda suelta el carrito una vez");

const closed = customerDecision("George", "categoria", { store: null, items: [] });
assert(closed.action === "switch_store" && closed.text.includes("cerrada") && closed.text.includes("Horario: 7pm a 9pm") && closed.text.includes("se programa"), "George cerrado se arma, dice su horario y se programa");
assert(canTransition("confirmacion_cliente", "esperando_apertura_tienda"), "un pedido confirmado con tienda cerrada puede esperar la apertura");
assert(canTransition("esperando_apertura_tienda", "pendiente_tiendas"), "al abrir, el pedido pasa a la tienda");
assert(canTransition("esperando_apertura_tienda", "cancelado"), "mientras espera la apertura se puede cancelar");

assert(ADDRESS_ASK_MESSAGE.includes("ubicación") && /escribirme tu dirección/i.test(ADDRESS_ASK_MESSAGE), "la dirección vale por pin o por escrito");
assert(LIVE_LOCATION_REPLY.includes("tiempo real") && LIVE_LOCATION_REPLY.includes("ubicación actual"), "la ubicación en tiempo real se rechaza");
assert(ABARROTES_PRODUCT_REQUEST.includes("Solo es un ejemplo, no está en tu pedido"), "el ejemplo de abarrotes no se presenta como pedido");
for (const kind of ["abarrotes", "restaurante", "carniceria"] as const) {
  assert(formatShortEditHelp(kind).includes("Solo es un ejemplo, no está en tu pedido"), `${kind}: la ayuda marca el ejemplo`);
}
assert(MANDALO_SERVICE_FEE === 10 && MANDALO_DELIVERY_FEE === 15, "el cargo es $15 de envío y $10 de servicio");
const feeLine = formatCustomerFeeLine();
assert(feeLine.includes("🛵 *Envío: $15*") && feeLine.includes("servicio $10"), "la línea del cliente separa envío y servicio");
assert(!feeLine.includes("$35") && !feeLine.includes("$25") && !feeLine.includes("$20"), "la línea no trae la tarifa vieja");
const quote = formatCustomerQuoteMessage({ tiendaNombre: central.nombre, pedidoId: 12, subtotal: 80, total: 105, itemLines: ["1 kg de bistec"] });
assert(quote.includes("🛵 *Envío: $15*") && quote.includes("servicio $10") && quote.includes("$105"), "el total de la tienda suma envío y servicio");
assert(formatNoCourierCustomer(12).includes("no hay repartidor") && !formatNoCourierCustomer(12).includes("$25"), "sin repartidor no reaparece el $25");
const pekesAck = formatAbarrotesStoreAck(pekes);
const georgeMenu = formatCatalogMenuCaption(george);
const fixed = [greeting, pekesAck, georgeMenu, quote, ADDRESS_ASK_MESSAGE, LIVE_LOCATION_REPLY, TEXT_ONLY_REPLY, WEBHOOK_PROCESS_ERROR_REPLY, switchAsk, COURIER_COMMAND_HELP];
for (const text of fixed) {
  assert(!text.includes("undefined") && !text.includes("NaN") && !text.includes("[object Object]"), "un texto fijo trae un placeholder");
  assert(!/\$25\b/.test(text) && !/\$20\b/.test(text), "un texto fijo trae $20 o $25");
}
assert(!pekesAck.includes("Envío: $15") && !pekesAck.includes("servicio $10") && pekesAck.includes("Solo es un ejemplo"), "Peke's no cobra al saludar y marca el ejemplo");
assert(georgeMenu.includes("cerrada") && georgeMenu.includes("Horario: 7pm a 9pm") && georgeMenu.includes("se programa") && !georgeMenu.includes("Envío: $15") && !georgeMenu.includes("servicio $10"), "George cerrado avisa horario y se programa, sin cobrar todavía");

console.log("check-outbound-loops: ok");
