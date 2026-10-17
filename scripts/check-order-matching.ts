/**
 * Pareo estricto con filas reales de productos_tienda.
 * George 56, La Central 19, Peke's 1,278 (marca, presentación y alias vacíos).
 * La búsqueda de Peke's se simula con el ranking de TypeScript y, aparte,
 * con el orden actual de buscar_lista_productos_tienda_amplia (pekes-search.json).
 * Modelos falsos. No llama a OpenAI ni manda WhatsApp.
 * Correr: npx tsx scripts/check-order-matching.ts
 */
import { readFileSync } from "node:fs";
import { isComplaintMessage, messageCorrectsOrder, shouldEscalateComplaint } from "../src/lib/messages";
import { foldAgent } from "../src/lib/orderAgent/catalog";
import { buildOrderAgentSystem, runOrderAgentTurn, validateToolCall, type AgentLine, type AgentModel, type AgentPending, type AgentProduct, type AgentStore, type ToolCall } from "../src/lib/orderAgent";
import type { OrderAgentTurnResult } from "../src/lib/orderAgent/types";
import { rankListaCandidates } from "../src/lib/storeProductSearch";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tool(name: ToolCall["name"], args: Record<string, unknown>, id: string = name): ToolCall {
  return { id, name, arguments: args };
}

function scripted(steps: Array<{ toolCalls: ToolCall[] }>, calls: string[]): AgentModel {
  let index = 0;
  return {
    name: "falso",
    async complete() {
      calls.push("falso");
      const step = steps[Math.min(index, Math.max(steps.length - 1, 0))] ?? { toolCalls: [] };
      index += 1;
      if (index > steps.length) return { toolCalls: [], text: null };
      return { toolCalls: step.toolCalls, text: null };
    },
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

type ExportRow = {
  id: number;
  tienda_id: number;
  nombre_producto: string;
  precio: number | null;
  disponible: boolean;
  categoria: string | null;
  marca: string | null;
  presentacion: string | null;
  alias: string[] | null;
};

type SearchRow = {
  id: number;
  nombre_producto: string;
  precio: number | null;
  categoria: string | null;
  marca: string | null;
  presentacion: string | null;
  alias: string[] | null;
  rank: number;
};

function drinkVariants(name: string): string[] {
  const match = name.match(/^(.*)\(([^)]+)\)\s*$/);
  if (!match) return [];
  return match[2]
    .split(/,|\by\b|\bo\b/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 1 && !/^o$/i.test(part));
}

function toProduct(row: Pick<ExportRow, "id" | "nombre_producto" | "precio" | "disponible" | "categoria" | "marca" | "presentacion" | "alias">, unit: "pz" | "kg"): AgentProduct {
  return {
    id: row.id,
    name: row.nombre_producto,
    price: row.precio,
    available: row.disponible !== false,
    unit,
    variants: drinkVariants(row.nombre_producto),
    brand: row.marca ?? null,
    presentation: row.presentacion ?? null,
    alias: Array.isArray(row.alias) ? row.alias : [],
    category: row.categoria,
  };
}

function load(name: string): ExportRow[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as ExportRow[];
}

const georgeRows = load("george-catalogo.json");
const centralRows = load("lacentral-catalogo.json");
const pekesRows = load("pekes-real.json");
const pekesSearch = JSON.parse(readFileSync(new URL("./fixtures/pekes-search.json", import.meta.url), "utf8")) as {
  function: string;
  search_results: Record<string, SearchRow[]>;
};

const georgeProducts = georgeRows.map((row) => toProduct(row, "pz"));
const centralProducts = centralRows.map((row) => toProduct(row, foldAgent(row.categoria ?? "") === "extras" ? "pz" : "kg"));
const pekesProducts = pekesRows.map((row) => toProduct(row, "pz"));

const georgeStore: AgentStore = { id: 5, name: "Hamburguesas Hotdogs George", category: "restaurante", catalogMode: "fixed" };
const centralStore: AgentStore = { id: 6, name: "Carnicería La Central", category: "carniceria", catalogMode: "fixed" };
const pekesStore: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true };

const GEORGE = "3 dogos de pollo y dos Pepsis y una orden de papas gajo";
const PEKES = "dos aguas minerales, dos cocas de 2 l, un olé capuchino, unas Pringles, un Nito y un kilo de azúcar";

const searchBuckets = Object.keys(pekesSearch.search_results).sort((left, right) => right.length - left.length);

function searchToProduct(row: SearchRow): AgentProduct {
  return toProduct({ ...row, disponible: true }, "pz");
}

function bucketFor(query: string): string | null {
  const folded = foldAgent(query);
  return searchBuckets.find((key) => folded.includes(foldAgent(key))) ?? null;
}

function sqlOrdered(query: string): AgentProduct[] {
  const key = bucketFor(query);
  if (!key) return [];
  return pekesSearch.search_results[key].slice(0, 8).map(searchToProduct);
}

function sqlReranked(query: string): AgentProduct[] {
  const key = bucketFor(query);
  if (!key) return [];
  const rows = pekesSearch.search_results[key];
  const ranked = rankListaCandidates(
    rows.map((row) => ({
      id: row.id,
      nombre: row.nombre_producto,
      marca: row.marca,
      presentacion: row.presentacion,
      alias: row.alias ?? [],
      categoria: row.categoria,
      precio: row.precio,
    })),
    query,
    8,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ranked
    .map((row) => byId.get((row as { id?: number }).id ?? -1))
    .filter((row): row is SearchRow => Boolean(row))
    .map(searchToProduct);
}

async function play(params: {
  message: string;
  store: AgentStore;
  products: AgentProduct[];
  steps: Array<{ toolCalls: ToolCall[] }>;
  cart?: AgentLine[];
  pending?: AgentPending | null;
  calls?: string[];
  search?: (query: string) => AgentProduct[];
}): Promise<OrderAgentTurnResult> {
  return runOrderAgentTurn({
    message: params.message,
    cart: params.cart ?? [],
    pending: params.pending ?? null,
    history: [],
    store: params.store,
    products: params.products,
    search: params.search,
    model: scripted(params.steps, params.calls ?? []),
    escalationModel: null,
    logEvent: () => {},
  });
}

function asks(reply: string): boolean {
  return reply.includes("?") || reply.includes("¿");
}

function bundle(turn: OrderAgentTurnResult): string {
  return [turn.reply, ...(turn.pending?.queue ?? []).map((item) => item.question)].join("\n");
}

function unitFor(turn: OrderAgentTurnResult, pattern: RegExp): string | null {
  const items = [turn.pending, ...(turn.pending?.queue ?? [])].filter((item): item is AgentPending => Boolean(item));
  const hit = items.find((item) => pattern.test(`${item.question} ${item.query ?? ""}`));
  return hit?.unit ?? null;
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS  ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

async function main(): Promise<void> {
  let georgeReply = "";
  let pekesReply = "";
  let pekesQueue = "";
  let pekesSqlReply = "";
  let pekesSqlQueue = "";

  await check("fixtures reales, sin ids de muestra", () => {
    assert(georgeProducts.length === 56, `George trae ${georgeProducts.length}, se esperaban 56`);
    assert(centralProducts.length === 19, `La Central trae ${centralProducts.length}, se esperaban 19`);
    assert(pekesProducts.length === 1278, `Peke's trae ${pekesProducts.length}, se esperaban 1278`);
    const all = [...georgeProducts, ...centralProducts, ...pekesProducts];
    assert(all.every((item) => item.id < 91000), "no quedan ids de muestra 91000+");
    assert(all.every((item) => item.brand == null && item.presentation == null && item.alias.length === 0), "marca, presentación y alias se quedan vacíos");
    assert(georgeProducts.some((item) => item.id === 22 && item.name === "Dogo de Pollo" && item.price === 45), "Dogo de Pollo es el id 22 a $45");
    assert(georgeProducts.some((item) => item.id === 31 && /torta de pierna/i.test(item.name) && item.available === false), "las tortas vienen en el export y están apagadas");
    assert(georgeProducts.some((item) => /alitas 30 piezas/i.test(item.name) && item.available === false), "las alitas vienen en el export y están apagadas");
    assert(georgeProducts.filter((item) => item.available).length === 30, "lo que sí se vende son las 30 de hamburguesas, botanas, dogos y refresco");
    assert(pekesProducts.filter((item) => [4034, 5378, 5449, 4005, 5399].includes(item.id)).length === 5, "los cinco Nito usan el id real");
    assert(!pekesSearch.search_results.nito[0].nombre_producto.startsWith("Nito 62g"), "el SQL de prod no pone Nito 62g primero");
  });

  await check("prompt de George con el menú de 56", () => {
    const menu = buildOrderAgentSystem(georgeStore, [], georgeProducts);
    assert(menu.includes("22 | Dogo de Pollo | 45"), "el prompt trae el Dogo de Pollo");
    assert(menu.includes("Boneless 10 piezas"), "el prompt trae las botanas");
    assert(menu.includes("Refresco (Pepsi, Seven, Coca, Mirinda o Manzana)"), "el prompt trae las bebidas");
    assert(!menu.includes("Torta de Pierna") && !menu.includes("Alitas 5 piezas"), "lo apagado no se ofrece");
    assert(menu.includes("No inventes otro id"), "el prompt prohíbe inventar el id");
  });

  await check("ranking TS: Nito 62g antes que cariñitos", () => {
    const ranked = rankListaCandidates(
      pekesProducts.map((item) => ({ nombre: item.name, marca: null, presentacion: null, alias: [] })),
      "un nito",
    ).map((item) => item.nombre);
    const nitoAt = ranked.findIndex((name) => name.startsWith("Nito 62g"));
    const cariAt = ranked.findIndex((name) => /carinitos/i.test(foldAgent(name)));
    const gusaAt = ranked.findIndex((name) => /gusanito/i.test(foldAgent(name)));
    assert(nitoAt >= 0 && (cariAt < 0 || nitoAt < cariAt) && (gusaAt < 0 || nitoAt < gusaAt), "Nito 62g gana a cariñitos y gusanito");
  });

  await check("SQL de prod reordenado en TS pone Nito 62g antes", () => {
    const rows = pekesSearch.search_results.nito;
    const ranked = rankListaCandidates(
      rows.map((row) => ({ nombre: row.nombre_producto, marca: row.marca, presentacion: row.presentacion, alias: row.alias ?? [] })),
      "nito",
    ).map((item) => item.nombre);
    const nitoAt = ranked.findIndex((name) => name.startsWith("Nito 62g"));
    const cariAt = ranked.findIndex((name) => /carinitos/i.test(foldAgent(name)));
    assert(nitoAt >= 0 && nitoAt < cariAt, "aunque el SQL traiga cariñitos primero, el ranking TS sube Nito 62g");
  });

  await check("la migración solo ordena y no borra", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20261016_lista_productos_orden_exacto.sql", import.meta.url), "utf8");
    assert(sql.includes("exact_words desc") && sql.includes("name_starts desc"), "el SQL ordena palabra exacta y nombre que empieza");
    assert(!/^\s*drop\b/im.test(sql) && !/^\s*delete\b/im.test(sql), "la migración no borra");
  });

  await check("George: 3 dogos, dos Pepsis y papas gajo", async () => {
    const george = await play({
      message: GEORGE,
      store: georgeStore,
      products: georgeProducts,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "dogo de pollo" }, "s1"),
          tool("search_products", { query: "pepsi" }, "s2"),
          tool("search_products", { query: "papas gajo" }, "s3"),
          tool("set_cart_line", { product_id: 22, qty: 3, unit: "pz" }, "d"),
          tool("set_cart_line", { product_id: 30, qty: 2, unit: "pz" }, "r"),
          tool("set_cart_line", { product_id: 16, qty: 1, unit: "pz" }, "p"),
          tool("finish_cart", {}, "fin"),
        ],
      }],
    });
    georgeReply = george.reply;
    const dogo = george.cart.find((item) => item.productId === 22);
    const pepsi = george.cart.find((item) => item.productId === 30);
    const gajo = george.cart.find((item) => item.productId === 16);
    assert(dogo?.qty === 3 && dogo.name.includes("Dogo de Pollo"), "anota 3 Dogo de Pollo");
    assert(pepsi?.qty === 2 && pepsi.variant === "Pepsi", "anota 2 Refresco Pepsi");
    assert(gajo?.qty === 1 && /gajo/i.test(gajo.name), "anota las papas gajo");
    assert(!george.cart.some((item) => item.productId != null && item.productId <= 14), "no mete hamburguesas");
    assert(george.reply.includes("$135") && george.reply.includes("$40") && george.reply.includes("$70"), "los importes son 135, 40 y 70");
    assert(george.reply.includes("$35") && george.reply.includes("$280"), "el total es 245 más 35");
    assert(george.reply.includes("¿Están bien estos productos?"), "el pedido claro pide el sí");
  });

  await check("George: ids inventados no cierran el pedido", async () => {
    const inventedCalls: string[] = [];
    const invented = await play({
      message: GEORGE,
      store: georgeStore,
      products: georgeProducts,
      calls: inventedCalls,
      steps: Array.from({ length: 8 }, () => ({
        toolCalls: [
          tool("set_cart_line", { product_id: 1, qty: 3, unit: "pz" }, "malo-1"),
          tool("set_cart_line", { product_id: 2, qty: 2, unit: "pz" }, "malo-2"),
          tool("set_cart_line", { product_id: 7, qty: 1, unit: "pz" }, "malo-7"),
        ],
      })),
    });
    assert(!invented.cart.some((item) => item.productId === 1 || item.productId === 2 || item.productId === 7), "los ids que no pidió no entran al carrito");
    assert(invented.cart.some((item) => /pollo/i.test(item.name)), "el dogo de pollo se arma aunque el modelo anote otro id");
    assert(invented.reply.includes("¿Están bien estos productos?"), "el pedido claro pide el sí");
    assert(/pepsi|gajo|papas/i.test(invented.reply), "el ticket trae lo que sí pidió");
  });

  await check("George: un dogo es el Clásico", async () => {
    const unDogo = await play({
      message: "un dogo",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "dogo" }, "s"), tool("set_cart_line", { product_id: 21, qty: 1, unit: "pz" }, "c"), tool("finish_cart", {}, "f")] }],
    });
    assert(unDogo.cart.length === 1 && unDogo.cart[0].productId === 21, "un dogo es el Clásico");
    assert(unDogo.reply.includes("Clásico") && !unDogo.reply.includes("de Pollo"), "no elige el de pollo");
  });

  await check("George: unas papas pregunta gajo o francesa", async () => {
    const papas = await play({
      message: "unas papas",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "papas" }, "s"), tool("set_cart_line", { product_id: 16, qty: 1, unit: "pz" }, "g"), tool("finish_cart", {}, "f")] }],
    });
    assert(papas.cart.length === 0, "unas papas no elige gajo ni francesa");
    assert(/gajo/i.test(papas.reply) && /francesa/i.test(papas.reply), "pregunta gajo o francesa");
    assert(!papas.reply.includes("¿Están bien estos productos?"), "no cierra el pedido");
  });

  await check("George: hamburguesa de res pregunta chica o grande", async () => {
    const res = await play({
      message: "una hamburguesa de res",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "hamburguesa de res" }, "s"), tool("set_cart_line", { product_id: 1, qty: 1, unit: "pz" }, "c"), tool("finish_cart", {}, "f")] }],
    });
    assert(res.cart.some((item) => item.productId === 1) && /chica/i.test(res.reply), "sin tamaño, la de res queda en la chica");
    assert(!/grande/i.test(res.cart.map((item) => item.name).join(" ")), "no anota la grande si no la pidió");
    const grande = await play({
      message: "hamburguesa de res grande",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "hamburguesa de res grande" }, "s"), tool("set_cart_line", { product_id: 2, qty: 1, unit: "pz" }, "g"), tool("finish_cart", {}, "f")] }],
    });
    assert(grande.cart.some((item) => item.productId === 2) && grande.reply.includes("¿Están bien estos productos?"), "la grande se anota");
    const chica = await runOrderAgentTurn({
      message: "chica",
      cart: [],
      pending: { question: "¿La hamburguesa de res chica o grande?", candidateIds: [1, 2], qty: 1, unit: "pz", axis: "size" },
      history: [],
      store: georgeStore,
      products: georgeProducts,
      model: { name: "no", async complete() { throw new Error("chica no debía llamar al modelo"); } },
      logEvent: () => {},
    });
    assert(chica.cart.some((item) => item.productId === 1), "chica elige la chica");
  });

  await check("George: botanas, bebidas y lo apagado", async () => {
    const torta = await play({
      message: "una torta",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "torta" }, "s"), tool("set_cart_line", { product_id: 31, qty: 1, unit: "pz" }, "t"), tool("finish_cart", {}, "f")] }],
    });
    assert(torta.cart.length === 0 && /no tenemos|no contamos/i.test(torta.reply) && /torta/i.test(torta.reply), "la torta apagada no se anota");
    assert(!torta.reply.includes("Torta de Pierna"), "no lista tortas apagadas como opción");
    const boneless = await play({
      message: "unas boneless",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "boneless" }, "s"), tool("set_cart_line", { product_id: 19, qty: 1, unit: "pz" }, "b"), tool("finish_cart", {}, "f")] }],
    });
    assert(boneless.cart.some((item) => item.productId === 19), "boneless es la de 10 piezas");
    const botana = await play({
      message: "una botana",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "botana" }, "s"), tool("set_cart_line", { product_id: 20, qty: 1, unit: "pz" }, "bo"), tool("finish_cart", {}, "f")] }],
    });
    assert(botana.cart.some((item) => item.productId === 20), "una botana es la Botana Completa");
    const dedos = await play({
      message: "unos dedos de queso",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "dedos de queso" }, "s"), tool("set_cart_line", { product_id: 18, qty: 1, unit: "pz" }, "d"), tool("finish_cart", {}, "f")] }],
    });
    assert(dedos.cart.some((item) => item.productId === 18), "dedos de queso se anotan");
    const alitas = await play({
      message: "unas alitas",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "alitas" }, "s"), tool("set_cart_line", { product_id: 52, qty: 1, unit: "pz" }, "a"), tool("finish_cart", {}, "f")] }],
    });
    assert(alitas.cart.length === 0 && /no tenemos|no contamos/i.test(alitas.reply) && /alitas/i.test(alitas.reply), "las alitas apagadas no se venden");
    const pepsi = await play({
      message: "una pepsi",
      store: georgeStore,
      products: georgeProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "pepsi" }, "s"), tool("set_cart_line", { product_id: 30, qty: 1, unit: "pz" }, "p"), tool("finish_cart", {}, "f")] }],
    });
    assert(pepsi.cart.some((item) => item.productId === 30 && item.variant === "Pepsi"), "una pepsi anota el refresco");
  });

  await check("Peke's TS: un Nito anota la pieza de 62g", async () => {
    const nito = await play({
      message: "un Nito",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"), tool("finish_cart", {}, "f")] }],
    });
    assert(nito.cart.length === 1 && nito.cart[0].productId === 4034 && nito.cart[0].qty === 1, "un Nito anota Nito 62g");
    assert(!/duo|caja|funk|hotkis/i.test(nito.cart[0].name), "no anota caja, duo, funk ni hotkis");
    assert(/est[aá]n bien estos productos/i.test(nito.reply), "cierra la lista con la pieza estándar");
    assert(!/cu[aá]l de estos/i.test(nito.reply), "no pregunta la presentación");
  });

  await check("Peke's SQL crudo: un Nito no anota cariñitos ni la caja", async () => {
    const nito = await play({
      message: "un Nito",
      store: pekesStore,
      products: [],
      search: sqlOrdered,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "nito" }, "s"),
          tool("set_cart_line", { product_id: pekesSearch.search_results.nito[0].id, qty: 1, unit: "pz" }, "primero"),
          tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    assert(nito.cart.length === 0, "ni el primero del SQL ni la caja entran");
    assert(asks(nito.reply) && !nito.reply.includes("¿Están bien estos productos?"), "pregunta en vez de cerrar");
  });

  await check("Peke's SQL reordenado: un Nito anota el de 62g", async () => {
    const nito = await play({
      message: "un Nito",
      store: pekesStore,
      products: [],
      search: sqlReranked,
      steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"), tool("finish_cart", {}, "f")] }],
    });
    assert(nito.cart.some((item) => /nito 62g/i.test(item.name)) && !nito.cart.some((item) => item.productId === 5378), "con el rerank anota el de 62g y no la caja");
  });

  await check("Peke's: una caja de Nito anota la caja", async () => {
    const caja = await play({
      message: "una caja de Nito",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"), tool("finish_cart", {}, "f")] }],
    });
    assert(caja.cart.length === 1 && caja.cart[0].productId === 5378, "una caja de Nito anota la caja");
    assert(!/cuál de estos/i.test(caja.reply), "no vuelve a preguntar el tamaño");
  });

  await check("Peke's: agua mineral anota la Ciel de 600 ml", async () => {
    const agua = await play({
      message: "agua mineral",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "agua mineral" }, "s"), tool("set_cart_line", { product_id: 6282, qty: 1, unit: "pz" }, "ciel"), tool("finish_cart", {}, "f")] }],
    });
    assert(agua.cart.some((item) => item.productId === 6282), "agua mineral anota Agua Mineral Ciel 600ml");
    assert(!/cu[aá]l de estos/i.test(agua.reply), "no pregunta otra marca de otro tamaño");
  });

  await check("Peke's: un kilo de azúcar no queda en una pieza", async () => {
    const azucar = await play({
      message: "un kilo de azúcar",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "azucar" }, "s"), tool("set_cart_line", { product_id: 234, qty: 1, unit: "pz" }, "az"), tool("finish_cart", {}, "f")] }],
    });
    assert(!azucar.cart.some((item) => item.unit === "pz"), "no anota una pieza");
    assert(azucar.cart.some((item) => item.unit === "kg") || unitFor(azucar, /azucar/i) === "kg", "el kilo se queda en la línea o en la pregunta");
    assert(/azucar|azúcar/i.test(bundle(azucar)), "el azúcar no se pierde");
    if (azucar.cart.length === 0) assert(!azucar.reply.includes("¿Están bien estos productos?"), "si pregunta, no cierra");
  });

  await check("Peke's: olé capuchino no se pierde", async () => {
    const ole = await play({
      message: "un Nito y un olé capuchino",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("finish_cart", {}, "f")] }],
    });
    assert(ole.cart.some((item) => /capp?uccino|capuch/i.test(item.name)), "olé capuchino no se pierde");
    assert(ole.cart.some((item) => /nito 62g/i.test(item.name)), "el Nito queda en la pieza de 62g");
    assert(/est[aá]n bien estos productos/i.test(ole.reply), "los dos tienen presentación estándar y se cierra");
  });

  await check("Peke's: pan Bimbo pregunta presentación real", async () => {
    const pan = await play({
      message: "pan Bimbo",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "pan bimbo" }, "s"), tool("set_cart_line", { product_id: 3897, qty: 1, unit: "pz" }, "p"), tool("finish_cart", {}, "f")] }],
    });
    assert(pan.cart.length === 0 && /pan/i.test(pan.reply) && /bimbo/i.test(pan.reply), "pregunta opciones de Pan Bimbo");
    assert(!/pantene/i.test(pan.reply), "no ofrece Pantene");
    assert(!pan.reply.includes("¿Están bien estos productos?"), "no cierra");
  });

  await check("Peke's: jamón pregunta opciones reales", async () => {
    const jamon = await play({
      message: "jamón",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "jamon" }, "s"), tool("set_cart_line", { product_id: 5596, qty: 1, unit: "pz" }, "j"), tool("finish_cart", {}, "f")] }],
    });
    assert(jamon.cart.length === 0 && /jam[oó]n/i.test(jamon.reply), "jamón pregunta");
    assert(/pavo|pierna|americano|chimex|corona/i.test(jamon.reply), "las opciones son jamones reales");
    assert(!jamon.reply.includes("¿Están bien estos productos?"), "no cierra");
  });

  await check("Peke's: chicles pregunta opciones reales", async () => {
    const chicles = await play({
      message: "chicles",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "chicles" }, "s"), tool("set_cart_line", { product_id: 87, qty: 1, unit: "pz" }, "c"), tool("finish_cart", {}, "f")] }],
    });
    assert(chicles.cart.length === 0 && /chicle|canels/i.test(chicles.reply), "chicles pregunta");
    assert(!chicles.reply.includes("¿Están bien estos productos?"), "no cierra");
  });

  await check("Peke's: leche pregunta", async () => {
    const leche = await play({
      message: "leche",
      store: pekesStore,
      products: pekesProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "leche" }, "s"), tool("set_cart_line", { product_id: 4870, qty: 1, unit: "pz" }, "l"), tool("finish_cart", {}, "f")] }],
    });
    assert(leche.cart.length === 0 && /leche/i.test(leche.reply), "leche pregunta");
    assert(/19|sello rojo|lala|alpura|santa clara/i.test(leche.reply), "salen leches reales");
    assert(!leche.reply.includes("¿Están bien estos productos?"), "no cierra");
  });

  await check("Peke's: 2 cocas de 2 litros no anota la de 2.5", async () => {
    const cocas = await play({
      message: "2 cocas de 2 litros",
      store: pekesStore,
      products: pekesProducts,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "coca" }, "s"),
          tool("set_cart_line", { product_id: 6392, qty: 2, unit: "pz" }, "mala"),
          tool("set_cart_line", { product_id: 6568, qty: 2, unit: "pz" }, "buena"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    assert(!cocas.cart.some((item) => item.productId === 6392), "no anota Coca Cola 2.5 Lt");
    const plain = cocas.cart.find((item) => item.productId === 6568);
    assert(plain?.qty === 2 && plain.unit === "pz", "anota 2 piezas de Coca Cola de 2 Lts");
  });

  await check("Peke's: jamón, leche y chicles, uno por mensaje", async () => {
    const mix = await play({
      message: "jamón, leche y chicles",
      store: pekesStore,
      products: pekesProducts,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "jamon" }, "j"),
          tool("search_products", { query: "leche" }, "l"),
          tool("search_products", { query: "chicles" }, "c"),
          tool("set_cart_line", { product_id: 5596, qty: 1, unit: "pz" }, "sj"),
          tool("set_cart_line", { product_id: 4870, qty: 1, unit: "pz" }, "sl"),
          tool("set_cart_line", { product_id: 87, qty: 1, unit: "pz" }, "sc"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    assert(mix.cart.length === 0, "no elige uno de cada cosa");
    assert(asks(mix.reply) && !mix.reply.includes("¿Están bien estos productos?"), "pregunta uno");
    assert((mix.pending?.queue?.length ?? 0) >= 2, "los otros dos esperan en la cola");
    const topics = [mix.reply, ...(mix.pending?.queue ?? []).map((item) => item.question)].join("\n");
    assert(/jam[oó]n/i.test(topics) && /leche/i.test(topics) && /chicle/i.test(topics), "los tres quedan preguntados");
  });

  await check("Peke's: seis productos, una pregunta a la vez", async () => {
    const seis = "un Nito, agua mineral, unos Pringles, una Coca, azúcar y un olé capuchino";
    const seisTurn = await play({
      message: seis,
      store: pekesStore,
      products: pekesProducts,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "nito" }, "n"),
          tool("search_products", { query: "agua mineral" }, "a"),
          tool("search_products", { query: "pringles" }, "p"),
          tool("search_products", { query: "coca" }, "c"),
          tool("search_products", { query: "azucar" }, "z"),
          tool("search_products", { query: "ole capuchino" }, "o"),
          tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "nito"),
          tool("set_cart_line", { product_id: 6282, qty: 1, unit: "pz" }, "agua"),
          tool("set_cart_line", { product_id: 725, qty: 1, unit: "pz" }, "pri"),
          tool("set_cart_line", { product_id: 6392, qty: 1, unit: "pz" }, "coca"),
          tool("set_cart_line", { product_id: 234, qty: 1, unit: "pz" }, "azu"),
          tool("set_cart_line", { product_id: 5722, qty: 1, unit: "pz" }, "ole"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    assert(seisTurn.cart.some((item) => /nito 62g/i.test(item.name)), "el Nito queda en la pieza de 62g");
    assert(seisTurn.cart.some((item) => /coca/i.test(item.name)) && !seisTurn.cart.some((item) => item.productId === 6392), "la Coca queda en la pieza estándar");
    assert(asks(seisTurn.reply) && !seisTurn.reply.includes("¿Están bien estos productos?"), "lo que cambia de sabor se pregunta");
    assert(/pringles/i.test(bundle(seisTurn)), "las Pringles se preguntan");
    assert(seisTurn.cart.some((item) => /capp?uccino|capuch/i.test(item.name)), "el olé capuchino queda en la presentación estándar");
  });

  await check("Peke's: el mensaje original no cierra ni pierde productos", async () => {
    const turn = await play({
      message: PEKES,
      store: pekesStore,
      products: pekesProducts,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "agua mineral" }, "a"),
          tool("search_products", { query: "coca" }, "c"),
          tool("search_products", { query: "ole capuchino" }, "o"),
          tool("search_products", { query: "pringles" }, "p"),
          tool("search_products", { query: "nito" }, "n"),
          tool("search_products", { query: "azucar" }, "z"),
          tool("set_cart_line", { product_id: 6282, qty: 2, unit: "pz" }, "agua"),
          tool("set_cart_line", { product_id: 6392, qty: 2, unit: "pz" }, "coca"),
          tool("set_cart_line", { product_id: 5722, qty: 1, unit: "pz" }, "ole"),
          tool("set_cart_line", { product_id: 725, qty: 1, unit: "pz" }, "pri"),
          tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "nito"),
          tool("set_cart_line", { product_id: 234, qty: 1, unit: "pz" }, "azu"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    pekesReply = turn.reply;
    pekesQueue = (turn.pending?.queue ?? []).map((item) => item.question).join("\n---\n");
    const text = bundle(turn);
    assert(!turn.reply.includes("¿Están bien estos productos?"), "no cierra el pedido");
    assert(turn.cart.some((item) => /ciel/i.test(item.name)), "el agua mineral queda en Ciel");
    assert(turn.cart.some((item) => /nito 62g/i.test(item.name)) && !turn.cart.some((item) => item.productId === 5378), "el Nito queda en 62g y no en la caja");
    assert(/pringles/i.test(text), "las Pringles se preguntan");
    assert(/capp?uccino|capuch/i.test(text) || turn.cart.some((item) => /capp?uccino|capuch/i.test(item.name)), "el olé capuchino no se cae");
    assert(!turn.cart.some((item) => item.productId === 6392), "la Coca de 2.5 no entra");
    assert(!turn.cart.some((item) => /azucar/i.test(item.name) && item.unit === "pz"), "el azúcar no queda en piezas");
    assert(unitFor(turn, /azucar/i) === "kg" || turn.cart.some((item) => /azucar/i.test(item.name) && item.unit === "kg"), "el kilo de azúcar se queda en kg");
    assert(/2\s*l/i.test(text) || turn.cart.some((item) => item.productId === 6568), "las cocas de 2 l se preguntan o se anotan en 2 L");
    const sqlTurn = await play({
      message: PEKES,
      store: pekesStore,
      products: [],
      search: sqlOrdered,
      steps: [{
        toolCalls: [
          tool("search_products", { query: "agua mineral" }, "a"),
          tool("search_products", { query: "coca" }, "c"),
          tool("search_products", { query: "ole" }, "o"),
          tool("search_products", { query: "pringles" }, "p"),
          tool("search_products", { query: "nito" }, "n"),
          tool("search_products", { query: "azucar" }, "z"),
          tool("set_cart_line", { product_id: pekesSearch.search_results.nito[0].id, qty: 1, unit: "pz" }, "n0"),
          tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"),
          tool("set_cart_line", { product_id: 6392, qty: 2, unit: "pz" }, "c25"),
          tool("set_cart_line", { product_id: 234, qty: 1, unit: "pz" }, "az"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    pekesSqlReply = sqlTurn.reply;
    pekesSqlQueue = (sqlTurn.pending?.queue ?? []).map((item) => item.question).join("\n---\n");
    assert(sqlTurn.cart.every((item) => item.productId !== 6392 && item.productId !== 5378 && item.productId !== pekesSearch.search_results.nito[0].id), "el orden SQL no mete cariñitos, la caja ni la Coca de 2.5");
    assert(!sqlTurn.reply.includes("¿Están bien estos productos?"), "sin la migración tampoco cierra");
  });

  await check("Peke's: solo una pieza cambia la caja", async () => {
    const cajaLine = line({ lineId: "l1", productId: 5378, name: "Caja Nito 15paq" });
    const pieza = await play({
      message: "no es una caja, solo una pieza",
      store: pekesStore,
      products: pekesProducts,
      cart: [cajaLine],
      steps: [{
        toolCalls: [
          tool("search_products", { query: "nito" }, "s"),
          tool("remove_line", { line_id: "l1" }, "quita"),
          tool("set_cart_line", { product_id: 4034, qty: 1, unit: "pz" }, "pieza"),
          tool("finish_cart", {}, "f"),
        ],
      }],
    });
    assert(pieza.cart.length === 1 && pieza.cart[0].productId === 4034 && pieza.cart[0].lineId === "l1", "solo una pieza cambia la caja por el Nito de 62 g");
    assert(!shouldEscalateComplaint("no es una caja, solo una pieza", { editingOrder: true }), "la corrección no avisa al admin");
    assert(!isComplaintMessage("está mala la caja"), "está mala no es esta mal");
    assert(messageCorrectsOrder("solo una pieza") && messageCorrectsOrder("quiero una pieza"), "quiero una pieza corrige el pedido");
    const blocked = validateToolCall({
      call: tool("remove_line", { line_id: "l1" }),
      store: pekesStore,
      products: pekesProducts,
      cart: [cajaLine],
      pending: null,
      nextLineId: "l2",
      customerMessage: "no es una caja, solo una pieza",
    });
    assert(blocked.ok === false, "sin quita no borra la línea");
  });

  await check("La Central: bistec, chorizo y arrachera", async () => {
    const bistec = await play({
      message: "1 kilo de bistec de res",
      store: centralStore,
      products: centralProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "bistec de res" }, "s"), tool("set_cart_line", { product_id: 62, qty: 1, unit: "kg" }, "b"), tool("finish_cart", {}, "f")] }],
    });
    assert(bistec.cart.length === 0 && /bistec de res/i.test(bistec.reply) && /marinada o normal/i.test(bistec.reply), "bistec de res pregunta marinada o normal");
    const adobado = await play({
      message: "1 kilo de bistec de res marinada",
      store: centralStore,
      products: centralProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "bistec de res marinada" }, "s"), tool("set_cart_line", { product_id: 65, qty: 1, unit: "kg" }, "m"), tool("finish_cart", {}, "f")] }],
    });
    assert(adobado.cart.some((item) => item.productId === 65 && item.unit === "kg"), "si dice marinada se anota esa");
    const chorizo = await play({
      message: "$100 de chorizo",
      store: centralStore,
      products: centralProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "chorizo" }, "s"), tool("set_cart_line", { product_id: 75, qty: 1, unit: "pz" }, "z"), tool("finish_cart", {}, "f")] }],
    });
    assert(chorizo.cart.length === 1 && chorizo.cart[0].productId === 75 && chorizo.cart[0].unit === "pesos" && chorizo.cart[0].qty === 100, "$100 de chorizo queda en pesos");
    assert(chorizo.reply.includes("$100"), "el ticket muestra los $100");
    const arrachera = await play({
      message: "arrachera",
      store: centralStore,
      products: centralProducts,
      steps: [{ toolCalls: [tool("search_products", { query: "arrachera" }, "s"), tool("set_cart_line", { product_id: 59, qty: 1, unit: "kg" }, "a"), tool("finish_cart", {}, "f")] }],
    });
    assert(arrachera.cart.some((item) => item.productId === 59) && !/marinada o normal/i.test(arrachera.reply), "arrachera sola es la marinada");
  });

  console.log("\n--- George: 3 dogos de pollo y dos Pepsis y una orden de papas gajo ---");
  console.log(georgeReply || "(sin respuesta)");
  console.log("\n--- Peke's ranking TS ---");
  console.log(pekesReply || "(sin respuesta)");
  if (pekesQueue) {
    console.log("\n--- cola ---");
    console.log(pekesQueue);
  }
  console.log("\n--- Peke's orden SQL de prod ---");
  console.log(pekesSqlReply || "(sin respuesta)");
  if (pekesSqlQueue) {
    console.log("\n--- cola SQL ---");
    console.log(pekesSqlQueue);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} casos`);
  if (failed.length) {
    throw new Error(`${failed.length} casos fallaron`);
  }
  console.log("check-order-matching: ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
