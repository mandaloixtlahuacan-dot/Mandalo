/**
 * Atajos del pedido del 15 de octubre, sin OpenAI y sin base de datos.
 * Correr: npx tsx scripts/check-order-shortcuts.ts
 */
import { readFileSync } from "node:fs";
import { confirmationCustomerMessage } from "../src/lib/confirmationAmendment";
import {
  buildGreeting,
  classifyCustomerTurn,
  formatAbarrotesStoreAck,
  renderCustomerTurn,
  type UxStore,
} from "../src/lib/customerUx";
import { isNewOrderIntent } from "../src/lib/messages";
import {
  applySummaryNegation,
  gateGeneralBot,
  summaryCorrectionKind,
  withCategoryMenu,
  type OrderPhase,
} from "../src/lib/orderSession";
import { runOrderAgentTurn, type AgentModel, type AgentStore, type ToolCall } from "../src/lib/orderAgent";
import { formatPreConfirmFeeNote } from "../src/lib/customerUx";
import type { PedidoItemInput } from "../src/lib/services/captureEngine";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tool(name: ToolCall["name"], args: Record<string, unknown>, id: string = name): ToolCall {
  return { id, name, arguments: args };
}

function scripted(steps: Array<{ toolCalls: ToolCall[] }>): AgentModel {
  let index = 0;
  return {
    name: "scripted-shortcut",
    async complete() {
      const step = steps[Math.min(index, steps.length - 1)] ?? { toolCalls: [] };
      index += 1;
      if (index > steps.length) return { toolCalls: [], text: null };
      return { toolCalls: step.toolCalls, text: null };
    },
  };
}

const CLOSED = "como todavía está cerrado voy a pedir de la tienda de abarrotes";
const CANCEL = "Voy a cancelar el pedido de los Hot Dogs";
const ABARROTES = "Quiero hacer un pedido de la tienda de abarrotes";
const ORDER = "paquete grande de papel higiénico de Sam's, 1 litro de aceite de aguacate, una caja de toallas Sanitas";
const FIX = "Es aceite de aguacate. No pedí aguacate (verdura)";

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

const pekesAgent: AgentStore = { id: pekes.id, name: pekes.nombre, category: "abarrotes", catalogMode: "list" };

type Sim = {
  phase: OrderPhase;
  nicheId: string | null;
  store: UxStore | null;
  lastBot: string;
  items: PedidoItemInput[];
};

function blank(): Sim {
  return { phase: "categoria", nicheId: null, store: null, lastBot: "", items: [] };
}

function replyOf(state: Sim, message: string) {
  return classifyCustomerTurn({
    message,
    lastBotText: state.lastBot,
    hasBusiness: state.store != null,
    hasItems: state.items.length > 0,
    businessId: state.store?.id ?? null,
    stores,
  });
}

async function main(): Promise<void> {
  const greeting = buildGreeting();
  assert(isNewOrderIntent("pedido nuevo"), "pedido nuevo sigue siendo reinicio");
  assert(
    `✅ *Pedido anterior cancelado.*\n\n${greeting}`.includes("¿De dónde quieres?"),
    "pedido nuevo sigue abriendo con el menú de categorías",
  );

  const listed = classifyCustomerTurn({
    message: "una hamburguesa",
    lastBotText: "Restaurantes:\n1. George\n¿De cuál te hago el mandado?",
    hasBusiness: false,
    hasItems: false,
    businessId: null,
    stores,
  });
  assert(listed.type === "ask_menu", "una hamburguesa corta con la lista abierta no se vuelve filtro");

  for (const alias of ["Pekes", "Penes", "Peques", "peke"]) {
    const turn = classifyCustomerTurn({
      message: alias,
      lastBotText: "",
      hasBusiness: false,
      hasItems: false,
      businessId: null,
      stores,
    });
    assert(turn.type === "pick_store" && turn.store.id === pekes.id, `${alias} elige Mini Super Peke's`);
    const rendered = renderCustomerTurn(turn, stores, "");
    assert(rendered?.rememberStore?.id === pekes.id, `${alias} recuerda la tienda`);
    assert(rendered?.kind === "text" && rendered.text.includes("Solo es un ejemplo"), `${alias} manda el ejemplo`);
    assert(rendered.text === formatAbarrotesStoreAck(pekes), `${alias} usa el aviso fijo de abarrotes`);
  }

  const gorge = classifyCustomerTurn({
    message: "Gorge",
    lastBotText: "",
    hasBusiness: false,
    hasItems: false,
    businessId: null,
    stores,
  });
  assert(gorge.type === "pick_store" && gorge.store.id === george.id, "Gorge elige a George");
  const centralAlias = classifyCustomerTurn({
    message: "Central",
    lastBotText: "",
    hasBusiness: false,
    hasItems: false,
    businessId: null,
    stores,
  });
  assert(centralAlias.type === "pick_store" && centralAlias.store.id === central.id, "Central elige La Central");

  let state = blank();
  state.phase = "ejemplo";
  state.store = george;
  state.lastBot = "Va, de Hamburguesas Hotdogs George.";
  const leaving = replyOf(state, CLOSED);
  assert(leaving.type === "show_niche" && leaving.nicheId === "abarrotes" && leaving.releaseHeldStore === true, "la tienda cerrada se suelta al pedir abarrotes");
  const leavingReply = renderCustomerTurn(leaving, stores, state.lastBot);
  assert(leavingReply?.clearActiveStore === true, "soltar la tienda limpia la elección");
  assert(leavingReply?.kind === "text" && leavingReply.text.includes("Mini Super Peke's"), "lista los abarrotes");
  assert(!leavingReply?.text.includes("Primero cerramos"), "no pide cerrar primero el pedido de George");
  state = {
    phase: "tienda",
    nicheId: "abarrotes",
    store: null,
    lastBot: leavingReply?.kind === "text" ? leavingReply.text : "",
    items: [],
  };

  const cancelBody = withCategoryMenu("✅ *Listo, cancelé tu pedido.*\n\nCuando quieras hacer uno nuevo, aquí estoy.");
  assert(cancelBody.includes("Listo, cancelé") && cancelBody.includes("¿De dónde quieres?"), "cancelar manda el menú fijo");
  state = { phase: "categoria", nicheId: null, store: null, lastBot: cancelBody, items: [] };
  const afterCancel = gateGeneralBot({
    phase: state.phase,
    message: "hola qué tal",
    hasBusiness: false,
    orderAgentOn: true,
    waitingAddress: false,
    nicheId: null,
    lastBotText: state.lastBot,
    stores,
    businessId: null,
  });
  assert(afterCancel?.phase === "categoria" && afterCancel.text.includes("1. *Abarrotes*"), "el texto libre después de cancelar vuelve al menú");
  assert(!afterCancel.text.includes("Peke"), "ese texto no pega una tienda");

  const longNiche = replyOf(state, ABARROTES);
  assert(longNiche.type === "show_niche" && longNiche.nicheId === "abarrotes", "la frase larga de abarrotes muestra la lista fija");
  const longReply = renderCustomerTurn(longNiche, stores, state.lastBot);
  assert(longReply?.kind === "text" && longReply.text.includes("¿De cuál te hago el mandado?"), "la lista trae el marcador fijo");
  assert(!longReply.text.includes("Tengo estas"), "el bot general no inventa la lista");
  state = { phase: "tienda", nicheId: "abarrotes", store: null, lastBot: longReply.text, items: [] };

  const picked = replyOf(state, "Penes");
  assert(picked.type === "pick_store" && picked.store.id === pekes.id, "Penes después de la lista elige Peke's");
  const welcome = renderCustomerTurn(picked, stores, state.lastBot);
  assert(welcome?.rememberStore?.id === pekes.id && welcome.kind === "text" && welcome.text.includes("Solo es un ejemplo"), "elige, recuerda y manda el ejemplo");
  state = { phase: "ejemplo", nicheId: null, store: pekes, lastBot: welcome.kind === "text" ? welcome.text : "", items: [] };

  const small = gateGeneralBot({
    phase: "ejemplo",
    message: "gracias",
    hasBusiness: true,
    orderAgentOn: true,
    waitingAddress: false,
    nicheId: null,
    lastBotText: state.lastBot,
    stores,
    businessId: pekes.id,
  });
  assert(small?.phase === "ejemplo" && small.text.includes(pekes.nombre), "la charla no cambia de fase ni de tienda");

  const orderTurn = replyOf(state, ORDER);
  assert(orderTurn.type === "continue", "el pedido de abarrotes no lo captura el bot general");
  const blockedWithoutStore = gateGeneralBot({
    phase: "categoria",
    message: ORDER,
    hasBusiness: false,
    orderAgentOn: true,
    waitingAddress: false,
    nicheId: null,
    lastBotText: greeting,
    stores,
    businessId: null,
  });
  assert(blockedWithoutStore?.text.includes("¿De dónde quieres?"), "sin tienda, el pedido pide el menú y no llama al bot general");

  const calls: string[] = [];
  const orderModel: AgentModel = {
    name: "scripted-order",
    async complete() {
      calls.push("scripted-order");
      return {
        toolCalls: [
          tool("set_cart_line", { free_text: "Papel higiénico Sam's paquete grande", qty: 1, unit: "pz" }, "papel"),
          tool("set_cart_line", { free_text: "Aceite de aguacate Nutrioli 1 litro", qty: 1, unit: "pz" }, "aceite"),
          tool("set_cart_line", { free_text: "Toallas Sanitas caja", qty: 1, unit: "pz" }, "sanitas"),
          tool("finish_cart", {}, "fin"),
        ],
        text: null,
      };
    },
  };
  const ordered = await runOrderAgentTurn({
    message: ORDER,
    cart: [],
    pending: null,
    history: [],
    store: pekesAgent,
    products: [],
    model: orderModel,
    escalationModel: null,
    pedidoId: null,
  });
  assert(calls.length === 1 && ordered.model === "scripted-order", "el pedido usa el modelo guionado, no OpenAI");
  const names = ordered.cart.map((line) => line.name);
  assert(names.some((name) => /aceite de aguacate/i.test(name)), "el aceite de aguacate queda en una sola línea");
  assert(!names.some((name) => /^aguacate$/i.test(name)), "no se parte en aguacate");
  assert(names.some((name) => /toallas sanitas/i.test(name)), "Sanitas se queda en toallas");
  assert(!names.some((name) => /sanitas/i.test(name) && /papel higiénico/i.test(name)), "Sanitas no se etiqueta como papel higiénico");
  state.items = names.map((name) => ({ nombre_producto: name, cantidad: 1 }));
  state.phase = "pedido";

  const bad: PedidoItemInput[] = [
    { nombre_producto: "Papel higiénico Sam's", cantidad: 1 },
    { nombre_producto: "Aceite", cantidad: 1 },
    { nombre_producto: "Aguacate", cantidad: 1 },
    { nombre_producto: "Verdura", cantidad: 1 },
  ];
  assert(summaryCorrectionKind(FIX) === "edit", "la corrección del resumen no es un sí ni una cancelación");
  assert(summaryCorrectionKind("SÍ") === "confirm", "el sí del resumen sigue confirmando");
  assert(summaryCorrectionKind("pedido nuevo") === "cancel", "pedido nuevo en el resumen no se mezcla");
  assert(summaryCorrectionKind("Quiero unas galletas") === "other", "agregar galletas sigue siendo otro camino");
  const removed = applySummaryNegation(bad, FIX);
  const fixedNames = removed.items.map((item) => item.nombre_producto);
  assert(removed.changed, "la negación cambia el resumen");
  assert(fixedNames.some((name) => /aceite de aguacate/i.test(name)), "es aceite de aguacate reemplaza la línea");
  assert(!fixedNames.some((name) => /^aguacate$/i.test(name)), "quita el aguacate que no pidió");
  assert(!fixedNames.some((name) => /verdura/i.test(name)), "el paréntesis no se agrega como producto");
  const summary = confirmationCustomerMessage({
    pedidoId: 90,
    snapshot: {
      businessId: pekes.id,
      businessName: pekes.nombre,
      addressText: "Ubicación compartida por WhatsApp",
      latitud: 21.0,
      longitud: -103.2,
      items: removed.items,
    },
    items: removed.items,
    readyForConfirmation: true,
    feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
  });
  assert(summary.includes("Pedido #90") && /aceite de aguacate/i.test(summary), "vuelve a mostrar el resumen fijo");
  assert(!/verdura/i.test(summary), "el resumen fijo no trae verdura");

  const summaryModel = scripted([
    {
      toolCalls: [
        tool("remove_line", { line_id: "l2" }, "quita-aceite-corto"),
        tool("remove_line", { line_id: "l3" }, "quita-aguacate"),
        tool("remove_line", { line_id: "l4" }, "quita-verdura"),
        tool("set_cart_line", { free_text: "Aceite de aguacate Nutrioli 1 litro", qty: 1, unit: "pz" }, "reemplazo"),
        tool("finish_cart", {}, "fin2"),
      ],
    },
  ]);
  const revised = await runOrderAgentTurn({
    message: FIX,
    cart: [
      { lineId: "l1", productId: null, freeText: "Papel higiénico Sam's", name: "Papel higiénico Sam's", qty: 1, unit: "pz", variant: null, note: null, unitPrice: null, brand: null, presentation: null },
      { lineId: "l2", productId: null, freeText: "Aceite", name: "Aceite", qty: 1, unit: "pz", variant: null, note: null, unitPrice: null, brand: null, presentation: null },
      { lineId: "l3", productId: null, freeText: "Aguacate", name: "Aguacate", qty: 1, unit: "pz", variant: null, note: null, unitPrice: null, brand: null, presentation: null },
      { lineId: "l4", productId: null, freeText: "Verdura", name: "Verdura", qty: 1, unit: "pz", variant: null, note: null, unitPrice: null, brand: null, presentation: null },
    ],
    pending: null,
    history: [],
    store: pekesAgent,
    products: [],
    model: summaryModel,
    escalationModel: null,
    pedidoId: null,
  });
  const rawNames = revised.cart.map((line) => line.name);
  assert(rawNames.some((name) => /aceite de aguacate/i.test(name)), "el agente reemplaza por aceite de aguacate");
  assert(!rawNames.some((name) => /^aguacate$/i.test(name) || /^verdura$/i.test(name) || /^aceite$/i.test(name)), "el agente quita lo que no pidió");
  const agentItems = revised.cart.map((line) => ({ nombre_producto: line.name, cantidad: line.qty }));
  const afterAgent = applySummaryNegation(agentItems, FIX);
  const agentNames = afterAgent.items.map((item) => item.nombre_producto);
  assert(agentNames.some((name) => /aceite de aguacate/i.test(name)), "después del agente el aceite de aguacate sigue");
  assert(!agentNames.some((name) => /^aguacate$/i.test(name) || /^verdura$/i.test(name)), "la red de negación no vuelve a meter lo quitado");

  const timeoutBody = withCategoryMenu(
    "🧾 *Pedido #90*\n\nSe canceló porque la tienda no respondió a tiempo.\n\n¿Quieres pedir de otro negocio?",
  );
  assert(timeoutBody.includes("Se canceló") && timeoutBody.includes("3. *Carnicerías*"), "el timeout cancela y manda el menú");
  const afterTimeout = gateGeneralBot({
    phase: "categoria",
    message: "quiero unas papas",
    hasBusiness: false,
    orderAgentOn: false,
    waitingAddress: false,
    nicheId: null,
    lastBotText: timeoutBody,
    stores,
    businessId: null,
  });
  assert(afterTimeout?.phase === "categoria" && afterTimeout.text === greeting, "después del timeout el texto libre cae en el menú");

  const flow = readFileSync("src/lib/mandaloFlow.ts", "utf8");
  const worker = readFileSync("src/lib/services/orderTimeoutWorker.ts", "utf8");
  assert(flow.includes("holdGeneralBot") && flow.includes("gateGeneralBot"), "el flujo corta al bot general antes de contestar");
  assert(flow.includes("sameAttached"), "business_name del bot general no pega una tienda nueva");
  assert(flow.includes("applySummaryNegation") && flow.includes("fromSummary"), "el resumen regresa al agente y quita lo negado");
  assert(flow.includes("el agente no pudo corregir el resumen") && flow.includes("no se quede a medias"), "si el agente truena, el resumen vuelve a confirmación");
  assert(flow.includes("customerCancelText"), "cancelar arma el aviso con el menú");
  assert(worker.includes("withCategoryMenu") && worker.includes("resetCustomerToCategoryMenu"), "el timeout reinicia la fase al menú");

  console.log("Atajos del pedido: ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
