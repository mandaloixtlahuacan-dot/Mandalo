/**
 * Agente de pedido y los arreglos que van prendidos aunque ORDER_AGENT esté apagado.
 * No llama a OpenAI. Correr: npx tsx scripts/check-order-agent.ts
 */
import { readFileSync } from "node:fs";
import { checkAiOutput } from "../src/lib/catalogOrder/accept";
import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import { runCatalogOrderTurn } from "../src/lib/catalogOrder/engine";
import type { AiOutput, CatalogModel } from "../src/lib/catalogOrder/types";
import { storeSwitchFromCapture, type UxStore } from "../src/lib/customerUx";
import {
  agentPendingFromStoredAsk,
  buildOrderAgentSystem,
  itemsFromAgentLines,
  orderAgentEnabled,
  orderAgentEscalationModel,
  orderAgentModel,
  runOrderAgentTurn,
  snapshotFieldsFromAgentPending,
  validateToolCall,
  type AgentLine,
  type AgentModel,
  type AgentPending,
  type AgentProduct,
  type AgentStore,
  type ToolCall,
} from "../src/lib/orderAgent";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { ADDRESS_ASK_MESSAGE, fixedCatalogStepAfterList, formatScheduledLocationAsk } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import { listaSearchTokens } from "../src/lib/storeProductSearch";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function product(over: Partial<AgentProduct> & Pick<AgentProduct, "id" | "name">): AgentProduct {
  return {
    price: null,
    available: true,
    unit: "pz",
    variants: [],
    brand: null,
    presentation: null,
    alias: [],
    category: null,
    ...over,
  };
}

function line(over: Partial<AgentLine> & Pick<AgentLine, "lineId" | "name">): AgentLine {
  return {
    productId: null,
    freeText: null,
    qty: 1,
    unit: "pz",
    variant: null,
    note: null,
    unitPrice: null,
    brand: null,
    presentation: null,
    ...over,
  };
}

function tool(name: ToolCall["name"], args: Record<string, unknown>, id: string = name): ToolCall {
  return { id, name, arguments: args };
}

function scripted(name: string, steps: Array<{ toolCalls: ToolCall[]; text?: string | null }>, calls: string[]): AgentModel {
  let index = 0;
  return {
    name,
    async complete() {
      calls.push(name);
      const step = steps[Math.min(index, steps.length - 1)] ?? { toolCalls: [] };
      index += 1;
      if (index > steps.length) return { toolCalls: [], text: null };
      return { toolCalls: step.toolCalls, text: step.text ?? null };
    },
  };
}

const pekesStore: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list" };
const centralStore: AgentStore = { id: 11, name: "Carnicería La Central", category: "carniceria", catalogMode: "fixed" };
const georgeStore: AgentStore = { id: 8, name: "Hamburguesas Hotdogs George", category: "restaurante", catalogMode: "fixed" };

const pekesProducts: AgentProduct[] = [
  product({ id: 10, name: "Agua mineral", brand: "Peñafiel", presentation: "600 ml", alias: ["agua mineral"] }),
  product({ id: 11, name: "Agua mineral", brand: "Peñafiel", presentation: "2 L", alias: ["agua mineral"] }),
  product({ id: 12, name: "Coca-Cola", brand: "Coca-Cola", presentation: "600 ml", alias: ["coca", "cocas"] }),
  product({ id: 13, name: "Coca-Cola", brand: "Coca-Cola", presentation: "2 L", alias: ["coca", "cocas"] }),
  product({ id: 14, name: "Desodorante", brand: "Old Spice", presentation: "150 ml", alias: ["old spice", "spice"] }),
  product({ id: 15, name: "Tortillas de harina", presentation: "1 kg", alias: ["tortillas de harina"] }),
  product({ id: 16, name: "Crema", brand: "Lala", presentation: "450 ml", alias: ["crema"] }),
  product({ id: 17, name: "Crema", brand: "Alpura", presentation: "450 ml", alias: ["crema"] }),
];

const centralProducts: AgentProduct[] = [
  product({ id: 1, name: "Arrachera Marinada", price: 280, unit: "kg", category: "Res marinada" }),
  product({ id: 2, name: "Chamberete", price: 155, unit: "kg", category: "Res" }),
  product({ id: 3, name: "Pulpa de puerco", price: 115, unit: "kg", category: "Puerco" }),
  product({ id: 4, name: "Chorizo", price: 115, unit: "kg", category: "Embutidos" }),
  product({ id: 5, name: "Chorizo Argentino", price: 135, unit: "kg", category: "Embutidos" }),
];

const georgeProducts: AgentProduct[] = [
  product({ id: 1, name: "Hamburguesa de res chica", price: 70, presentation: "chica" }),
  product({ id: 2, name: "Hamburguesa de res grande", price: 90, presentation: "grande" }),
  product({ id: 3, name: "Papas a la francesa 300g", price: 45, alias: ["papas a la francesa"] }),
  product({ id: 4, name: "Papas gajo 315g", price: 50 }),
  product({ id: 5, name: "Refresco", price: 25, variants: ["Pepsi", "Seven", "Coca", "Mirinda", "Manzana"] }),
  product({ id: 6, name: "Dogo Clásico", price: 40, alias: ["dogo", "hot dog", "jocho"] }),
];

const aguaSanta: UxStore = {
  id: 2,
  nombre: "Abarrotes Agua Santa",
  categoria: "Abarrotes",
  telefono: "1",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const pekesUx: UxStore = {
  id: 7,
  nombre: "Mini Super Peke's",
  categoria: "Abarrotes",
  telefono: "2",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const georgeUx: UxStore = {
  id: 8,
  nombre: "Hamburguesas Hotdogs George",
  categoria: "Restaurante",
  telefono: "3",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: true,
};
const zaguUx: UxStore = {
  id: 1,
  nombre: "ZAGU",
  categoria: "Abarrotes",
  telefono: "4",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};

async function main(): Promise<void> {
  const previousAgent = process.env.ORDER_AGENT;
  const previousModel = process.env.OPENAI_ORDER_MODEL;
  const previousEscalation = process.env.OPENAI_ORDER_ESCALATION_MODEL;
  delete process.env.ORDER_AGENT;
  delete process.env.OPENAI_ORDER_MODEL;
  delete process.env.OPENAI_ORDER_ESCALATION_MODEL;
  assert(orderAgentEnabled() === false, "ORDER_AGENT apagado es el default");
  assert(orderAgentModel() === "gpt-4o-mini", "el modelo del agente es gpt-4o-mini");
  assert(orderAgentEscalationModel() === "gpt-4.1-mini", "el salto del agente es gpt-4.1-mini");
  process.env.ORDER_AGENT = "on";
  assert(orderAgentEnabled() === true, "ORDER_AGENT=on prende el agente");
  process.env.ORDER_AGENT = "off";
  assert(orderAgentEnabled() === false, "ORDER_AGENT=off lo apaga");
  if (previousAgent === undefined) delete process.env.ORDER_AGENT;
  else process.env.ORDER_AGENT = previousAgent;
  if (previousModel === undefined) delete process.env.OPENAI_ORDER_MODEL;
  else process.env.OPENAI_ORDER_MODEL = previousModel;
  if (previousEscalation === undefined) delete process.env.OPENAI_ORDER_ESCALATION_MODEL;
  else process.env.OPENAI_ORDER_ESCALATION_MODEL = previousEscalation;

  const mineral = "Te pedí agua mineral";
  assert(
    storeSwitchFromCapture({ message: mineral, stores: [aguaSanta, pekesUx], currentStoreId: pekesUx.id, orderInProgress: true }) == null,
    "agua mineral no cambia a Agua Santa con el pedido en curso",
  );
  assert(
    storeSwitchFromCapture({ message: "dos aguas mineral, dos cocas", stores: [aguaSanta, pekesUx], currentStoreId: pekesUx.id, orderInProgress: true }) == null,
    "el pedido de aguas no cambia de tienda",
  );
  const toGeorge = storeSwitchFromCapture({
    message: "George",
    stores: [zaguUx, georgeUx],
    currentStoreId: zaguUx.id,
    orderInProgress: true,
  });
  assert(toGeorge?.id === georgeUx.id, "decir solo George sí cambia la tienda");
  const namedGeorge = storeSwitchFromCapture({
    message: "una hamburguesa en George",
    stores: [zaguUx, georgeUx],
    currentStoreId: zaguUx.id,
    orderInProgress: true,
  });
  assert(namedGeorge?.id === georgeUx.id, "en George cambia la tienda");
  assert(!listaSearchTokens(mineral).includes("pedi"), "pedí no es un token de búsqueda");

  const georgeCatalog = buildCatalog(
    [
      { id: 1, nombreProducto: "Hamburguesa de res chica", precio: 70 },
      { id: 2, nombreProducto: "Hamburguesa de res grande", precio: 90 },
      { id: 5, nombreProducto: "Refresco (Pepsi, Seven, Coca, Mirinda, Manzana)", precio: 25 },
      { id: 2, nombreProducto: "Chamberete", precio: 155 },
    ].filter((row, index, rows) => rows.findIndex((item) => item.id === row.id) === index),
    "restaurante",
  );
  const centralCatalog = buildCatalog(
    [
      { id: 21, nombreProducto: "Arrachera Marinada", precio: 280, categoria: "Res marinada" },
      { id: 22, nombreProducto: "Chamberete", precio: 155, categoria: "Res" },
      { id: 23, nombreProducto: "Pulpa de puerco", precio: 115, categoria: "Puerco" },
      { id: 24, nombreProducto: "Chorizo", precio: 115, categoria: "Embutidos" },
    ],
    "carniceria",
  );
  const invented = checkAiOutput(
    {
      cart: [],
      pending: [{ text: "¿Chamberete marinada o normal?", candidate_ids: [22], qty: 1, unit: "kg", source_text: "chamberete" }],
      not_on_menu: [],
      confirmed: false,
    },
    centralCatalog,
  );
  assert(invented.question == null, "no se acepta preguntar marinada si no hay dos versiones");
  assert(invented.cart.some((item) => item.productId === 22), "el chamberete que sí existe se anota");

  const throwing: CatalogModel = {
    name: "no-debe-correr",
    async interpret() {
      throw new Error("el modelo no debía correr: la respuesta corta ya resolvía la pregunta");
    },
  };
  const grande = await runCatalogOrderTurn({
    message: "Grande",
    cart: [],
    pending: {
      sourceText: "una hamburguesa de res",
      candidateIds: [1, 2],
      qty: 1,
      unit: "pz",
      variant: null,
      family: "hamburguesa de res",
      question: "¿La hamburguesa de res chica o grande?",
      count: 1,
    },
    history: [],
    catalog: georgeCatalog,
    model: throwing,
    escalationModel: null,
  });
  assert(grande.cart.some((item) => item.productId === 2), "Grande elige la hamburguesa grande");
  assert(!grande.reply.includes("chica o grande"), "Grande no repite la pregunta");

  const numero = await runCatalogOrderTurn({
    message: "2",
    cart: [],
    pending: {
      sourceText: "una hamburguesa de res",
      candidateIds: [1, 2],
      qty: 1,
      unit: "pz",
      variant: null,
      family: null,
      question: "¿La hamburguesa de res chica o grande?",
      count: 1,
    },
    history: [],
    catalog: georgeCatalog,
    model: throwing,
    escalationModel: null,
  });
  assert(numero.cart[0]?.productId === 2, "2 elige la segunda opción");

  const pepsi = await runCatalogOrderTurn({
    message: "Pepsi",
    cart: [],
    pending: {
      sourceText: "una pepsi",
      candidateIds: [5],
      qty: 1,
      unit: "pz",
      variant: null,
      family: null,
      question: "¿El refresco de qué sabor?",
      count: 1,
    },
    history: [],
    catalog: georgeCatalog,
    model: throwing,
    escalationModel: null,
  });
  assert(pepsi.cart[0]?.variant === "Pepsi", "Pepsi se anota como sabor");
  assert(!pepsi.reply.toLowerCase().includes("qué sabor"), "Pepsi no repite la pregunta");

  const normal = await runCatalogOrderTurn({
    message: "Normal",
    cart: [{ productId: 21, qty: 1, unit: "kg", variant: null, notes: null }],
    pending: {
      sourceText: "un kilo de chamberete",
      candidateIds: [22],
      qty: 1,
      unit: "kg",
      variant: null,
      family: null,
      question: "¿Chamberete marinada o normal?",
      count: 1,
    },
    history: [],
    catalog: centralCatalog,
    model: throwing,
    escalationModel: null,
  });
  assert(normal.cart.some((item) => item.productId === 22), "Normal anota el chamberete que sí existe");
  assert(normal.cart.some((item) => item.productId === 21), "Normal no borra la arrachera");
  assert(!normal.reply.toLowerCase().includes("marinada o normal"), "Normal no repite la pregunta inventada");

  const pekesCart: AgentLine[] = [
    line({ lineId: "l1", productId: 15, name: "Tortillas de harina", qty: 1, unit: "kg" }),
    line({ lineId: "l2", productId: 14, name: "Desodorante Old Spice", brand: "Old Spice" }),
    line({ lineId: "l3", productId: 3, name: "Pulpa de puerco" }),
  ];
  const question = "¿El agua mineral de 600 ml o de 2 L, la coca de 600 ml o de 2 L, y la crema Lala o Alpura?";
  const pekesCalls: string[] = [];
  const logs: Array<{ tipo: string; input: string; cart: AgentLine[] }> = [];
  const pekesTurn = await runOrderAgentTurn({
    message: "dos aguas mineral, dos cocas, un desodorante o spice, un kilo de tortillas de harina y 1/4 de crema",
    cart: [],
    pending: null,
    history: [],
    store: pekesStore,
    products: pekesProducts,
    pedidoId: 40,
    model: scripted("gpt-4o-mini", [
      {
        toolCalls: [
          tool("search_products", { query: "agua mineral" }, "s1"),
          tool("search_products", { query: "cocas" }, "s2"),
          tool("search_products", { query: "desodorante spice" }, "s3"),
          tool("search_products", { query: "tortillas de harina" }, "s4"),
          tool("search_products", { query: "crema" }, "s5"),
          tool("set_cart_line", { product_id: 15, qty: 1, unit: "kg" }, "t"),
          tool("set_cart_line", { product_id: 14, qty: 1, unit: "pz" }, "d"),
          tool("ask_customer", { text: question, candidate_ids: [10, 11, 12, 13, 16, 17] }, "q"),
        ],
      },
    ], pekesCalls),
    escalationModel: null,
    logEvent: (event) => {
      logs.push({ tipo: event.tipo, input: event.input, cart: event.cart });
    },
  });
  assert(pekesTurn.cart.some((item) => item.productId === 15), "las tortillas se quedan");
  assert(pekesTurn.cart.some((item) => item.productId === 14), "el desodorante se queda");
  assert(pekesTurn.reply.includes(question), "las dudas de abarrotes van en un solo mensaje");
  assert(pekesTurn.storeId === pekesStore.id, "Peke's no cambia de tienda");
  assert(logs[0]?.tipo === "agent_turn" && logs[0].input.includes("aguas mineral"), "el turno se registra como agent_turn");

  const followCalls: string[] = [];
  const follow = await runOrderAgentTurn({
    message: mineral,
    cart: pekesTurn.cart,
    pending: pekesTurn.pending,
    history: [
      { role: "user", text: "dos aguas mineral, dos cocas, un desodorante o spice, un kilo de tortillas de harina y 1/4 de crema" },
      { role: "assistant", text: question },
    ],
    store: pekesStore,
    products: pekesProducts,
    model: scripted("gpt-4o-mini", [
      {
        toolCalls: [
          tool("set_cart_line", { free_text: "Pedí", qty: 1, unit: "pz" }, "bad-brand"),
          tool("set_cart_line", { product_id: 10, qty: 2, unit: "pz", store_id: aguaSanta.id }, "bad-store"),
          tool("ask_customer", { text: question, candidate_ids: [10, 11] }, "repeat"),
        ],
      },
    ], followCalls),
    escalationModel: scripted("gpt-4.1-mini", [{ toolCalls: [tool("finish_cart", {}, "fin")] }], followCalls),
    logEvent: () => {},
  });
  assert(follow.cart.some((item) => item.productId === 15), "Te pedí agua mineral no borra las tortillas");
  assert(follow.cart.some((item) => item.productId === 14), "Te pedí agua mineral no borra el desodorante");
  assert(!follow.cart.some((item) => /pedi/i.test(item.name)), "Pedí no entra al carrito");
  assert(follow.storeId === pekesStore.id, "el carrito sigue en Peke's");
  assert(!follow.reply.includes(question), "no se repite la pregunta de abarrotes");
  assert(follow.reply.includes("Si tu pedido está bien, responde sí"), "la lista pide el sí");
  assert(follow.reply.includes("Solo es un ejemplo, no está en tu pedido"), "el ejemplo va marcado");
  assert(follow.reply.includes("$35"), "el abarrotes muestra los $35");
  assert(followCalls.includes("gpt-4.1-mini"), "dos fallos saltan de modelo");

  const centralLines: AgentLine[] = [
    line({ lineId: "l1", productId: 1, name: "Arrachera Marinada", qty: 1, unit: "kg", unitPrice: 280 }),
    line({ lineId: "l2", productId: 2, name: "Chamberete", qty: 1, unit: "kg", unitPrice: 155 }),
    line({ lineId: "l3", productId: 3, name: "Pulpa de puerco", qty: 0.5, unit: "kg", unitPrice: 115 }),
    line({ lineId: "l4", productId: 4, name: "Chorizo", qty: 1, unit: "kg", unitPrice: 115 }),
  ];
  const centralCalls: string[] = [];
  const centralTurn = await runOrderAgentTurn({
    message: "un kilo de Arrachera marinada, un kilo de Chamber, ETE, medio kilo de pulpa de puerco y un kilo de chorizo",
    cart: [],
    pending: null,
    history: [],
    store: centralStore,
    products: centralProducts,
    model: scripted("gpt-4o-mini", [
      {
        toolCalls: [
          tool("search_products", { query: "arrachera marinada" }, "sa"),
          tool("search_products", { query: "chamberete" }, "sc"),
          tool("search_products", { query: "pulpa de puerco" }, "sp"),
          tool("search_products", { query: "chorizo" }, "sz"),
          tool("set_cart_line", { product_id: 1, qty: 1, unit: "kg" }, "a"),
          tool("set_cart_line", { product_id: 2, qty: 1, unit: "kg" }, "c"),
          tool("set_cart_line", { product_id: 3, qty: 0.5, unit: "kg" }, "p"),
          tool("set_cart_line", { product_id: 4, qty: 1, unit: "kg" }, "z"),
          tool("ask_customer", { text: "¿Chamberete marinada o normal?", candidate_ids: [2], axis: "marinade" }, "bad-q"),
        ],
      },
    ], centralCalls),
    escalationModel: scripted("gpt-4.1-mini", [{ toolCalls: [tool("finish_cart", {}, "fin")] }], centralCalls),
    logEvent: () => {},
  });
  assert(centralTurn.cart.length === 4, "La Central conserva los cuatro cortes");
  assert(!centralTurn.reply.toLowerCase().includes("marinada o normal"), "no pregunta marinada del chamberete");
  assert(centralTurn.reply.includes("Si tu pedido está bien, responde sí"), "el ticket de La Central pide el sí");
  assert(centralTurn.reply.includes("$35"), "el ticket trae el envío de $35");
  assert(centralTurn.reply.includes("$280") || centralTurn.reply.includes("280"), "la arrachera se cobra con el precio del menú");

  const normalAgent = await runOrderAgentTurn({
    message: "Normal",
    cart: centralLines.filter((item) => item.productId !== 2),
    pending: { question: "¿Chamberete marinada o normal?", candidateIds: [2], qty: 1, unit: "kg", axis: "marinade" },
    history: [],
    store: centralStore,
    products: centralProducts,
    model: {
      name: "no",
      async complete() {
        throw new Error("Normal ya resolvía el chamberete");
      },
    },
    logEvent: () => {},
  });
  assert(normalAgent.cart.some((item) => item.productId === 2), "Normal acepta el chamberete");
  assert(normalAgent.cart.some((item) => item.productId === 1), "Normal no borra la arrachera");
  assert(!normalAgent.reply.toLowerCase().includes("marinada o normal"), "Normal no repite la pregunta");

  const held: AgentLine[] = [
    line({ lineId: "l1", productId: 3, name: "Papas a la francesa 300g", unitPrice: 45 }),
    line({ lineId: "l2", productId: 5, name: "Refresco Pepsi", variant: "Pepsi", unitPrice: 25 }),
  ];
  const sizeQuestion = "¿La hamburguesa de res chica o grande?";
  async function answerGeorge(message: string, pendingIds: number[], pendingQuestion: string) {
    return runOrderAgentTurn({
      message,
      cart: held,
      pending: { question: pendingQuestion, candidateIds: pendingIds, qty: 1, unit: "pz", axis: null },
      history: [],
      store: georgeStore,
      products: georgeProducts,
      model: {
        name: "no",
        async complete() {
          throw new Error(`${message} no debía llamar al modelo`);
        },
      },
      logEvent: () => {},
    });
  }
  const grandeAgent = await answerGeorge("Grande", [1, 2], sizeQuestion);
  assert(grandeAgent.cart.some((item) => item.productId === 2), "Grande anota la hamburguesa grande");
  assert(grandeAgent.cart.some((item) => item.productId === 3), "Grande no borra las papas");
  assert(grandeAgent.cart.some((item) => item.variant === "Pepsi"), "Grande no borra la Pepsi");
  assert(!grandeAgent.reply.includes(sizeQuestion), "Grande no repite la pregunta");

  const two = await answerGeorge("2", [1, 2], sizeQuestion);
  assert(two.cart.some((item) => item.productId === 2), "2 anota la segunda opción");
  assert(two.cart.length === 3, "2 no duplica el resto");

  const pepsiAgent = await answerGeorge("Pepsi", [5], "¿El refresco de qué sabor: Pepsi, Seven, Coca, Mirinda o Manzana?");
  assert(pepsiAgent.cart.some((item) => item.productId === 5 && item.variant === "Pepsi"), "Pepsi se anota");
  assert(!pepsiAgent.reply.toLowerCase().includes("qué sabor"), "Pepsi no repite la pregunta");

  const burger = georgeProducts[1];
  const badId = validateToolCall({
    call: tool("set_cart_line", { product_id: 999, qty: 1, unit: "pz" }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(badId.ok === false, "un id que no existe se rechaza");
  const badQty = validateToolCall({
    call: tool("set_cart_line", { product_id: burger.id, qty: 0, unit: "pz" }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(badQty.ok === false, "cantidad cero se rechaza");
  const badUnit = validateToolCall({
    call: tool("set_cart_line", { product_id: burger.id, qty: 50, unit: "pesos" }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(badUnit.ok === false, "una hamburguesa no se vende en pesos");
  const badVariant = validateToolCall({
    call: tool("set_cart_line", { product_id: 5, qty: 1, unit: "pz", variant: "Fanta" }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(badVariant.ok === false, "un sabor que no está se rechaza");
  const badStore = validateToolCall({
    call: tool("set_cart_line", { product_id: burger.id, qty: 1, unit: "pz", store_id: 99 }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(badStore.ok === false, "cambiar de tienda se rechaza");
  const offMenu = validateToolCall({
    call: tool("set_cart_line", { free_text: "pizza", qty: 1, unit: "pz" }),
    store: georgeStore,
    products: georgeProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(offMenu.ok === false && "customerNote" in offMenu && offMenu.customerNote?.includes("no lo manejamos"), "lo que no está en el menú se dice y no se anota");
  const fakeMarinade = validateToolCall({
    call: tool("ask_customer", { text: "¿Chamberete marinada o normal?", candidate_ids: [2], axis: "marinade" }),
    store: centralStore,
    products: centralProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(fakeMarinade.ok === false, "el validador rechaza la pregunta de marinada inventada");

  const steps: string[] = [];
  const capped = await runOrderAgentTurn({
    message: "sigue",
    cart: held,
    pending: null,
    history: [],
    store: georgeStore,
    products: georgeProducts,
    model: scripted("loop", Array.from({ length: 8 }, () => ({ toolCalls: [tool("set_cart_line", { product_id: 999, qty: 1, unit: "pz" })] })), steps),
    escalationModel: null,
    logEvent: () => {},
  });
  assert(steps.length === 2, "la misma llamada rechazada dos veces corta el ciclo");
  assert(capped.cart.length === held.length, "los rechazos no vacían el carrito");
  assert(!capped.reply.includes("999"), "el error de la herramienta no se le manda al cliente");

  const yes = await runOrderAgentTurn({
    message: "así está bien",
    cart: centralLines,
    pending: null,
    history: [],
    store: centralStore,
    products: centralProducts,
    awaitingList: true,
    model: {
      name: "no",
      async complete() {
        throw new Error("el sí no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(yes.confirmedList === true, "así está bien confirma la lista");
  const todoBien = await runOrderAgentTurn({
    message: "todo bien",
    cart: centralLines,
    pending: null,
    history: [],
    store: centralStore,
    products: centralProducts,
    awaitingList: true,
    logEvent: () => {},
  });
  assert(todoBien.confirmedList === true, "todo bien confirma la lista");
  const correcto = await runOrderAgentTurn({
    message: "correcto",
    cart: centralLines,
    pending: null,
    history: [],
    store: centralStore,
    products: centralProducts,
    awaitingList: true,
    logEvent: () => {},
  });
  assert(correcto.confirmedList === true, "correcto confirma la lista");

  for (const store of [pekesStore, centralStore, georgeStore]) {
    const system = buildOrderAgentSystem(store, []);
    assert(system.includes(store.name), "el prompt lleva la tienda");
    assert(system.includes("pedí"), "el prompt prohíbe tomar pedí como producto");
    if (store.category === "abarrotes") assert(system.includes("search_products"), "abarrotes pide buscar antes de preguntar");
    if (store.category === "carniceria") assert(system.includes("marinada"), "carnicería solo pregunta marinada si existen las dos");
    if (store.category === "restaurante") assert(system.includes("Clásico"), "un dogo genérico es el Clásico");
  }

  const aguaStore: AgentStore = {
    id: 4,
    name: "Abarrotes Agua Santa",
    category: "abarrotes",
    catalogMode: "list",
    hasProductList: false,
  };
  const pedidoLargo =
    "Me das 3 litros de leche 2 paquetes de tortillas de Arina 2 queso crema un kilo de de queso Chelita y un paquete de vaso de medida 16";
  const aguaFirst = await runOrderAgentTurn({
    message: pedidoLargo,
    cart: [],
    pending: null,
    history: [],
    store: aguaStore,
    products: [],
    model: scripted(
      "agua",
      [
        {
          toolCalls: [
            tool("set_cart_line", { free_text: "3 litros de leche", qty: 3, unit: "litros" }, "leche"),
            tool("set_cart_line", { free_text: "2 paquetes de tortillas de Arina", qty: 2, unit: "pz" }, "tortillas"),
            tool("set_cart_line", { free_text: "2 queso crema", qty: 2, unit: "pz" }, "crema"),
            tool("set_cart_line", { free_text: "un kilo de de queso Chelita", qty: 1, unit: "kg" }, "chelita"),
            tool("set_cart_line", { free_text: "un paquete de vaso de medida 16", qty: 1, unit: "pz" }, "vaso"),
            tool(
              "ask_customer",
              {
                text: "La leche, ¿de qué marca y entera, deslactosada o light? El queso crema, ¿de qué marca y de qué presentación?",
                axis: "brand",
              },
              "pregunta",
            ),
          ],
        },
      ],
      [],
    ),
    logEvent: () => {},
  });
  assert(!aguaFirst.cart.some((item) => /leche/i.test(item.name)), "la leche sin marca no se anota");
  assert(!aguaFirst.cart.some((item) => /crema/i.test(item.name) && !/chelita/i.test(item.name)), "el queso crema sin marca no se anota");
  const tortillas = aguaFirst.cart.find((item) => /tortilla/i.test(item.name));
  assert(tortillas?.name === "Tortillas de harina" && tortillas.qty === 2 && tortillas.variant === "de harina", "Arina queda en tortillas de harina, sin la cantidad en el nombre");
  const chelita = aguaFirst.cart.find((item) => /chelita/i.test(item.name));
  assert(chelita?.qty === 1 && chelita.unit === "kg" && !/de de|2 2/i.test(chelita.name), "el kilo de queso Chelita se anota limpio");
  const vaso = aguaFirst.cart.find((item) => /vaso/i.test(item.name));
  assert(vaso?.name === "Vaso de medida 16" && vaso.presentation === "paquete", "el vaso 16 se anota como lo dijo");
  assert(aguaFirst.reply.includes("marca"), "en un turno se pregunta lo que falta");
  assert(!aguaFirst.reply.includes("2 2"), "el resumen no duplica la cantidad");

  const aguaSecond = await runOrderAgentTurn({
    message: "Leche Lala entera y queso crema Philadelphia de 190 gramos",
    cart: aguaFirst.cart,
    pending: aguaFirst.pending,
    history: [
      { role: "user", text: pedidoLargo },
      { role: "assistant", text: aguaFirst.reply },
    ],
    store: aguaStore,
    products: [],
    model: scripted(
      "agua-2",
      [
        {
          toolCalls: [
            tool("set_cart_line", { free_text: "3 litros de leche Lala entera", qty: 1, unit: "pz" }, "leche-ok"),
            tool("set_cart_line", { free_text: "2 queso crema Philadelphia de 190 gramos", qty: 1, unit: "pz" }, "crema-ok"),
            tool("finish_cart", {}, "fin"),
          ],
        },
      ],
      [],
    ),
    logEvent: () => {},
  });
  const leche = aguaSecond.cart.find((item) => /leche/i.test(item.name));
  assert(leche?.qty === 3 && leche.unit === "l" && leche.brand === "Lala" && leche.variant === "entera", "la leche se queda en 3 L, Lala entera");
  const crema = aguaSecond.cart.find((item) => /crema/i.test(item.name));
  assert(crema?.qty === 2 && crema.brand === "Philadelphia" && !/2 2/.test(crema.name), "el queso crema queda Philadelphia, sin 2 2");
  assert(aguaSecond.reply.includes("¿Están bien estos productos?"), "el resumen usa la lista de abarrotes");
  assert(aguaSecond.reply.includes("*") && aguaSecond.reply.includes("3 litros"), "el ticket lleva negritas y los 3 litros");
  assert(!aguaSecond.reply.includes("2 2") && !aguaSecond.reply.includes("de de"), "el ticket no repite cantidades ni el tropiezo");

  const aguaSi = await runOrderAgentTurn({
    message: "sí",
    cart: aguaSecond.cart,
    pending: null,
    history: [],
    store: aguaStore,
    products: [],
    awaitingList: true,
    model: {
      name: "no",
      async complete() {
        throw new Error("el sí no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(aguaSi.confirmedList === true, "el sí confirma la lista de Agua Santa");
  const aguaItems = itemsFromAgentLines(aguaSi.cart);
  const aguaConfirm = validateCaptureForConfirmation({
    snapshot: {
      businessId: aguaStore.id,
      businessName: aguaStore.name,
      storeKind: "abarrotes",
      items: aguaItems,
      flags: { productosConfirmados: true, awaitingProductConfirm: false, agentCart: true },
    },
    items: aguaItems,
    quoteStore: false,
    userMessage: "sí",
    storeKind: "abarrotes",
  });
  const aguaAsk = aguaConfirm.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
  assert(aguaAsk.includes("ubicación por GPS") && aguaAsk === ADDRESS_ASK_MESSAGE, "el sí pasa a la ubicación");
  assert(!/maiz|harina/i.test(aguaAsk), "confirmar no vuelve a preguntar maíz o harina");

  const harina = validateToolCall({
    call: tool("set_cart_line", { free_text: "de harina", qty: 1, unit: "pz" }),
    store: aguaStore,
    products: [],
    cart: [line({ lineId: "l1", name: "Tortillas", freeText: "Tortillas", qty: 2, unit: "pz", presentation: "paquete" })],
    pending: null,
    nextLineId: "l2",
  });
  assert(harina.ok && "line" in harina && harina.line?.name === "Tortillas de harina" && harina.line.qty === 2, "de harina renombra la línea y conserva los 2");
  const cualquiera = validateToolCall({
    call: tool("set_cart_line", { free_text: "3 litros de leche la que sea", qty: 1, unit: "pz" }),
    store: aguaStore,
    products: [],
    cart: [],
    pending: null,
    nextLineId: "l1",
  });
  assert(cualquiera.ok && "line" in cualquiera && cualquiera.line?.unit === "l" && cualquiera.line.qty === 3, "la que sea anota la leche sin volver a preguntar");

  const pekesListed: AgentStore = { ...pekesStore, hasProductList: true };
  const listedProducts: AgentProduct[] = [
    product({ id: 101, name: "Leche", brand: "Lala", presentation: "1 litro" }),
    product({ id: 102, name: "Leche", brand: "Alpura", presentation: "1 litro" }),
    product({ id: 103, name: "Leche", brand: "Santa Clara", presentation: "1.5 litros" }),
    product({ id: 104, name: "Tortillas de harina", brand: "Tía Rosa", presentation: "paquete" }),
    product({ id: 105, name: "Tortillas de harina", brand: "Don Julio", presentation: "paquete" }),
    product({ id: 106, name: "Queso crema", brand: "Lala", presentation: "190 g" }),
    product({ id: 107, name: "Queso crema", brand: "Philadelphia", presentation: "190 g" }),
    product({ id: 108, name: "Queso Chelita", brand: "Chelita", presentation: "kilo" }),
    product({ id: 109, name: "Vaso de medida 16", brand: null, presentation: "paquete" }),
  ];
  const fold = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  const searchListed = (query: string): AgentProduct[] => {
    const tokens = fold(query).split(/\s+/).filter((token) => token.length >= 4);
    return listedProducts.filter((item) => {
      const hay = fold(`${item.name} ${item.brand ?? ""} ${item.presentation ?? ""}`);
      return tokens.some((token) => hay.includes(token));
    });
  };
  const withoutSearch = validateToolCall({
    call: tool("set_cart_line", { product_id: 101, qty: 3, unit: "l" }),
    store: pekesListed,
    products: listedProducts,
    cart: [],
    pending: null,
    nextLineId: "l1",
    searches: [],
    customerMessage: pedidoLargo,
  });
  assert(withoutSearch.ok === false, "Peke's no anota sin buscar");

  const pekesFirst = await runOrderAgentTurn({
    message: pedidoLargo,
    cart: [],
    pending: null,
    history: [],
    store: pekesListed,
    products: [],
    search: searchListed,
    model: scripted(
      "pekes-lista",
      [
        {
          toolCalls: [
            tool("search_products", { query: "leche" }, "b-leche"),
            tool("search_products", { query: "tortillas de harina" }, "b-tortilla"),
            tool("search_products", { query: "queso crema" }, "b-crema"),
            tool("search_products", { query: "queso Chelita" }, "b-chelita"),
            tool("search_products", { query: "vaso medida" }, "b-vaso"),
            tool("set_cart_line", { product_id: 101, qty: 3, unit: "l" }, "set-leche"),
            tool("set_cart_line", { product_id: 104, qty: 2, unit: "pz" }, "set-tortilla"),
            tool("set_cart_line", { product_id: 107, qty: 2, unit: "pz" }, "set-crema"),
            tool("set_cart_line", { product_id: 108, qty: 1, unit: "kg" }, "set-chelita"),
            tool("set_cart_line", { product_id: 109, qty: 1, unit: "pz" }, "set-vaso"),
            tool(
              "ask_customer",
              {
                text: "La leche, ¿Lala de 1 litro, Alpura de 1 litro o Santa Clara de 1.5 litros, y entera o deslactosada? Las tortillas de harina, ¿Tía Rosa o Don Julio? El queso crema, ¿Lala o Philadelphia?",
                candidate_ids: [101, 102, 103, 104, 105, 106, 107],
                axis: "brand",
              },
              "opciones",
            ),
          ],
        },
      ],
      [],
    ),
    logEvent: () => {},
  });
  assert(!pekesFirst.cart.some((item) => item.productId === 101 || item.productId === 104 || item.productId === 107), "con varias marcas no se elige una sola");
  assert(pekesFirst.cart.some((item) => item.productId === 108 && item.unit === "kg"), "el queso Chelita de la lista sí se anota");
  assert(pekesFirst.cart.some((item) => item.productId === 109), "el vaso 16 de la lista sí se anota");
  assert(pekesFirst.reply.includes("Lala") && !pekesFirst.reply.includes("Tía Rosa"), "la primera pregunta es solo la leche, con opciones reales");
  assert((pekesFirst.pending?.queue?.length ?? 0) >= 2, "tortillas y queso crema esperan en la cola");

  async function pickListed(message: string, cart: AgentLine[], productId: number, qty: number, unit: string, query: string) {
    return runOrderAgentTurn({
      message,
      cart,
      pending: null,
      history: [],
      store: pekesListed,
      products: [],
      search: searchListed,
      model: scripted(
        "pekes-elige",
        [
          {
            toolCalls: [
              tool("search_products", { query }, "busca"),
              tool("set_cart_line", { product_id: productId, qty, unit }, "anota"),
              tool("finish_cart", {}, "fin"),
            ],
          },
        ],
        [],
      ),
      logEvent: () => {},
    });
  }
  const pekesMilk = await pickListed("Lala de 1 litro entera", pekesFirst.cart, 101, 3, "l", "leche");
  assert(pekesMilk.cart.some((item) => item.productId === 101 && item.qty === 3 && item.unit === "l"), "la Lala de 1 litro queda en 3 L");
  const pekesTortilla = await pickListed("Tía Rosa", pekesMilk.cart, 104, 2, "pz", "tortillas de harina");
  assert(pekesTortilla.cart.some((item) => item.productId === 104 && item.qty === 2), "las tortillas quedan en Tía Rosa");
  const pekesCrema = await pickListed("Philadelphia", pekesTortilla.cart, 107, 2, "pz", "queso crema");
  assert(pekesCrema.cart.some((item) => item.productId === 107 && item.qty === 2), "el queso crema queda en Philadelphia");
  assert(pekesCrema.reply.includes("¿Están bien estos productos?") && pekesCrema.reply.includes("3 litros"), "Peke's lista el pedido con los 3 litros");
  assert(!pekesCrema.reply.includes("2 2"), "Peke's tampoco arma un 2 2");
  const pekesSi = await runOrderAgentTurn({
    message: "sí",
    cart: pekesCrema.cart,
    pending: null,
    history: [],
    store: pekesListed,
    products: listedProducts,
    awaitingList: true,
    model: {
      name: "no",
      async complete() {
        throw new Error("el sí no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(pekesSi.confirmedList === true, "el sí confirma la lista de Peke's");
  const pekesItems = itemsFromAgentLines(pekesSi.cart);
  const pekesConfirm = validateCaptureForConfirmation({
    snapshot: {
      businessId: pekesListed.id,
      businessName: pekesListed.name,
      storeKind: "abarrotes",
      items: pekesItems,
      flags: { productosConfirmados: true, awaitingProductConfirm: false, agentCart: true },
    },
    items: pekesItems,
    quoteStore: false,
    userMessage: "sí",
    storeKind: "abarrotes",
  });
  const pekesAsk = pekesConfirm.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
  assert(pekesAsk === ADDRESS_ASK_MESSAGE, "el sí de Peke's pasa a la ubicación");

  const aguaPrompt = buildOrderAgentSystem(aguaStore, []);
  const pekesPrompt = buildOrderAgentSystem(pekesListed, []);
  assert(aguaPrompt.includes("no tiene lista") && aguaPrompt.includes("La que sea"), "Agua Santa pregunta lo genérico y acepta la que sea");
  assert(pekesPrompt.includes("tiene lista") && pekesPrompt.includes("obligatorio"), "Peke's obliga a buscar antes de anotar");
  assert(pekesPrompt.includes("una sola duda") && pekesPrompt.includes("Un producto por mensaje"), "se pregunta un producto por mensaje");
  assert(!pekesPrompt.includes("todas las dudas juntas") && !pekesPrompt.includes("en un solo ask_customer"), "ya no se juntan las dudas");

  const orderText = "un kilo de queso Chelita, un Fuse ti morado, un Fabuloso, unos chicles, una lata de maíz y un pan bimbo";
  const nightProducts: AgentProduct[] = [
    product({ id: 201, name: "Queso", brand: "Chelita", presentation: "1 kg", alias: ["queso chelita"] }),
    product({ id: 202, name: "Queso", brand: "Chelita", presentation: "250 g", alias: ["queso chelita"] }),
    product({ id: 203, name: "Amper Mora Azul", brand: "Amper", presentation: "600 ml", alias: ["amper"] }),
    product({ id: 204, name: "Fuzetea Frutos Rojos", brand: "Fuze Tea", presentation: "600 ml", alias: ["fuse", "fuze", "fusi", "frutos rojos"] }),
    product({ id: 205, name: "Fabuloso", brand: "Fabuloso", presentation: "lavanda 1 L", alias: ["fabuloso"] }),
    product({ id: 206, name: "Chicles", brand: "Clorets", presentation: "caja", alias: ["chicle", "chicles"] }),
    product({ id: 207, name: "Maíz", brand: "La Costeña", presentation: "lata 220 g", alias: ["elote", "maiz costeña"] }),
    product({ id: 208, name: "Maíz Morado", brand: "Morado", presentation: "bolsa 500 g", alias: ["maiz morado"] }),
    product({ id: 209, name: "Bimbo Blanco", brand: "Bimbo", presentation: "620 g", alias: ["pan bimbo"] }),
    product({ id: 210, name: "Bimbo Blanco Ch", brand: "Bimbo", presentation: "300 g", alias: ["pan bimbo"] }),
  ];
  const nightStore: AgentStore = { ...pekesStore, hasProductList: true };
  const nightSearch = (query: string) => searchAgentProducts(nightProducts, query, 8);
  const blockedNight = await runOrderAgentTurn({
    message: orderText,
    cart: [],
    pending: null,
    history: [],
    store: nightStore,
    products: [],
    search: nightSearch,
    model: scripted("noche-mal", [
      {
        toolCalls: [
          tool("search_products", { query: "queso chelita" }, "q"),
          tool("search_products", { query: "fuse ti morado" }, "f"),
          tool("search_products", { query: "pan bimbo" }, "p"),
          tool("search_products", { query: "lata de maiz" }, "m"),
          tool("set_cart_line", { product_id: 202, qty: 1, unit: "pz" }, "chelita-chica"),
          tool("set_cart_line", { product_id: 203, qty: 1, unit: "pz" }, "amper"),
          tool("set_cart_line", { product_id: 208, qty: 1, unit: "pz" }, "morado"),
          tool("set_cart_line", { product_id: 209, qty: 1, unit: "pz" }, "bimbo"),
        ],
      },
    ], []),
    logEvent: () => {},
  });
  assert(!blockedNight.cart.some((line) => line.productId === 203), "no agrega el Amper que no pidió");
  assert(!blockedNight.cart.some((line) => line.productId === 202), "no elige solo el Chelita de 250 g");
  assert(!blockedNight.cart.some((line) => line.productId === 208), "no elige el maíz morado si hay latas");
  assert(!blockedNight.cart.some((line) => line.productId === 210), "no elige el pan Bimbo chico");
  assert(blockedNight.cart.some((line) => line.productId === 207), "la lata de maíz es La Costeña");
  const kept: AgentLine[] = [
    line({ lineId: "l1", productId: 201, name: "Queso", brand: "Chelita", presentation: "1 kg", qty: 1, unit: "kg" }),
    line({ lineId: "l2", productId: 205, name: "Fabuloso", brand: "Fabuloso" }),
    line({ lineId: "l3", productId: 206, name: "Chicles", brand: "Clorets" }),
  ];
  const dropFabuloso = validateToolCall({
    call: tool("remove_line", { line_id: "l2" }),
    store: nightStore,
    products: nightProducts,
    cart: kept,
    pending: { question: "¿El Fuse de frutos rojos?", candidateIds: [204], qty: 1, unit: "pz", axis: null },
    nextLineId: "l9",
    customerMessage: "No quítame el Amper, era un Fusi de frutos rojos",
  });
  assert(dropFabuloso.ok === false, "no quita el Fabuloso si el cliente no lo pidió");
  const nightYes = await runOrderAgentTurn({
    message: "Sí",
    cart: kept,
    pending: null,
    history: [],
    store: nightStore,
    products: nightProducts,
    awaitingList: false,
    model: {
      name: "no",
      async complete() {
        throw new Error("el sí con carrito no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(nightYes.cart.length === 3 && nightYes.reply.includes("¿Están bien estos productos?"), "el sí muestra la lista y no borra líneas");
  assert(nightYes.reply.includes("Chelita") && nightYes.reply.includes("Fabuloso") && nightYes.reply.includes("Chicles"), "la lista trae marca y producto");
  const nightConfirm = await runOrderAgentTurn({
    message: "Así está bien",
    cart: kept,
    pending: null,
    history: [],
    store: nightStore,
    products: nightProducts,
    awaitingList: true,
    model: {
      name: "no",
      async complete() {
        throw new Error("así está bien no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(nightConfirm.confirmedList === true && nightConfirm.cart.length === 3, "así está bien confirma la lista");
  const nightItems = itemsFromAgentLines(nightConfirm.cart);
  const nightLocation = validateCaptureForConfirmation({
    snapshot: {
      businessId: nightStore.id,
      businessName: nightStore.name,
      storeKind: "abarrotes",
      items: nightItems,
      flags: { productosConfirmados: true, awaitingProductConfirm: false, agentCart: true },
    },
    items: nightItems,
    quoteStore: false,
    userMessage: "Así está bien",
    storeKind: "abarrotes",
  });
  const nightAsk = nightLocation.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
  assert(nightAsk === ADDRESS_ASK_MESSAGE, "así está bien de la noche pasa a la ubicación");
  const withAmper = [
    ...kept,
    line({ lineId: "l4", productId: 203, name: "Amper Mora Azul", brand: "Amper", presentation: "600 ml" }),
  ];
  const quitalo = await runOrderAgentTurn({
    message: "Mejor quítamelo",
    cart: withAmper,
    pending: { question: "¿El Amper Mora Azul?", candidateIds: [203], qty: 1, unit: "pz", axis: null },
    history: [],
    store: nightStore,
    products: nightProducts,
    model: scripted("quita-amper", [{ toolCalls: [tool("remove_line", { line_id: "l4" }, "quita")] }], []),
    logEvent: () => {},
  });
  assert(!quitalo.cart.some((item) => item.productId === 203), "quítamelo quita el Amper de la pregunta");
  assert(quitalo.cart.some((item) => item.productId === 205) && quitalo.cart.some((item) => item.productId === 206), "quítamelo deja Fabuloso y chicles");
  const costeña = await runOrderAgentTurn({
    message: "1",
    cart: kept,
    pending: {
      question: "¿Cuál lata de maíz?\n\n1. La Costeña 220 g\n\n2. Maíz Morado",
      candidateIds: [207, 208],
      qty: 1,
      unit: "pz",
      axis: null,
    },
    history: [],
    store: nightStore,
    products: nightProducts,
    model: {
      name: "no",
      async complete() {
        throw new Error("el 1 de la lata no debía llamar al modelo");
      },
    },
    logEvent: () => {},
  });
  assert(costeña.cart.some((item) => item.productId === 207), "el 1 se queda con la lata Costeña");
  assert(!costeña.cart.some((item) => item.productId === 208), "el 1 no anota el maíz morado");
  const namedCan = validateToolCall({
    call: tool("set_cart_line", { product_id: 207, qty: 1, unit: "pz" }, "costena"),
    store: nightStore,
    products: nightProducts,
    cart: kept,
    pending: null,
    nextLineId: "l8",
    searches: [{ query: "lata de maiz la costeña", products: nightProducts.filter((item) => item.id === 207 || item.id === 208) }],
    customerMessage: "es una lata de la costeña de maíz",
  });
  assert(namedCan.ok === true, "si nombra La Costeña se anota esa lata");

  const priced = centralTurn.reply;
  assert(priced.includes("*"), "el ticket usa negritas de WhatsApp");
  const unused: AiOutput = { cart: [], pending: [], not_on_menu: [], confirmed: false };
  assert(unused.confirmed === false, "el tipo del modelo viejo sigue compilando");

  const groceryMenu: AgentProduct[] = [
    product({ id: 301, name: "Jamón", brand: "FUD", presentation: "250 g", alias: ["jamon"] }),
    product({ id: 302, name: "Jamón", brand: "Zwan", presentation: "250 g", alias: ["jamon"] }),
    product({ id: 303, name: "Jamón", brand: "San Rafael", presentation: "250 g", alias: ["jamon"] }),
    product({ id: 304, name: "Jamón", brand: "Chimex", presentation: "250 g", alias: ["jamon"] }),
    product({ id: 305, name: "Jamón", brand: "Capistrano", presentation: "250 g", alias: ["jamon"] }),
    product({ id: 306, name: "Jamón", brand: "Extra", presentation: "500 g", alias: ["jamon"] }),
    product({ id: 311, name: "Leche", brand: "Lala", presentation: "1 L", alias: ["leche"] }),
    product({ id: 312, name: "Leche", brand: "Alpura", presentation: "1 L", alias: ["leche"] }),
    product({ id: 321, name: "Chicles", brand: "Trident", presentation: "caja", alias: ["chicle", "chicles"] }),
    product({ id: 322, name: "Chicles", brand: "Clorets", presentation: "caja", alias: ["chicle", "chicles"] }),
  ];
  const searchGrocery = (query: string): AgentProduct[] => {
    const folded = fold(query);
    const tokens = folded.split(/\s+/).filter((token) => token.length >= 4);
    return groceryMenu.filter((item) => {
      const hay = fold(`${item.name} ${item.brand ?? ""} ${item.presentation ?? ""} ${(item.alias ?? []).join(" ")}`);
      return tokens.some((token) => hay.includes(token));
    });
  };
  let groceryModelCalls = 0;
  const groceryModel: AgentModel = {
    name: "falso-abarrotes",
    async complete() {
      groceryModelCalls += 1;
      if (groceryModelCalls > 1) throw new Error("la cola no debía llamar al modelo otra vez");
      return {
        toolCalls: [
          tool("search_products", { query: "jamón" }, "j"),
          tool("search_products", { query: "leche" }, "l"),
          tool("search_products", { query: "chicles" }, "c"),
          tool(
            "ask_customer",
            {
              text: "¿Qué jamón, qué leche y qué chicles quieres?",
              candidate_ids: [301, 302, 303, 304, 305, 306, 311, 312, 321, 322],
              axis: "brand",
            },
            "mix",
          ),
        ],
        text: null,
      };
    },
  };
  const jamon = await runOrderAgentTurn({
    message: "jamón, leche y chicles",
    cart: [],
    pending: null,
    history: [],
    store: pekesListed,
    products: [],
    search: searchGrocery,
    model: groceryModel,
    logEvent: () => {},
  });
  const jamonOptions = jamon.reply.split("\n").filter((line) => /^\d+\./.test(line.trim()));
  assert(jamonOptions.length === 5, "el jamón pregunta máximo 5 opciones reales");
  assert(jamon.reply.includes("FUD") && jamon.reply.includes("Capistrano") && !jamon.reply.includes("Extra"), "salen las primeras 5 marcas de jamón");
  assert(!jamon.reply.includes("Lala") && !jamon.reply.includes("Trident"), "leche y chicles no van en el mismo mensaje");
  assert(!jamon.reply.includes("¿Están bien estos productos?"), "con la cola llena no se muestra la lista");
  assert(jamon.pending?.queue?.length === 2, "quedan dos productos en la cola");
  const storedAsk = snapshotFieldsFromAgentPending(jamon.pending as AgentPending);
  assert(storedAsk.count === 3, "pendingAsk.count cuenta la duda actual y la cola");
  const restored = agentPendingFromStoredAsk({
    itemKey: "agent",
    slots: [],
    question: storedAsk.question ?? "",
    count: storedAsk.count ?? 1,
    mode: "ask",
    catalog: {
      sourceText: storedAsk.question ?? "",
      candidateIds: jamon.pending?.candidateIds ?? [],
      qty: 1,
      unit: "pz",
      variant: null,
      family: null,
      question: storedAsk.question ?? "",
      count: storedAsk.count ?? 1,
    },
    agentUnit: storedAsk.agentUnit,
    agentQty: storedAsk.agentQty,
    agentAxis: storedAsk.agentAxis,
    agentQuery: storedAsk.agentQuery,
    agentQueue: storedAsk.agentQueue,
  });
  assert(restored?.query === "jamón" && restored.queue?.length === 2, "la cola se lee otra vez desde pendingAsk");
  const lecheTurn = await runOrderAgentTurn({
    message: "1",
    cart: jamon.cart,
    pending: restored,
    history: [],
    store: pekesListed,
    products: [],
    search: searchGrocery,
    model: groceryModel,
    logEvent: () => {},
  });
  assert(lecheTurn.cart.some((item) => item.productId === 301), "el 1 se queda con el primer jamón");
  assert(lecheTurn.reply.includes("Lala") && lecheTurn.reply.includes("Alpura"), "sigue la leche, con opciones de la búsqueda");
  assert(!lecheTurn.reply.includes("¿Están bien estos productos?"), "todavía no se lista");
  assert(lecheTurn.pending?.queue?.length === 1, "los chicles siguen en la cola");
  const chiclesTurn = await runOrderAgentTurn({
    message: "2",
    cart: lecheTurn.cart,
    pending: lecheTurn.pending,
    history: [],
    store: pekesListed,
    products: [],
    search: searchGrocery,
    model: groceryModel,
    logEvent: () => {},
  });
  assert(chiclesTurn.cart.some((item) => item.productId === 312), "el 2 se queda con Alpura");
  assert(chiclesTurn.reply.includes("Trident") && chiclesTurn.reply.includes("Clorets"), "al final se preguntan los chicles");
  assert(!chiclesTurn.reply.includes("¿Están bien estos productos?"), "la lista espera a que la cola se vacíe");
  const listed = await runOrderAgentTurn({
    message: "1",
    cart: chiclesTurn.cart,
    pending: chiclesTurn.pending,
    history: [],
    store: pekesListed,
    products: [],
    search: searchGrocery,
    model: groceryModel,
    logEvent: () => {},
  });
  assert(groceryModelCalls === 1, "resolver la cola no vuelve a llamar al modelo");
  assert(listed.pending == null, "la cola quedó vacía");
  assert(listed.cart.some((item) => item.productId === 321) && listed.cart.length === 3, "el pedido trae jamón, leche y chicles");
  assert(listed.reply.includes("¿Están bien estos productos?"), "con la cola vacía sí se lista");

  const dogos = await runOrderAgentTurn({
    message: "dos dogos",
    cart: [],
    pending: null,
    history: [],
    store: georgeStore,
    products: georgeProducts,
    model: scripted(
      "dogos",
      [
        {
          toolCalls: [
            tool("search_products", { query: "dogo" }, "d"),
            tool("set_cart_line", { product_id: 6, qty: 2, unit: "pz" }, "set-dogo"),
            tool("finish_cart", {}, "fin"),
          ],
        },
      ],
      [],
    ),
    logEvent: () => {},
  });
  assert(dogos.reply.includes("Dogo") && dogos.reply.includes("¿Están bien estos productos?"), "los dogos se listan");
  const stale: AgentPending = {
    question: "¿Cuál refresco, Pepsi o Coca?",
    candidateIds: [5],
    qty: 1,
    unit: "pz",
    axis: "flavor",
  };
  for (const message of ["sí", "así está bien", "1", "ok sí"]) {
    const turn = await runOrderAgentTurn({
      message,
      cart: dogos.cart,
      pending: stale,
      history: [],
      store: georgeStore,
      products: georgeProducts,
      awaitingList: true,
      model: {
        name: "no",
        async complete() {
          throw new Error("el sí de la lista no debía llamar al modelo");
        },
      },
      logEvent: () => {},
    });
    assert(turn.confirmedList === true && turn.pending == null, `${message} confirma la lista aunque haya pending viejo`);
    assert(turn.cart.length === 1 && turn.cart[0]?.productId === 6, `${message} no agrega el refresco del pending viejo`);
  }
  const closedAsk = formatScheduledLocationAsk(
    "George está cerrada ahora. Tu pedido se programa y te lo mando en cuanto se pueda.",
  );
  assert(closedAsk.includes("se programa") && closedAsk.includes("ubicación por GPS"), "fuera de horario se avisa que se programa y se pide el pin");
  assert(formatScheduledLocationAsk(null) === ADDRESS_ASK_MESSAGE, "en horario solo se pide la ubicación");
  assert(fixedCatalogStepAfterList({ hasLocation: false, canDispatchNow: false }) === "ask_location", "sin pin se pide la ubicación");
  assert(fixedCatalogStepAfterList({ hasLocation: true, canDispatchNow: false }) === "schedule", "con pin y cerrado se programa");
  assert(fixedCatalogStepAfterList({ hasLocation: true, canDispatchNow: true }) === "dispatch", "con pin y en horario se manda");
  const finishShown = await runOrderAgentTurn({
    message: "xyzzy",
    cart: dogos.cart,
    pending: stale,
    history: [],
    store: georgeStore,
    products: georgeProducts,
    awaitingList: true,
    model: scripted("fin-lista", [{ toolCalls: [tool("finish_cart", {}, "fin")] }], []),
    logEvent: () => {},
  });
  assert(finishShown.confirmedList === true && finishShown.pending == null, "finish_cart con la lista ya mostrada confirma");
  const vague = await runOrderAgentTurn({
    message: "una hamburguesa",
    cart: [],
    pending: null,
    history: [],
    store: georgeStore,
    products: georgeProducts,
    model: scripted(
      "vago",
      [{ toolCalls: [tool("search_products", { query: "hamburguesa" }, "h")] }, { toolCalls: [], text: "¿Quieres algo más?" }],
      [],
    ),
    logEvent: () => {},
  });
  assert(vague.pending != null && /chica/i.test(vague.reply) && /grande/i.test(vague.reply), "una hamburguesa pregunta chica o grande");
  assert(!vague.reply.includes("Quieres algo más"), "la pregunta vaga no reemplaza las opciones");

  const archiveMigration = readFileSync(new URL("../supabase/migrations/20261016_conversaciones_archivo.sql", import.meta.url), "utf8");
  assert(/create table if not exists public\.conversaciones_archivo/i.test(archiveMigration), "la migración crea conversaciones_archivo");
  assert(/telefono/i.test(archiveMigration) && /pedido_id/i.test(archiveMigration) && /payload jsonb/i.test(archiveMigration), "el archivo guarda teléfono, pedido y payload");
  assert(!/\b(drop|delete)\b/i.test(archiveMigration), "la migración no borra tablas ni filas");

  console.log("[order-agent] ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
