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
  routeCustomerFlow,
  storeWelcomeMatchesMenu,
  type CustomerFlowPhase,
  type CustomerMedia,
  type FlowDecision,
  type FlowRouteInput,
} from "../src/lib/flowRouter";
import { isCancelIntent, isConversationModeMessage, isNewOrderIntent } from "../src/lib/messages";
import { gateGeneralBot, phaseForUxTurn } from "../src/lib/orderSession";
import { runOrderAgentTurn, type AgentModel, type AgentStore, type ToolCall } from "../src/lib/orderAgent";

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
    : { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, clearCart: itemsFor(phase).length > 0 && phase !== "tienda" && phase !== "categoria" && phase !== "entregado" });
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
      ? { action: "reprompt", phase: phase === "entregado" ? "categoria" : "categoria", includes: ["¿De dónde quieres?"] }
      : { action: "show_niche", phase: "tienda", includes: ["¿De cuál te hago el mandado?"] });
  add("quiero de otra tienda", phase, "quiero de otra tienda", locked
    ? { action: "tracking", phase }
    : phase === "categoria" || phase === "entregado"
      ? { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"] }
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
      : { action: phase === "categoria" || phase === "tienda" ? "back" : phase === "ejemplo" ? "show_niche" : "back", phase: phase === "categoria" || phase === "tienda" || phase === "entregado" ? "categoria" : phase === "ejemplo" ? "tienda" : itemsFor(phase).length ? "pedido" : "ejemplo" });
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
  add("sticker", phase, "", { action: "media", phase: phase === "entregado" ? "categoria" : phase, includes: ["no lo puedo leer"] }, { media: "sticker" });
  add("imagen", phase, "", { action: "media", phase: phase === "entregado" ? "categoria" : phase }, { media: "image" });
  add("audio", phase, "", { action: "media", phase: phase === "entregado" ? "categoria" : phase }, { media: "audio" });
  add("pin temprano", phase, "", phase === "ubicacion" || phase === "resumen" || phase === "precio"
    ? { action: "summary", phase }
    : { action: "location_early", phase: phase === "entregado" ? "categoria" : phase, includes: ["pin"] }, { media: "location", coverage: true });
}

add("número 1 categoría", "categoria", "1", { action: "show_niche", phase: "tienda", includes: ["Abarrotes", "¿De cuál te hago el mandado?"] }, { store: null, nicheId: null, items: [] });
add("número 2 abarrotes", "tienda", "2", { action: "switch_store", phase: "ejemplo", exactWelcome: pekes, storeId: pekes.id, clearCart: false }, { store: null, nicheId: "abarrotes", items: [], lastBot: abarrotesList });
add("número 1 restaurantes cerrado", "tienda", "1", { action: "switch_store", phase: "ejemplo", exactWelcome: george, storeId: george.id, includes: ["cerrada"] }, { store: null, nicheId: "restaurantes", items: [], lastBot: formatNicheStoreList(nicheById("restaurantes")!, stores) });
add("typo abarotes", "categoria", "abarotes", { action: "show_niche", phase: "tienda", includes: ["Abarrotes"] }, { store: null, items: [] });
add("typo restorantes", "categoria", "restorantes", { action: "show_niche", phase: "tienda", includes: ["George"] }, { store: null, items: [] });
add("typo carniseria", "pedido", "carniseria", { action: "show_niche", phase: "tienda", includes: ["Central"], clearCart: true });
add("typo hamburgesas", "categoria", "hamburgesas", { action: "show_niche", phase: "tienda", includes: ["George"] }, { store: null, items: [] });
add("pedido antes de tienda", "categoria", "quiero 2 cocas", { action: "reprompt", phase: "categoria", includes: ["¿De dónde quieres?"], agent: false }, { store: null, items: [] });
add("pedido en ejemplo", "ejemplo", "quiero 2 cocas", { action: "agent", phase: "pedido", agent: true }, { store: pekes, items: [] });
add("segundo mensaje", "pedido", "y un pinol de 1 litro", { action: "agent", phase: "pedido", agent: true });
add("hamburguesa en abarrotes", "pedido", "una hamburguesa", { action: "agent", phase: "pedido", agent: true, storeId: null });
add("producto de otra tienda", "pedido", "mejor de la central un kilo de bistec", { action: "switch_store", phase: "ejemplo", exactWelcome: central, storeId: central.id, clearCart: true, includes: ["Soltamos"] });
add("dos tiendas", "pedido", "de pekes y de george", { action: "disambiguate", phase: "pedido", includes: ["una sola tienda", "Peke", "George"] });
add("mensaje largo sin tienda", "categoria", `${"quiero muchas cocas ".repeat(40)}por favor`, { action: "reprompt", phase: "categoria", includes: ["largo"], agent: false }, { store: null, items: [] });
add("mensaje largo con tienda", "pedido", `${"coca cola 600 ".repeat(40)}`, { action: "agent", phase: "pedido", agent: true });
add("dirección escrita en pin", "ubicacion", "calle hidalgo 12 frente a la tortillería", { action: "need_pin", phase: "ubicacion", includes: ["pin de WhatsApp"] });
add("dirección escrita en pedido", "pedido", "mi dirección es calle morelos 8", { action: "need_pin", phase: "pedido", includes: ["pin"] });
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
  if (scenario.media === "location") return scenario.phase === "ubicacion" || scenario.phase === "resumen" ? "summary" : "llm";
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
      scenario.phase === "pedido" || scenario.phase === "ejemplo" || scenario.phase === "ubicacion" || scenario.phase === "resumen"
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
  assert(webhook.includes("extractWaapiMediaKind"), "un sticker o audio no se tira en silencio");
  assert(greeting.includes("¿De dónde quieres?"), "el menú de categorías sigue igual");
  assert(pekesWelcome.includes("Ejemplo") && georgeWelcome.includes("Te paso el menú"), "los avisos de tienda siguen igual");

  console.log(`Matriz del flujo: ${scenarios.length} escenarios.`);
  console.log(`Antes se salían y ahora quedan en el flujo: ${fixed.length}.`);
  console.log(fixed.map((line) => `- ${line}`).join("\n"));
  console.log(`Ya coincidían con el camino de antes: ${held.length}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
