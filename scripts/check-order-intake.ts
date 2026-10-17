/**
 * Toma de pedido: el modelo decide, el código valida y renderiza.
 * Reproduce los mensajes de Víctor (15:45 y 17:30) con un modelo mock.
 * No llama a OpenAI, WhatsApp ni Supabase.
 * Correr: npx tsx scripts/check-order-intake.ts
 */
import { readFileSync } from "node:fs";

import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import type { RawCatalogRow } from "../src/lib/catalogOrder/types";
import { confirmsShownProductList } from "../src/lib/messages";
import {
  agentLinesFromItems,
  agentProductsFromCatalog,
  buildOrderAgentSystem,
  itemsFromAgentLines,
  runOrderAgentTurn,
  type AgentLine,
  type AgentModel,
  type AgentPending,
  type AgentProduct,
  type AgentStore,
} from "../src/lib/orderAgent";
import type { AgentModelRequest } from "../src/lib/orderAgent/types";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { rankListaCandidates } from "../src/lib/storeProductSearch";
import type { ListaProducto } from "../src/lib/storeProductList";
import { createSimAgentModel } from "./sim/agent-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Fixture = {
  id: number;
  nombre_producto: string;
  precio: number | null;
  disponible?: boolean;
  categoria?: string | null;
  alias?: string[] | null;
  marca?: string | null;
  presentacion?: string | null;
};

function load(path: string): Fixture[] {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture[];
}

function asRaw(rows: Fixture[]): RawCatalogRow[] {
  return rows.map((row) => ({
    id: row.id,
    nombreProducto: row.nombre_producto,
    precio: row.precio ?? 0,
    categoria: row.categoria ?? null,
    alias: row.alias ?? [],
    disponible: row.disponible !== false,
  }));
}

function asLista(rows: Fixture[]): AgentProduct[] {
  return rows
    .filter((row) => row.disponible !== false)
    .map((row) => ({
      id: row.id,
      name: row.nombre_producto,
      price: row.precio,
      available: true,
      unit: "pz" as const,
      variants: [],
      brand: row.marca ?? null,
      presentation: row.presentacion ?? null,
      alias: row.alias ?? [],
      category: row.categoria ?? null,
    }));
}

const pekesStore: AgentStore = {
  id: 7,
  name: "Mini Super Peke's",
  category: "abarrotes",
  catalogMode: "list",
  hasProductList: true,
};
const georgeStore: AgentStore = {
  id: 5,
  name: "Hamburguesas Hotdogs George",
  category: "restaurante",
  catalogMode: "fixed",
};
const centralStore: AgentStore = {
  id: 6,
  name: "Carnicería La Central",
  category: "carniceria",
  catalogMode: "fixed",
};

const extraPekes: Fixture[] = [
  { id: 6088, nombre_producto: "Powerade Rojo 600ml", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 6120, nombre_producto: "Powerade Rojo 1l", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 6201, nombre_producto: "Powerade Azul 600ml", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 6302, nombre_producto: "Powerade Mora Azul 600ml", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 6400, nombre_producto: "Powerade Uva 500ml", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 6485, nombre_producto: "Powerade Rojo 500ml", precio: null, marca: "Powerade", categoria: "bebidas" },
  { id: 7101, nombre_producto: "Mentas Menta 1.3kg", precio: null, marca: "Mentas", categoria: "dulces" },
  { id: 7102, nombre_producto: "Halls Menta", precio: null, marca: "Halls", categoria: "dulces" },
  { id: 7104, nombre_producto: "Crema Sello Rojo 1k", precio: null, marca: "Sello Rojo", categoria: "lacteos" },
];

const pekesProducts = asLista([...load("scripts/fixtures/pekes-real.json"), ...extraPekes]);
const georgeProducts = agentProductsFromCatalog(buildCatalog(asRaw(load("scripts/fixtures/george-catalogo.json")), "restaurante"));
const centralProducts = agentProductsFromCatalog(buildCatalog(asRaw(load("scripts/fixtures/lacentral-catalogo.json")), "carniceria"));

function row(id: number, nombre: string, marca: string | null = null): ListaProducto & { id: number } {
  return { id, nombre, marca, presentacion: null, categoria: null, alias: [], precio: null };
}

/** El ranking devuelve la misma fila. El id no está en el tipo ListaProducto. */
function rankedId(item: ListaProducto | undefined): number | null {
  if (!item) return null;
  const id = (item as ListaProducto & { id?: number }).id;
  return typeof id === "number" ? id : null;
}

function searchRank(): void {
  const drinks = [
    row(6088, "Powerade Rojo 600ml", "Powerade"),
    row(6120, "Powerade Rojo 1l", "Powerade"),
    row(6201, "Powerade Azul 600ml", "Powerade"),
    row(7104, "Crema Sello Rojo 1k", "Sello Rojo"),
    row(7101, "Mentas Menta 1.3kg", "Mentas"),
    row(7102, "Halls Menta", "Halls"),
  ];
  const pawer = rankListaCandidates(drinks, "pawer rojo", 8);
  assert(pawer.length > 0 && pawer.every((item) => /powerade/i.test(item.nombre)), `pawer rojo no cayó en Powerade: ${pawer.map((item) => item.nombre).join(", ")}`);
  assert(pawer.some((item) => {
    const id = rankedId(item);
    return id != null && id >= 6088 && id <= 6485;
  }), "pawer no usa los Powerade 6088-6485");
  const halls = rankListaCandidates(drinks, "unas mentas halls", 5);
  assert(rankedId(halls[0]) === 7102, `Halls Menta no ganó: ${halls.map((item) => item.nombre).join(", ")}`);
  const pepsi = rankListaCandidates([row(30, "Refresco (Pepsi, Seven, Coca, Mirinda o Manzana)")], "Pepe si", 4);
  assert(rankedId(pepsi[0]) === 30, "Pepe si no encuentra el Refresco");
}

function contextReachesModel(): Promise<void> {
  const seen: AgentModelRequest[] = [];
  const coca: AgentProduct[] = [
    { id: 12, name: "Coca-Cola 600 ml", price: null, available: true, unit: "pz", variants: [], brand: "Coca-Cola", presentation: "600 ml", alias: ["coca"], category: null },
    { id: 13, name: "Coca-Cola 2 L", price: null, available: true, unit: "pz", variants: [], brand: "Coca-Cola", presentation: "2 L", alias: ["coca"], category: null },
  ];
  const model: AgentModel = {
    name: "ctx",
    async complete(request) {
      seen.push(request);
      if (!request.toolTrace.length) {
        return { toolCalls: [{ id: "s", name: "search_products", arguments: { query: "coca" } }], text: "texto libre que no debe salir" };
      }
      return {
        toolCalls: [{ id: "q", name: "ask_customer", arguments: { text: "¿Cuál coca?", candidate_ids: [12, 13], axis: "size" } }],
        text: null,
      };
    },
  };
  const cart: AgentLine[] = [{
    lineId: "l1",
    productId: 723,
    freeText: null,
    name: "Tortillas",
    qty: 1,
    unit: "kg",
    variant: null,
    note: null,
    unitPrice: null,
    brand: null,
    presentation: null,
  }];
  return runOrderAgentTurn({
    message: "una coca",
    cart,
    pending: null,
    history: [{ role: "user", text: "Hola" }, { role: "assistant", text: "¿Qué se te antoja?" }],
    store: pekesStore,
    products: [],
    search: async () => coca,
    model,
    logEvent: () => {},
  }).then((turn) => {
    assert(seen.length >= 2, "el modelo no recibió el resultado de la búsqueda");
    const first = seen[0];
    const second = seen[1];
    assert(first.history.length === 2 && first.history[0]?.text === "Hola", "el historial no llegó al modelo");
    assert(first.cart.some((line) => line.productId === 723), "el carrito con id no llegó al modelo");
    assert(first.system.includes("723") || JSON.stringify(first.cart).includes("723"), "el system no trae el id del carrito");
    const found = second.toolTrace.some((entry) => entry.ok && entry.call.name === "search_products" && JSON.stringify(entry.result).includes("Coca-Cola"));
    assert(found, "el segundo paso no trae los resultados de búsqueda");
    assert(second.system.includes("12") && second.system.includes("Coca-Cola"), "el system del segundo paso no trae el catálogo buscado");
    assert(!turn.reply.includes("texto libre"), "salió texto libre del modelo");
    assert(turn.reply.includes("*"), "la pregunta no usa el formato de la bienvenida");
    const pending: AgentPending = {
      question: "❓ *De coca, ¿cuál de estos?*\n\n1. *Coca-Cola 600 ml*",
      candidateIds: [12, 13],
      qty: 1,
      unit: "pz",
      axis: "size",
      query: "coca",
    };
    const later: AgentModelRequest[] = [];
    const listener: AgentModel = {
      name: "pending",
      async complete(request) {
        later.push(request);
        return { toolCalls: [], text: null };
      },
    };
    return runOrderAgentTurn({
      message: "la grande",
      cart,
      pending,
      history: [{ role: "assistant", text: pending.question }],
      store: pekesStore,
      products: coca,
      model: listener,
      logEvent: () => {},
    }).then(() => {
      assert(later[0]?.pending?.question?.includes("cuál de estos"), "la pregunta pendiente no llegó al modelo");
      assert(later[0]?.system.includes("12") && later[0]?.system.includes("13"), "las opciones mostradas no están en el system");
      assert(buildOrderAgentSystem(pekesStore, cart, coca, pending).includes("Pregunta pendiente"), "el system no nombra la pregunta pendiente");
    });
  });
}

const QUESTION = /cu[aá]l de estos|marinada o normal|qu[eé] sabor|deseas quitarlo/i;

type Play = {
  id: string;
  store: AgentStore;
  products: AgentProduct[];
  messages: string[];
  cartIncludes?: string[];
  cartExcludes?: string[];
  maxQuestions?: number;
};

async function play(item: Play): Promise<{ cart: AgentLine[]; replies: string[]; questions: number }> {
  let cart: AgentLine[] = [];
  let pending: AgentPending | null = null;
  let awaiting = false;
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  const replies: string[] = [];
  let questions = 0;
  for (const message of item.messages) {
    const before = cart.map((line) => line.productId);
    const turn = await runOrderAgentTurn({
      message,
      cart,
      pending,
      history,
      store: item.store,
      products: item.store.catalogMode === "fixed" ? item.products : [],
      search: async (query) => searchAgentProducts(item.products, query, 24),
      model: createSimAgentModel(item.id),
      escalationModel: null,
      awaitingList: awaiting,
      logEvent: () => {},
    });
    for (const id of before) {
      if (id == null) continue;
      if (!turn.cart.some((line) => line.productId === id) && !/^(no|ninguno|ninguna|quita|seguimos)/i.test(message)) {
        throw new Error(`${item.id}: se perdió el producto ${id} con «${message}»`);
      }
    }
    if (turn.confirmedList && !confirmsShownProductList(message)) {
      throw new Error(`${item.id}: confirmó la lista sin un sí del cliente («${message}»)`);
    }
    if (/ubicaci[oó]n por gps/i.test(turn.reply)) {
      throw new Error(`${item.id}: pidió ubicación`);
    }
    if (/ya anot[eé]/i.test(turn.reply)) throw new Error(`${item.id}: salió «Ya anoté»`);
    if (turn.reply.trim() && !turn.reply.includes("*")) throw new Error(`${item.id}: texto sin formato: ${turn.reply.slice(0, 180)}`);
    const blocks = turn.reply.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
    if (new Set(blocks).size !== blocks.length) throw new Error(`${item.id}: texto duplicado`);
    const previous = replies[replies.length - 1] ?? "";
    if (previous && turn.reply.trim() === previous.trim() && QUESTION.test(turn.reply)) {
      throw new Error(`${item.id}: repitió la misma pregunta`);
    }
    if (QUESTION.test(turn.reply)) questions += 1;
    cart = turn.cart;
    pending = turn.pending;
    awaiting = turn.reply.includes("¿Están bien estos productos?");
    history.push({ role: "user", text: message }, { role: "assistant", text: turn.reply });
    replies.push(turn.reply);
  }
  const names = cart.map((line) => `${line.qty} ${line.name} ${line.variant ?? ""}`).join(" | ");
  const said = replies.join("\n");
  for (const piece of item.cartIncludes ?? []) {
    assert(names.toLowerCase().includes(piece.toLowerCase()) || said.toLowerCase().includes(piece.toLowerCase()), `${item.id}: no quedó «${piece}». ${names}`);
  }
  for (const piece of item.cartExcludes ?? []) {
    assert(!names.toLowerCase().includes(piece.toLowerCase()), `${item.id}: no debía quedar «${piece}». ${names}`);
  }
  const cap = item.maxQuestions ?? 2;
  assert(questions <= cap, `${item.id}: ${questions} preguntas, el tope es ${cap}`);
  return { cart, replies, questions };
}

const pekesOrders: Play[] = [
  { id: "p-victor-1545", store: pekesStore, products: pekesProducts, messages: ["Quiero 2 fuste de frutos rojos también 1 kilo de frijol 1 litro de fabuloso y un nito", "Cuáles tienes?", "1"], cartIncludes: ["Fuzetea", "Nito"], cartExcludes: ["frijol"] },
  { id: "p-victor-1730", store: pekesStore, products: pekesProducts, messages: ["Quiero un kilo de tortillas también un pawer rojo también unos takis y unas mentas halls", "No es ninguno de los que me mostraste", "Creo que las mentas que dices no son los correctas de cuales tienes?", "Del 5", "Ninguna de las mostradas", "Seguimos"], cartIncludes: ["Tortilla", "Takis"], cartExcludes: ["Sello Rojo", "Mentas Menta"], maxQuestions: 3 },
  { id: "p-coca", store: pekesStore, products: pekesProducts, messages: ["una coca de 600 y un sabritas", "1"], cartIncludes: ["600"] },
  { id: "p-nito", store: pekesStore, products: pekesProducts, messages: ["un nito"], cartIncludes: ["Nito"] },
  { id: "p-bonafont", store: pekesStore, products: pekesProducts, messages: ["un agua donado de litro"], cartIncludes: ["Bonafont"] },
  { id: "p-fabuloso", store: pekesStore, products: pekesProducts, messages: ["un litro de fabuloso", "1"], cartIncludes: ["Fabuloso"] },
  { id: "p-aceite", store: pekesStore, products: pekesProducts, messages: ["un litro de aceite", "1"], cartIncludes: ["Aceite"] },
  { id: "p-azucar", store: pekesStore, products: pekesProducts, messages: ["un kilo de azucar", "1"] },
  { id: "p-leche", store: pekesStore, products: pekesProducts, messages: ["2 leches lala de litro", "1"], cartIncludes: ["Lala"] },
  { id: "p-cloro", store: pekesStore, products: pekesProducts, messages: ["un cloro"], cartIncludes: ["Cloro"] },
  { id: "p-galletas", store: pekesStore, products: pekesProducts, messages: ["unas galletas marias", "1"], cartIncludes: ["Marias"] },
  { id: "p-jugo", store: pekesStore, products: pekesProducts, messages: ["un jugo del valle", "1"] },
  { id: "p-ciel", store: pekesStore, products: pekesProducts, messages: ["un agua ciel", "1"], cartIncludes: ["Ciel"] },
  { id: "p-papel", store: pekesStore, products: pekesProducts, messages: ["un papel higienico", "1"] },
  { id: "p-pan", store: pekesStore, products: pekesProducts, messages: ["un pan bimbo", "1"], cartIncludes: ["Bimbo"] },
  { id: "p-takis", store: pekesStore, products: pekesProducts, messages: ["unos takis"], cartIncludes: ["Takis"] },
  { id: "p-halls", store: pekesStore, products: pekesProducts, messages: ["unas mentas halls"], cartIncludes: ["Halls"], cartExcludes: ["Mentas Menta"] },
  { id: "p-pawer", store: pekesStore, products: pekesProducts, messages: ["un pawer rojo", "1"], cartIncludes: ["Powerade"], cartExcludes: ["Sello Rojo"] },
  { id: "p-no-frijol", store: pekesStore, products: pekesProducts, messages: ["un kilo de frijol negro y una coca de 600"], cartIncludes: ["Coca"], cartExcludes: ["frijol"] },
  { id: "p-no-caviar", store: pekesStore, products: pekesProducts, messages: ["un kilo de caviar y una coca de 600"], cartIncludes: ["600"] },
  { id: "p-pinol", store: pekesStore, products: pekesProducts, messages: ["un pinol de litro", "1"] },
  { id: "p-huevo", store: pekesStore, products: pekesProducts, messages: ["un kilo de huevo", "1"] },
];

const georgeOrders: Play[] = [
  { id: "g-victor-1545", store: georgeStore, products: georgeProducts, messages: ["Quiero dos hamburguesas Una recia de pollo, también quiero un dogo clásico, después unas papas gajo y tres Pepsi", "1"], cartIncludes: ["Pollo", "Dogo", "Gajo", "Pepsi"], maxQuestions: 2 },
  { id: "g-victor-1730", store: georgeStore, products: georgeProducts, messages: ["Quiero unas hamburguesa de res grande y 3 dogos clásicos y 2 Pepe si", "Perdón agrega 2 Pepsis"], cartIncludes: ["Res Grande", "Dogo", "Pepsi"], maxQuestions: 0 },
  { id: "g-res", store: georgeStore, products: georgeProducts, messages: ["una hamburguesa de res grande y unas papas a la francesa"], cartIncludes: ["Res Grande", "francesa"] },
  { id: "g-dogos", store: georgeStore, products: georgeProducts, messages: ["3 dogos y una pepsi"], cartIncludes: ["Dogo Clásico", "Pepsi"] },
  { id: "g-pepe", store: georgeStore, products: georgeProducts, messages: ["2 Pepe si y un dogo"], cartIncludes: ["Pepsi", "Dogo"] },
  { id: "g-mixto", store: georgeStore, products: georgeProducts, messages: ["2 dogos de pollo, una hamburguesa cubana grande y dos seven"], cartIncludes: ["Pollo", "Cubana", "Seven"] },
  { id: "g-pizza", store: georgeStore, products: georgeProducts, messages: ["una pizza y un dogo clasico"], cartIncludes: ["Dogo"], cartExcludes: ["pizza"] },
  { id: "g-papas", store: georgeStore, products: georgeProducts, messages: ["unas papas gajo y una manzanita"], cartIncludes: ["Gajo", "Manzana"] },
  { id: "g-pollo", store: georgeStore, products: georgeProducts, messages: ["una hamburguesa de pollo"], cartIncludes: ["Pollo"] },
  { id: "g-coca", store: georgeStore, products: georgeProducts, messages: ["una coca y una hamburguesa de res chica"], cartIncludes: ["Coca", "Chica"] },
  { id: "g-seven", store: georgeStore, products: georgeProducts, messages: ["dos seven y unas papas a la francesa"], cartIncludes: ["Seven", "francesa"] },
  { id: "g-mirinda", store: georgeStore, products: georgeProducts, messages: ["una mirinda y un dogo clasico"], cartIncludes: ["Mirinda", "Dogo"] },
  { id: "g-jocho", store: georgeStore, products: georgeProducts, messages: ["un jocho"], cartIncludes: ["Dogo"] },
  { id: "g-hotdog", store: georgeStore, products: georgeProducts, messages: ["dos hot dogs"], cartIncludes: ["Dogo"] },
  { id: "g-arrachera", store: georgeStore, products: georgeProducts, messages: ["una hamburguesa de arrachera grande"], cartIncludes: ["Arrachera"] },
  { id: "g-cubana", store: georgeStore, products: georgeProducts, messages: ["una cubana chica y una pepsi"], cartIncludes: ["Cubana", "Pepsi"] },
  { id: "g-boneless", store: georgeStore, products: georgeProducts, messages: ["unas papas gajo"], cartIncludes: ["Gajo"] },
  { id: "g-tres", store: georgeStore, products: georgeProducts, messages: ["tres hamburguesas de res grande"], cartIncludes: ["Res Grande"] },
  { id: "g-no-taco", store: georgeStore, products: georgeProducts, messages: ["un taco y un dogo"], cartIncludes: ["Dogo"] },
  { id: "g-manzana", store: georgeStore, products: georgeProducts, messages: ["dos manzanas y un dogo clasico"], cartIncludes: ["Manzana", "Dogo"] },
  { id: "g-agrega", store: georgeStore, products: georgeProducts, messages: ["un dogo clasico", "agrega 2 pepsis"], cartIncludes: ["Dogo", "Pepsi"] },
];

const centralOrders: Play[] = [
  { id: "c-kilos", store: centralStore, products: centralProducts, messages: ["medio kilo de arrachera, 300 gramos de bistec de res y un kilo de diezmillo", "normal"], cartIncludes: ["Arrachera", "Bistec", "Diezmillo"] },
  { id: "c-chorizo", store: centralStore, products: centralProducts, messages: ["un kilo de chorizo y medio de pulpa de puerco"], cartIncludes: ["Chorizo", "Pulpa"] },
  { id: "c-pesos", store: centralStore, products: centralProducts, messages: ["100 pesos de diezmillo y medio kilo de chamberete"], cartIncludes: ["Diezmillo", "Chamberete"] },
  { id: "c-salmon", store: centralStore, products: centralProducts, messages: ["un kilo de salmon y medio kilo de arrachera", "normal"], cartIncludes: ["Arrachera"], cartExcludes: ["salmon"] },
  { id: "c-pastor", store: centralStore, products: centralProducts, messages: ["300 gramos de carne al pastor y un kilo de costilla de puerco", "normal"], cartIncludes: ["pastor", "Costilla"] },
  { id: "c-molida", store: centralStore, products: centralProducts, messages: ["un kilo de molida de res"], cartIncludes: ["molida"] },
  { id: "c-ribeye", store: centralStore, products: centralProducts, messages: ["medio kilo de rib eye"], cartIncludes: ["Rib"] },
  { id: "c-cocido", store: centralStore, products: centralProducts, messages: ["un kilo de cocido"], cartIncludes: ["Cocido"] },
  { id: "c-pollo", store: centralStore, products: centralProducts, messages: ["un kilo de pechuga"], cartIncludes: ["Pechuga"] },
  { id: "c-carbon", store: centralStore, products: centralProducts, messages: ["un carbon y un kilo de chorizo"], cartIncludes: ["Carbón", "Chorizo"] },
  { id: "c-bistec", store: centralStore, products: centralProducts, messages: ["medio kilo de bistec de puerco"], cartIncludes: ["Bistec"] },
  { id: "c-diezmillo", store: centralStore, products: centralProducts, messages: ["2 kilos de diezmillo"], cartIncludes: ["Diezmillo"] },
  { id: "c-arra-marin", store: centralStore, products: centralProducts, messages: ["un kilo de arrachera marinada"], cartIncludes: ["Arrachera", "Marinada"] },
  { id: "c-normal", store: centralStore, products: centralProducts, messages: ["medio kilo de arrachera normal"], cartIncludes: ["Arrachera"] },
  { id: "c-costilla", store: centralStore, products: centralProducts, messages: ["un kilo de costilla de res"], cartIncludes: ["Costilla"] },
  { id: "c-falda", store: centralStore, products: centralProducts, messages: ["medio kilo de falda"], cartIncludes: ["Falda"] },
  { id: "c-no-pescado", store: centralStore, products: centralProducts, messages: ["un kilo de camaron y un kilo de chorizo"], cartIncludes: ["Chorizo"] },
  { id: "c-tripa", store: centralStore, products: centralProducts, messages: ["un kilo de tripa"], cartIncludes: ["Tripa"] },
  { id: "c-chuleton", store: centralStore, products: centralProducts, messages: ["medio kilo de chuleton"], cartIncludes: ["Chulet"] },
  { id: "c-milanesa", store: centralStore, products: centralProducts, messages: ["un kilo de milanesa de pollo"], cartIncludes: ["Milanesa"] },
  { id: "c-grasa", store: centralStore, products: centralProducts, messages: ["300 gramos de chorizo"], cartIncludes: ["Chorizo"] },
];

function productIdRoundtrip(): void {
  const lines: AgentLine[] = [{
    lineId: "l1",
    productId: 7102,
    freeText: null,
    name: "Halls Menta",
    qty: 1,
    unit: "pz",
    variant: null,
    note: null,
    unitPrice: null,
    brand: "Halls",
    presentation: null,
  }];
  const items = itemsFromAgentLines(lines);
  const back = agentLinesFromItems(items);
  assert(items[0]?.producto_id === 7102, "el snapshot no guarda el id");
  assert(back[0]?.productId === 7102, "al recargar el carrito se pierde el productId");
}

async function main(): Promise<void> {
  searchRank();
  productIdRoundtrip();
  await contextReachesModel();
  const orders = [...pekesOrders, ...georgeOrders, ...centralOrders];
  assert(pekesOrders.length >= 20 && georgeOrders.length >= 20 && centralOrders.length >= 20, "hacen falta ~20 pedidos por tienda");
  const failed: string[] = [];
  const transcripts: string[] = [];
  for (const item of orders) {
    try {
      const result = await play(item);
      const names = result.cart.map((line) => `${line.qty} ${line.name} ${line.variant ?? ""}`.trim()).join(" | ");
      console.log(`PASA  ${item.id}  preguntas=${result.questions}  ${names}`);
      if (item.id.startsWith("p-victor") || item.id.startsWith("g-victor")) {
        transcripts.push(`## ${item.id}\n${item.messages.map((message, index) => `CLIENTE: ${message}\nBOT: ${result.replies[index] ?? ""}`).join("\n\n")}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(message);
      console.error(`FALLA ${item.id}: ${message}`);
    }
  }
  if (failed.length) {
    console.error(`\n${failed.length} pedidos fallaron`);
    process.exit(1);
  }
  console.log(`\n[order-intake] ${orders.length} pedidos. El sí del cliente sigue siendo el único que confirma la lista.`);
  if (transcripts.length) console.log(`\n${transcripts.join("\n\n")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
