/**
 * Matriz offline del flujo del cliente. Sin OpenAI, sin secretos y sin base.
 * Correr: npx tsx scripts/check-flow-router.ts
 */
import { readFileSync } from "node:fs";
import {
  buildGreeting,
  classifyCustomerTurn,
  formatAbarrotesStoreAck,
  formatCatalogMenuCaption,
  formatNicheStoreList,
  nicheById,
  type UxStore,
} from "../src/lib/customerUx";
import {
  cartSwitchQuestion,
  pendingSwitchTarget,
  routeCustomerFlow,
  storeWelcomeMatchesMenu,
  type CustomerFlowPhase,
  type CustomerMedia,
  type FlowDecision,
  type FlowRouteInput,
} from "../src/lib/flowRouter";
import { isCancelIntent, isConversationModeMessage, isNewOrderIntent } from "../src/lib/messages";
import { gateGeneralBot, phaseForUxTurn } from "../src/lib/orderSession";
import { classifyInbound, LIVE_LOCATION_REPLY, TEXT_ONLY_REPLY } from "../src/lib/inboundMessage";
import {
  outboundDecision,
  OUTBOUND_MAX_PER_MINUTE,
  OUTBOUND_WINDOW_MS,
  recordOutbound,
  releaseOutbound,
  resetOutboundGuard,
} from "../src/lib/outboundGuard";
import { runOrderAgentTurn, type AgentModel, type AgentStore, type ToolCall } from "../src/lib/orderAgent";
import { waapiSendImage, waapiSendTextRequest } from "../src/lib/waapi";
import { matchCoverageZone, validateAddress } from "../src/lib/services/validationEngine";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const zagu: UxStore = {
  id: 1,
  nombre: "ZAGU",
  categoria: "Abarrotes",
  telefono: "5213311111111",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const pekes: UxStore = {
  id: 7,
  nombre: "Mini Super Peke's",
  categoria: "Abarrotes",
  telefono: "5213377777777",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const agua: UxStore = {
  id: 2,
  nombre: "Abarrotes Agua Santa",
  categoria: "Abarrotes",
  telefono: "5213322222222",
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
const stores = [zagu, pekes, agua, george, central];
const abarrotesList = formatNicheStoreList(nicheById("abarrotes")!, stores);
const greeting = buildGreeting();
const pekesWelcome = formatAbarrotesStoreAck(pekes);
const georgeWelcome = formatCatalogMenuCaption(george);
const centralWelcome = formatCatalogMenuCaption(central);

type Expect = {
  action: FlowDecision["action"];
  phase: CustomerFlowPhase;
  includes?: string[];
  exactWelcome?: UxStore;
  storeId?: number | null;
  clearCart?: boolean;
  agent?: boolean;
};

type Scenario = {
  id: string;
  phase: CustomerFlowPhase;
  message: string;
  store?: UxStore | null;
  nicheId?: string | null;
  items?: Array<{ nombre_producto: string; cantidad: number }>;
  media?: CustomerMedia;
  coverage?: boolean | null;
  coords?: boolean;
  awaiting?: boolean;
  lastBot?: string;
  orderId?: number | null;
  expect: Expect;
};

const coke = [{ nombre_producto: "Coca-Cola 600 ml", cantidad: 2 }];

function base(partial: Omit<Scenario, "expect"> & { expect: Expect }): Scenario {
  return partial;
}

const phases: CustomerFlowPhase[] = [
  "categoria",
  "tienda",
  "ejemplo",
  "pedido",
  "ubicacion",
  "resumen",
  "esperando_tienda",
  "esperando_repartidor",
  "entregado",
  "precio",
];

function storeFor(phase: CustomerFlowPhase): UxStore | null {
  if (phase === "categoria" || phase === "entregado" || phase === "tienda") return null;
  return pekes;
}

function nicheFor(phase: CustomerFlowPhase): string | null {
  if (phase === "tienda") return "abarrotes";
  if (phase === "categoria" || phase === "entregado") return null;
  return "abarrotes";
}

function hasOpenCart(phase: CustomerFlowPhase): boolean {
  return Boolean(storeFor(phase) && itemsFor(phase).length > 0);
}

function itemsFor(phase: CustomerFlowPhase) {
  if (phase === "pedido" || phase === "ubicacion" || phase === "resumen" || phase === "precio" || phase === "esperando_tienda" || phase === "esperando_repartidor") {
    return coke;
  }
  return [];
}

const scenarios: Scenario[] = [];

function add(id: string, phase: CustomerFlowPhase, message: string, expect: Expect, extra?: Partial<Scenario>) {
  scenarios.push(
    base({
      id: `${phase}: ${id}`,
      phase,
      message,
      store: extra?.store === undefined ? storeFor(phase) : extra.store,
      nicheId: extra?.nicheId === undefined ? nicheFor(phase) : extra.nicheId,
      items: extra?.items === undefined ? itemsFor(phase) : extra.items,
      media: extra?.media ?? "text",
      coverage: extra?.coverage ?? null,
      coords: extra?.coords,
      awaiting: extra?.awaiting ?? false,
      lastBot: extra?.lastBot ?? (phase === "tienda" ? abarrotesList : ""),
      orderId: extra?.orderId ?? (phase === "categoria" || phase === "entregado" ? null : 90),
      expect,
    }),
  );
}

for (const phase of phases) {
  const locked = phase === "esperando_repartidor" || phase === "esperando_tienda" || phase === "precio";
  add("mejor de George", phase, "mejor de George", locked
    ? { action: "tracking", phase, includes: ["pedido nuevo"] }
    : hasOpenCart(phase)
      ? { action: "confirm_switch", phase, clearCart: false, storeId: null, includes: ["Ya tienes un pedido en", "Coca-Cola", "¿Quieres borrarlo para pedir de Hamburguesas Hotdogs George?"] }
      : { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, clearCart: false });
  add("Penes", phase, "Penes", locked
    ? { action: "tracking", phase, includes: ["pedido nuevo"] }
    : {
        action: "switch_store",
        phase: "ejemplo",
        exactWelcome: pekes,
        storeId: pekes.id,
        clearCart: Boolean(storeFor(phase) && storeFor(phase)?.id !== pekes.id && itemsFor(phase).length > 0),
      });
  add("cambiar tienda", phase, "cambiar tienda", locked
    ? { action: "tracking", phase }
    : phase === "categoria" || phase === "entregado"
      ? { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"] }
      : hasOpenCart(phase)
        ? { action: "confirm_switch", phase, clearCart: false, storeId: null, includes: ["Ya tienes un pedido en", "otra tienda"] }
        : { action: "show_niche", phase: "tienda", includes: ["¿De cuál te hago el mandado?"] });
  add("quiero de otra tienda", phase, "quiero de otra tienda", locked
    ? { action: "tracking", phase }
    : phase === "categoria" || phase === "entregado"
      ? { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"] }
      : hasOpenCart(phase)
        ? { action: "confirm_switch", phase, clearCart: false, includes: ["¿Quieres borrarlo para pedir de otra tienda?"] }
        : { action: "show_niche", phase: "tienda", includes: ["Abarrotes"] });
  add("hola", phase, "hola", phase === "categoria" || phase === "entregado"
    ? { action: "greeting", phase: "categoria", includes: ["¿De dónde quieres?"] }
    : { action: "greeting", phase });
  add("buenas", phase, "buenas", phase === "categoria" || phase === "entregado"
    ? { action: "greeting", phase: "categoria", includes: ["Abarrotes"] }
    : { action: "greeting", phase });
  add("pedido nuevo", phase, "pedido nuevo", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase, includes: ["no puedo cancelarlo"] }
    : { action: "restart", phase: "categoria", includes: ["Pedido anterior cancelado", "¿De dónde quieres?"] });
  add("empezar de nuevo", phase, "empezar de nuevo", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "restart", phase: "categoria", includes: ["¿De dónde quieres?"] });
  add("inicio", phase, "inicio", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "restart", phase: "categoria", includes: ["¿De dónde quieres?"] });
  add("menú", phase, "menú", locked
    ? { action: "tracking", phase }
    : phase === "categoria" || phase === "entregado"
      ? { action: "greeting", phase: "categoria", includes: ["¿De dónde quieres?"] }
      : phase === "tienda"
        ? { action: "show_niche", phase: "tienda", includes: ["¿De cuál te hago el mandado?"] }
        : { action: "reprompt", phase: itemsFor(phase).length ? phase : "ejemplo", exactWelcome: pekes });
  add("volver", phase, "volver", phase === "esperando_repartidor" || phase === "esperando_tienda" || phase === "precio"
    ? { action: "tracking", phase }
    : phase === "entregado"
      ? { action: "greeting", phase: "categoria" }
      : phase === "categoria" || phase === "tienda"
        ? { action: "back", phase: "categoria", includes: ["¿De dónde quieres?"] }
        : phase === "ejemplo"
          ? { action: "show_niche", phase: "tienda", includes: ["¿De cuál te hago el mandado?"] }
          : { action: "back", phase: itemsFor(phase).length ? "pedido" : "ejemplo", includes: ["Peke"] });
  add("atrás", phase, "atrás", phase === "esperando_repartidor" || phase === "esperando_tienda" || phase === "precio"
    ? { action: "tracking", phase }
    : phase === "entregado"
      ? { action: "greeting", phase: "categoria" }
      : { action: phase === "categoria" || phase === "tienda" ? "back" : phase === "ejemplo" ? "show_niche" : "back", phase: phase === "categoria" || phase === "tienda" ? "categoria" : phase === "ejemplo" ? "tienda" : itemsFor(phase).length ? "pedido" : "ejemplo" });
  add("cancela", phase, "cancela", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "cancel", phase: "categoria", includes: ["cancelé", "¿De dónde quieres?"] });
  add("ya no", phase, "ya no", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "cancel", phase: "categoria", includes: ["cancelé"] });
  add("olvídalo", phase, "olvídalo", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "cancel", phase: "categoria" });
  add("no quiero nada", phase, "no quiero nada", phase === "esperando_repartidor"
    ? { action: "escalate_cancel", phase }
    : { action: "cancel", phase: "categoria" });
  add("cuánto cuesta el envío", phase, "cuánto cuesta el envío", {
    action: "answer",
    phase: phase === "entregado" ? "categoria" : phase,
    includes: ["$35"],
  });
  add("a qué hora abren", phase, "a qué hora abren", {
    action: "answer",
    phase: phase === "entregado" ? "categoria" : phase,
    includes: ["8am", "9pm"],
  });
  add("tienen coca?", phase, "tienen coca?", {
    action: "answer",
    phase: phase === "entregado" ? "categoria" : phase,
    includes: phase === "categoria" || phase === "tienda" || phase === "entregado" ? ["elige la tienda"] : ["Peke"],
  });
  add("emoji", phase, "👍", {
    action: "reprompt",
    phase: phase === "entregado" ? "categoria" : phase,
    includes: ["emoji"],
  });
  add("número suelto", phase, "4", phase === "categoria" || phase === "entregado"
    ? { action: "reprompt", phase: "categoria", includes: ["no está"] }
    : phase === "tienda"
      ? { action: "reprompt", phase: "tienda", includes: ["no está"] }
      : { action: "reprompt", phase, includes: ["número"] });
  add("sticker", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "sticker" });
  add("imagen", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "image" });
  add("audio", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "audio" });
  add("video", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "video" });
  add("documento", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "document" });
  add("contacto", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "contact" });
  add("adjunto raro", phase, "", { action: "media", phase, includes: [TEXT_ONLY_REPLY] }, { media: "unsupported" });
  add("live", phase, "", { action: "live_location", phase, includes: [LIVE_LOCATION_REPLY] }, { media: "live_location" });
  add("pin temprano", phase, "", phase === "ubicacion" || phase === "resumen" || phase === "precio"
    ? { action: "summary", phase }
    : { action: "location_early", phase: phase === "entregado" ? "categoria" : phase, includes: ["pin", "dirección escrita"] }, { media: "location", coverage: true });
}

add("número 1 categoría", "categoria", "1", { action: "show_niche", phase: "tienda", includes: ["Abarrotes", "¿De cuál te hago el mandado?"] }, { store: null, nicheId: null, items: [] });
add("número 2 abarrotes", "tienda", "2", { action: "switch_store", phase: "ejemplo", exactWelcome: pekes, storeId: pekes.id, clearCart: false }, { store: null, nicheId: "abarrotes", items: [], lastBot: abarrotesList });
add("número 1 restaurantes cerrado", "tienda", "1", { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, includes: ["cerrada"] }, { store: null, nicheId: "restaurantes", items: [], lastBot: formatNicheStoreList(nicheById("restaurantes")!, stores) });
add("typo abarotes", "categoria", "abarotes", { action: "show_niche", phase: "tienda", includes: ["Abarrotes"] }, { store: null, items: [] });
add("typo restorantes", "categoria", "restorantes", { action: "show_niche", phase: "tienda", includes: ["George"] }, { store: null, items: [] });
add("typo carniseria", "pedido", "carniseria", { action: "disambiguate", phase: "pedido", clearCart: false, storeId: null, includes: ["Primero terminamos tu pedido de Mini Super Peke's", "Carnicerías"] });
add("typo hamburgesas", "categoria", "hamburgesas", { action: "show_niche", phase: "tienda", includes: ["George"] }, { store: null, items: [] });
add("pedido antes de tienda", "categoria", "quiero 2 cocas", { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"], agent: false }, { store: null, items: [] });
add("pedido en ejemplo", "ejemplo", "quiero 2 cocas", { action: "agent", phase: "pedido", agent: true }, { store: pekes, items: [] });
add("segundo mensaje", "pedido", "y un pinol de 1 litro", { action: "agent", phase: "pedido", agent: true });
add("hamburguesa en abarrotes", "pedido", "una hamburguesa", { action: "agent", phase: "pedido", agent: true, storeId: null });
add("producto de otra tienda", "pedido", "mejor de la central un kilo de bistec", {
  action: "confirm_switch",
  phase: "pedido",
  clearCart: false,
  storeId: null,
  includes: ["Ya tienes un pedido en Mini Super Peke's", "¿Quieres borrarlo para pedir de Carnicería La Central?"],
});
add("dos tiendas", "pedido", "de pekes y de george", {
  action: "disambiguate",
  phase: "pedido",
  clearCart: false,
  includes: ["Primero terminamos tu pedido de Mini Super Peke's", "Hamburguesas Hotdogs George"],
});
add("dos tiendas sin elegir", "categoria", "de pekes y de george", {
  action: "disambiguate",
  phase: "categoria",
  storeId: null,
  includes: ["¿Con cuál empezamos?", "Peke", "George"],
}, { store: null, items: [] });
add("dos categorías sin tienda", "categoria", "abarrotes y carnicería", {
  action: "disambiguate",
  phase: "categoria",
  storeId: null,
  includes: ["¿Con cuál empezamos?", "Abarrotes", "Carnicerías"],
}, { store: null, items: [] });
add("otra categoría a medias", "pedido", "quiero de carnicería", {
  action: "disambiguate",
  phase: "pedido",
  clearCart: false,
  storeId: null,
  includes: ["Primero terminamos tu pedido de Mini Super Peke's", "Carnicerías"],
});
add("mensaje largo sin tienda", "categoria", `${"quiero muchas cocas ".repeat(40)}por favor`, { action: "reprompt", phase: "categoria", includes: ["largo"], agent: false }, { store: null, items: [] });
add("mensaje largo con tienda", "pedido", `${"coca cola 600 ".repeat(40)}`, { action: "agent", phase: "pedido", agent: true });
add("dirección escrita en pin", "ubicacion", "calle hidalgo 12 frente a la tortillería", { action: "accept_address", phase: "resumen", includes: ["hidalgo", "Anoté tu dirección"] });
add("dirección escrita en resumen", "resumen", "calle morelos 8", { action: "accept_address", phase: "resumen", includes: ["morelos"] });
add("dirección escrita en pedido", "pedido", "mi dirección es calle morelos 8", { action: "reprompt", phase: "pedido", includes: ["escribirla", "pin de WhatsApp"] });
add("pin sin coordenadas", "ubicacion", "", { action: "location_early", phase: "ubicacion", includes: ["escribe tu dirección"] }, { media: "location", coverage: null, coords: false });
add("pin fuera de zona", "categoria", "", { action: "location_reject", phase: "categoria", includes: ["fuera de esa zona"] }, { media: "location", coverage: false, store: null, items: [] });
add("sí resumen", "resumen", "sí", { action: "summary", phase: "resumen" });
add("si así está bien", "resumen", "si así está bien", { action: "summary", phase: "resumen" });
add("ok resumen", "resumen", "ok", { action: "summary", phase: "resumen" });
add("va resumen", "resumen", "va", { action: "summary", phase: "resumen" });
add("correcto resumen", "resumen", "correcto", { action: "summary", phase: "resumen" });
add("no resumen", "resumen", "no", { action: "summary", phase: "resumen" });
add("falta algo", "resumen", "falta algo", { action: "summary", phase: "resumen" });
add("quita coca", "pedido", "quita la coca", { action: "agent", phase: "pedido", agent: true });
add("no pedí coca", "pedido", "no pedí la coca", { action: "agent", phase: "pedido", agent: true });
add("cambia coca por pepsi", "pedido", "cambia la coca por pepsi", { action: "agent", phase: "pedido", agent: true });
add("agrega", "pedido", "agrega un pinol", { action: "agent", phase: "pedido", agent: true });
add("son 3 no 2", "pedido", "son 3 no 2", { action: "agent", phase: "pedido", agent: true });
add("mejor grande", "pedido", "mejor grande", { action: "agent", phase: "pedido", agent: true });
add("editar sin pedido", "categoria", "quita la coca", { action: "reprompt", phase: "categoria", agent: false }, { store: null, items: [] });
add("timeout luego texto", "categoria", "quiero unas papas", { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"], agent: false }, { store: null, items: [], lastBot: `Se canceló porque la tienda no respondió.\n\n${greeting}` });
add("después de entregado", "entregado", "gracias", { action: "greeting", phase: "categoria", includes: ["entregó", "¿De dónde quieres?"] }, { store: null, items: [] });
add("Gorge suelto", "categoria", "Gorge", { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, includes: ["cerrada"] }, { store: null, items: [] });
add("misma tienda por nombre", "ejemplo", "Pekes", { action: "switch_store", phase: "ejemplo", exactWelcome: pekes, storeId: pekes.id, clearCart: false }, { store: pekes, items: [] });
const switchAsk = cartSwitchQuestion(pekes.nombre, coke, george.nombre);
add("sí borra y cambia", "pedido", "sí", { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, clearCart: true }, { lastBot: switchAsk });
add("no conserva el pedido", "pedido", "no", { action: "reprompt", phase: "pedido", clearCart: false, storeId: null, includes: ["Peke"] }, { lastBot: switchAsk });
add("sí otra tienda", "pedido", "sí", { action: "show_niche", phase: "tienda", clearCart: true, includes: ["¿De cuál te hago el mandado?"] }, { lastBot: cartSwitchQuestion(pekes.nombre, coke, "otra tienda") });
add("imagen con texto", "pedido", "2 cocas", { action: "media", phase: "pedido", includes: [TEXT_ONLY_REPLY] }, { media: "image" });

function decide(scenario: Scenario): FlowDecision {
  const input: FlowRouteInput = {
    message: scenario.message,
    phase: scenario.phase,
    nicheId: scenario.nicheId ?? null,
    store: scenario.store ?? null,
    stores,
    items: scenario.items ?? [],
    lastBotText: scenario.lastBot ?? "",
    awaitingProductConfirm: scenario.awaiting ?? false,
    media: scenario.media ?? "text",
    locationInsideCoverage: scenario.coverage ?? null,
    locationHasCoords: scenario.coords !== false,
    orderId: scenario.orderId ?? null,
  };
  return routeCustomerFlow(input);
}

function legacyAction(scenario: Scenario): string {
  const message = scenario.message;
  const folded = message.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const oldRestart =
    /\bpedido nuevo\b|\breiniciar\b|\breinicio\b|\bempezar de cero\b/.test(folded) || folded.trim() === "nuevo";
  const oldCancel = /cancel|anular|olvidalo|ya no lo quiero|ya no quiero nada/.test(folded);
  if (scenario.media !== "text" && scenario.media !== "location") return "drop";
  if (oldRestart) return scenario.phase === "esperando_repartidor" ? "escalate_cancel" : "restart";
  if (oldCancel && !/\bquita\b/.test(folded)) return scenario.phase === "esperando_repartidor" ? "escalate_cancel" : "cancel";
  if (scenario.phase === "esperando_tienda" || scenario.phase === "esperando_repartidor") return "tracking";
  if (scenario.phase === "resumen" || scenario.phase === "precio") return "summary";
  if (scenario.media === "location" && scenario.coverage === false) return "location_reject";
  if (scenario.media === "location") return scenario.phase === "ubicacion" ? "summary" : "llm";
  const turn = classifyCustomerTurn({
    message,
    lastBotText: scenario.lastBot ?? "",
    hasBusiness: scenario.store != null,
    hasItems: (scenario.items ?? []).length > 0,
    businessId: scenario.store?.id ?? null,
    stores,
  });
  if (turn.type === "pick_store") return "switch_store";
  if (turn.type === "show_niche" || turn.type === "switch_niche") return "show_niche";
  if (turn.type !== "continue") return turn.type;
  const blocked = gateGeneralBot({
    phase:
      scenario.phase === "pedido" || scenario.phase === "ejemplo" || scenario.phase === "ubicacion"
        ? scenario.phase
        : "categoria",
    message,
    hasBusiness: scenario.store != null,
    orderAgentOn: false,
    waitingAddress: scenario.phase === "ubicacion",
    nicheId: scenario.nicheId ?? null,
    lastBotText: scenario.lastBot ?? "",
    stores,
    businessId: scenario.store?.id ?? null,
  });
  if (blocked) return "reprompt";
  if (isConversationModeMessage(message)) return "llm";
  if (scenario.store && (scenario.phase === "ejemplo" || scenario.phase === "pedido")) return "agent";
  return "llm";
}

function tool(name: ToolCall["name"], args: Record<string, unknown>, id: string): ToolCall {
  return { id, name, arguments: args };
}

async function main(): Promise<void> {
  const fixed: string[] = [];
  const held: string[] = [];
  for (const scenario of scenarios) {
    const actual = decide(scenario);
    const expect = scenario.expect;
    const problems: string[] = [];
    if (actual.action !== expect.action) problems.push(`acción ${actual.action} ≠ ${expect.action}`);
    if (actual.phase !== expect.phase) problems.push(`fase ${actual.phase} ≠ ${expect.phase}`);
    if (expect.agent === true && actual.action !== "agent" && actual.action !== "summary") problems.push("debía ir al agente");
    if (expect.agent === false && actual.action === "agent") problems.push("el agente no debía entrar");
    if (expect.storeId != null && actual.rememberStoreId !== expect.storeId) problems.push(`tienda ${actual.rememberStoreId} ≠ ${expect.storeId}`);
    if (expect.storeId === null && actual.rememberStoreId != null) problems.push(`pegó la tienda ${actual.rememberStoreId}`);
    if (expect.clearCart != null && actual.clearCart !== expect.clearCart) problems.push(`carrito ${actual.clearCart} ≠ ${expect.clearCart}`);
    if (expect.exactWelcome && !storeWelcomeMatchesMenu(expect.exactWelcome, actual.text)) {
      problems.push("el aviso no es el del menú");
    }
    for (const piece of expect.includes ?? []) {
      if (!actual.text.includes(piece)) problems.push(`falta «${piece}»`);
    }
    if (problems.length) {
      throw new Error(`${scenario.id}: ${problems.join("; ")}\n---\n${actual.text.slice(0, 400)}`);
    }
    const legacy = legacyAction(scenario);
    const same =
      (legacy === "agent" && actual.action === "agent") ||
      (legacy === "restart" && actual.action === "restart") ||
      (legacy === "cancel" && actual.action === "cancel") ||
      (legacy === "escalate_cancel" && actual.action === "escalate_cancel") ||
      (legacy === "summary" && actual.action === "summary") ||
      (legacy === "tracking" && (actual.action === "tracking" || actual.action === "greeting" || actual.action === "reprompt")) ||
      (legacy === "switch_store" && actual.action === "switch_store") ||
      (legacy === "show_niche" && actual.action === "show_niche") ||
      (legacy === "location_reject" && actual.action === "location_reject") ||
      (legacy === "reprompt" && (actual.action === "reprompt" || actual.action === "greeting" || actual.action === "show_niche" || actual.action === "back")) ||
      (legacy === actual.action);
    if (same) held.push(scenario.id);
    else fixed.push(`${scenario.id} | antes: ${legacy} | ahora: ${actual.action} → ${actual.phase}`);
  }

  assert(storeWelcomeMatchesMenu(pekes, decide(scenarios.find((item) => item.id.startsWith("categoria: Penes"))!).text), "Penes usa el aviso de abarrotes");
  assert(isNewOrderIntent("empezar de nuevo"), "empezar de nuevo reinicia");
  assert(isCancelIntent("ya no"), "ya no cancela");
  assert(isCancelIntent("no quiero nada"), "no quiero nada cancela");
  assert(!isCancelIntent("ya no quiero la coca"), "ya no quiero la coca no cancela el pedido");

  const listed = classifyCustomerTurn({
    message: "una hamburguesa",
    lastBotText: "Restaurantes:\n1. George\n¿De cuál te hago el mandado?",
    hasBusiness: false,
    hasItems: false,
    businessId: null,
    stores,
  });
  assert(listed.type === "ask_menu", "el clasificador de la lista abierta no cambia");
  const routed = decide({
    id: "lista hamburguesa",
    phase: "tienda",
    message: "una hamburguesa",
    store: null,
    nicheId: "restaurantes",
    items: [],
    lastBot: formatNicheStoreList(nicheById("restaurantes")!, stores),
    expect: { action: "reprompt", phase: "tienda" },
  });
  assert(routed.action === "reprompt" && routed.phase === "tienda" && routed.rememberStoreId == null, "una hamburguesa con la lista abierta no abre George sola");
  assert(phaseForUxTurn(listed).phase === "ejemplo", "el turno viejo de menú sigue mapeando a ejemplo");

  const calls: string[] = [];
  const model: AgentModel = {
    name: "scripted-flow",
    async complete() {
      calls.push("scripted-flow");
      return {
        toolCalls: [
          tool("set_cart_line", { free_text: "Coca-Cola 600 ml", qty: 2, unit: "pz" }, "coca"),
          tool("finish_cart", {}, "fin"),
        ],
        text: null,
      };
    },
  };
  const first = await runOrderAgentTurn({
    message: "quiero 2 cocas",
    cart: [],
    pending: null,
    history: [],
    store: { id: pekes.id, name: pekes.nombre, category: "abarrotes", catalogMode: "list" } satisfies AgentStore,
    products: [],
    model,
    escalationModel: null,
    pedidoId: null,
  });
  const secondModel: AgentModel = {
    name: "scripted-flow-2",
    async complete() {
      calls.push("scripted-flow-2");
      return {
        toolCalls: [
          tool("set_cart_line", { free_text: "Coca-Cola 600 ml", qty: 2, unit: "pz" }, "coca"),
          tool("set_cart_line", { free_text: "Pinol 1 litro", qty: 1, unit: "pz" }, "pinol"),
          tool("finish_cart", {}, "fin2"),
        ],
        text: null,
      };
    },
  };
  const second = await runOrderAgentTurn({
    message: "y un pinol de 1 litro",
    cart: first.cart,
    pending: null,
    history: [],
    store: { id: pekes.id, name: pekes.nombre, category: "abarrotes", catalogMode: "list" },
    products: [],
    model: secondModel,
    escalationModel: null,
    pedidoId: null,
  });
  assert(calls.length === 2, "los dos mensajes usan el modelo guionado");
  assert(second.cart.some((line) => /pinol/i.test(line.name)) && second.cart.some((line) => /coca/i.test(line.name)), "el segundo mensaje suma, no borra la coca");

  const flow = readFileSync("src/lib/mandaloFlow.ts", "utf8");
  const webhook = readFileSync("src/app/api/webhook/route.ts", "utf8");
  assert(flow.includes("routeCustomerFlow") && flow.includes("steerCustomerFlow"), "el flujo usa el ruteo determinista");
  assert(flow.includes("flowAction !== \"agent\""), "el agente no se adelanta con el bot general");
  assert(flow.includes("acceptWrittenText") && flow.includes("persistWrittenAddress"), "la dirección escrita se guarda y el flujo sigue");
  assert(flow.includes("liveLocation"), "la ubicación en tiempo real no se guarda como pin");
  assert(webhook.includes("classifyInbound"), "el webhook clasifica pin, live y adjuntos");
  assert(!webhook.includes("EMPTY_MESSAGE"), "un pin o un adjunto no se descarta en silencio");
  assert(pendingSwitchTarget(switchAsk) === george.nombre, "el sí siguiente reconoce la tienda nueva");
  const written = validateAddress("calle hidalgo 12 frente a la tortillería", null, {
    acceptWrittenText: true,
    knownZoneNames: ["Calle Morelos"],
  });
  assert(written?.isValid === true, "la dirección escrita con referencia es válida");
  const gated = validateAddress("calle hidalgo 12 frente a la tortillería", null, { knownZoneNames: ["Calle Morelos"] });
  assert(gated?.isValid === false, "sin ese camino la calle fuera de la lista no pasa sola");
  assert(matchCoverageZone("vivo en calle morelos 8", ["Calle Morelos", "Calle Pino"]) === "Calle Morelos", "morelos sigue en la zona");
  const pin = classifyInbound({
    messages: [{ id: "m1", from: "5213312345678", type: "location", location: { latitude: 20.86, longitude: -103.24, preview: "AAAA" } }],
  });
  assert(pin.kind === "location" && pin.latitude === 20.86, "el pin de WhatsApp entra con coordenadas");
  const live = classifyInbound({
    messages: [{ id: "m2", from: "5213312345678", type: "live_location", live_location: { latitude: 20.86, longitude: -103.24 } }],
  });
  assert(live.kind === "live_location", "la ubicación en tiempo real no se lee como pin");
  const doc = classifyInbound({ messages: [{ id: "m3", from: "5213312345678", type: "document", document: { file_name: "a.pdf" } }] });
  assert(doc.kind === "media" && doc.media === "document", "un documento no se tira");
  const contact = classifyInbound({ messages: [{ id: "m4", from: "5213312345678", type: "contact", contact: { name: "Ana" } }] });
  assert(contact.kind === "media" && contact.media === "contact", "un contacto no se tira");
  const blank = classifyInbound({ messages: [{ id: "m5", from: "5213312345678", type: "text" }] });
  assert(blank.kind === "text", "un texto vacío se repreguntó, no se ignora");
  const status = classifyInbound({ event: "statuses", statuses: [{ id: "s1", status: "delivered" }] });
  assert(status.kind === "ignore", "un acuse de entrega no es un mensaje del cliente");
  const reaction = classifyInbound({ messages: [{ id: "m6", from: "5213312345678", type: "reaction", reaction: { emoji: "👍" } }] });
  assert(reaction.kind === "ignore", "una reacción no es un mensaje y no se contesta");
  const systemUnknown = {
    messages: [
      {
        id: "whapi-system-unknown",
        from_me: false,
        type: "unknown",
        source: "system",
        from: "5213312345678",
        chat_id: "5213312345678@s.whatsapp.net",
        timestamp: 1760568000,
      },
    ],
    event: { type: "messages", event: "post" },
    channel_id: "TEST",
  };
  for (const type of ["unknown", "system", "revoked", "e2e_notification", "call_log", "reaction", "action", "notification"]) {
    const noise = classifyInbound({ messages: [{ id: type, from: "5213312345678", from_me: false, type }] });
    assert(noise.kind === "ignore", `${type} no se contesta`);
  }
  const disguised = classifyInbound({
    messages: [{ id: "sys-text", from: "5213312345678", from_me: false, type: "text", source: "system", text: { body: "hola" } }],
  });
  assert(disguised.kind === "ignore" && disguised.reason === "system", "source system no se contesta aunque traiga texto");
  const emptyWeird = classifyInbound({ messages: [{ id: "poll", from: "5213312345678", from_me: false, type: "poll" }] });
  assert(emptyWeird.kind === "ignore", "sin texto y sin medio reconocido se ignora");
  const voice = classifyInbound({ messages: [{ id: "voice", from: "5213312345678", from_me: false, type: "voice", voice: { id: "v" } }] });
  const gif = classifyInbound({ messages: [{ id: "gif", from: "5213312345678", from_me: false, type: "gif", gif: { id: "g" } }] });
  const vcard = classifyInbound({ messages: [{ id: "vcard", from: "5213312345678", from_me: false, type: "vcard", vcard: "BEGIN:VCARD" }] });
  const sticker = classifyInbound({ messages: [{ id: "stk", from: "5213312345678", from_me: false, type: "sticker", sticker: { id: "s" } }] });
  assert(voice.kind === "media" && voice.media === "audio", "un audio de voz pide texto");
  assert(gif.kind === "media" && gif.media === "video", "un gif pide texto");
  assert(vcard.kind === "media" && vcard.media === "contact", "una vcard pide texto");
  assert(sticker.kind === "media" && sticker.media === "sticker", "un sticker pide texto");

  function replyForRealMedia(type: "audio" | "image", nest: Record<string, unknown>): string {
    const inbound = classifyInbound({
      messages: [{ id: type, from: "5213312345678", from_me: false, type, ...nest }],
    });
    assert(inbound.kind === "media" && inbound.media === type, `${type} sigue siendo un adjunto real`);
    const decision = routeCustomerFlow({
      message: "",
      phase: "pedido",
      nicheId: "abarrotes",
      store: pekes,
      stores,
      items: coke,
      lastBotText: "",
      awaitingProductConfirm: false,
      media: inbound.media,
      locationInsideCoverage: null,
      orderId: null,
    });
    assert(decision.action === "media" && decision.text.includes(TEXT_ONLY_REPLY), `${type} recibe una respuesta de solo texto`);
    assert(decision.text.split(TEXT_ONLY_REPLY).length === 2, `${type} recibe una sola respuesta`);
    return decision.text;
  }

  const audioReply = replyForRealMedia("audio", { audio: { id: "aud" } });
  const imageReply = replyForRealMedia("image", { image: { id: "img" } });
  resetOutboundGuard();
  const now = 1_760_568_000_000;
  let systemSends = 0;
  for (let burst = 0; burst < 5; burst += 1) {
    const inbound = classifyInbound({
      ...systemUnknown,
      messages: [{ ...systemUnknown.messages[0], id: `whapi-system-unknown-${burst}` }],
    });
    const wouldSend = inbound.kind !== "ignore" && inbound.kind !== "missing_from";
    if (wouldSend) {
      recordOutbound("5213312345678", TEXT_ONLY_REPLY, now);
      systemSends += 1;
    }
    assert(inbound.kind === "ignore" && inbound.reason === "system", "el evento system unknown de Whapi se ignora");
  }
  assert(systemSends === 0, "una ráfaga de 5 eventos system unknown manda 0 respuestas");

  const audioPhone = "5213300000001";
  const imagePhone = "5213300000002";
  assert(outboundDecision(audioPhone, audioReply, now) === "send", "el audio real sale una vez");
  recordOutbound(audioPhone, audioReply, now);
  assert(outboundDecision(imagePhone, imageReply, now) === "send", "la imagen real sale una vez");
  recordOutbound(imagePhone, imageReply, now);
  assert(outboundDecision(audioPhone, audioReply, now + 1_000) === "duplicate", "la misma respuesta dentro de 60 s se suprime");
  assert(outboundDecision(audioPhone, audioReply, now + OUTBOUND_WINDOW_MS) === "duplicate", "a los 60 s justos sigue suprimida");
  assert(outboundDecision(audioPhone, audioReply, now + OUTBOUND_WINDOW_MS + 1) === "send", "pasado el minuto el mismo texto puede salir otra vez");
  const menu = "¿De dónde quieres?";
  const example = "Ejemplo: 2 cocas de 600 ml y un kilo de tortillas.";
  const flowPhone = "5213300000003";
  assert(outboundDecision(flowPhone, menu, now) === "send", "el menú sale");
  recordOutbound(flowPhone, menu, now);
  assert(outboundDecision(flowPhone, example, now + 500) === "send", "el ejemplo, distinto del menú, también sale");
  recordOutbound(flowPhone, example, now + 500);
  const capPhone = "5213300000004";
  for (let sent = 0; sent < OUTBOUND_MAX_PER_MINUTE; sent += 1) {
    const body = `aviso ${sent}`;
    assert(outboundDecision(capPhone, body, now) === "send", `el mensaje ${sent + 1} de ${OUTBOUND_MAX_PER_MINUTE} sale`);
    recordOutbound(capPhone, body, now);
  }
  assert(outboundDecision(capPhone, "aviso extra", now + 1_000) === "rate", "el séptimo mensaje distinto en un minuto se tira");
  assert(outboundDecision("5213300000005", "aviso extra", now) === "send", "el tope de un número no bloquea a otro");
  recordOutbound(audioPhone, "intento fallido", now);
  releaseOutbound(audioPhone, "intento fallido", now);
  assert(outboundDecision(audioPhone, "intento fallido", now) === "send", "si Whapi no acepta el envío, el reintento sí sale");

  resetOutboundGuard();
  recordOutbound(audioPhone, audioReply);
  recordOutbound(imagePhone, imageReply);
  const suppressedText = await waapiSendTextRequest({ to: `${audioPhone}@c.us`, body: audioReply });
  const suppressedImage = await waapiSendImage({
    to: `${imagePhone}@s.whatsapp.net`,
    caption: imageReply,
    png: Buffer.from("no-se-sube"),
  });
  function isSuppressed(result: { data: unknown }): boolean {
    return Boolean(result.data && typeof result.data === "object" && (result.data as { suppressed?: boolean }).suppressed === true);
  }
  assert(isSuppressed(suppressedText), "el segundo texto idéntico no llama a Whapi");
  assert(isSuppressed(suppressedImage), "la misma imagen dentro de 60 s no se repite");

  const pendingNumber = routeCustomerFlow({
    message: "2",
    phase: "pedido",
    nicheId: "abarrotes",
    store: pekes,
    stores,
    items: coke,
    lastBotText: "¿Cuántos?",
    awaitingProductConfirm: false,
    agentPending: true,
    media: "text",
    locationInsideCoverage: null,
    orderId: null,
  });
  assert(pendingNumber.action === "agent" && !pendingNumber.text.includes("El número solo"), "un 2 contesta la pregunta del agente");
  const pendingOk = routeCustomerFlow({
    message: "está bien",
    phase: "pedido",
    nicheId: "abarrotes",
    store: pekes,
    stores,
    items: coke,
    lastBotText: "¿Así está bien?",
    awaitingProductConfirm: false,
    agentPending: true,
    media: "text",
    locationInsideCoverage: null,
    orderId: null,
  });
  assert(pendingOk.action === "agent", "está bien contesta la pregunta del agente");
  const bareStill = routeCustomerFlow({
    message: "2",
    phase: "pedido",
    nicheId: "abarrotes",
    store: pekes,
    stores,
    items: coke,
    lastBotText: "",
    awaitingProductConfirm: false,
    media: "text",
    locationInsideCoverage: null,
    orderId: null,
  });
  assert(
    bareStill.action === "reprompt" && bareStill.text.includes("El número solo no me dice el producto"),
    "sin pregunta pendiente el número solo sigue sin ser un producto",
  );

  assert(scenarios.length === 345, "siguen los 345 escenarios");
  assert(greeting.includes("¿De dónde quieres?"), "el menú de categorías sigue igual");
  assert(pekesWelcome.includes("Solo es un ejemplo") && georgeWelcome.includes("Te paso el menú"), "los avisos de tienda siguen igual");

  console.log(`Matriz del flujo: ${scenarios.length} escenarios.`);
  console.log(`Antes se salían y ahora quedan en el flujo: ${fixed.length}.`);
  console.log(fixed.map((line) => `- ${line}`).join("\n"));
  console.log(`Ya coincidían con el camino de antes: ${held.length}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
