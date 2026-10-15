/**
 * Agente de pedido y los arreglos que van prendidos aunque ORDER_AGENT esté apagado.
 * No llama a OpenAI. Correr: npx tsx scripts/check-order-agent.ts
 */
import { checkAiOutput } from "../src/lib/catalogOrder/accept";
import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import { runCatalogOrderTurn } from "../src/lib/catalogOrder/engine";
import type { AiOutput, CatalogModel } from "../src/lib/catalogOrder/types";
import { storeSwitchFromCapture, type UxStore } from "../src/lib/customerUx";
import {
  buildOrderAgentSystem,
  orderAgentEnabled,
  orderAgentEscalationModel,
  orderAgentModel,
  ORDER_AGENT_MAX_STEPS,
  runOrderAgentTurn,
  validateToolCall,
  type AgentLine,
  type AgentModel,
  type AgentProduct,
  type AgentStore,
  type ToolCall,
} from "../src/lib/orderAgent";
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
  assert(steps.length === ORDER_AGENT_MAX_STEPS, "el ciclo de herramientas se detiene a los 6 pasos");
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

  const priced = centralTurn.reply;
  assert(priced.includes("*"), "el ticket usa negritas de WhatsApp");
  const unused: AiOutput = { cart: [], pending: [], not_on_menu: [], confirmed: false };
  assert(unused.confirmed === false, "el tipo del modelo viejo sigue compilando");
  console.log("[order-agent] ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
