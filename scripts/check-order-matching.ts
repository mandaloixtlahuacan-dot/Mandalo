/**
 * Pareo estricto con datos reales de menú (marca/presentación/alias vacíos).
 * Modelos falsos. No llama a OpenAI ni manda WhatsApp.
 * Correr: npx tsx scripts/check-order-matching.ts
 *
 * George 1–30 y La Central 57–75 salen de scripts/fixtures/catalogs.json.
 * El repo no trae George 31–56 (las tortas se quitaron del menú). Peke's:
 * los cinco Nito son ids reales; Coca, agua, Pringles, azúcar y Café Olé
 * son muestra (ids 91000+) porque no hubo export de Supabase.
 */
import { readFileSync } from "node:fs";
import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import type { RawCatalogRow, StoreProfile } from "../src/lib/catalogOrder/types";
import { isComplaintMessage, messageCorrectsOrder, shouldEscalateComplaint } from "../src/lib/messages";
import { buildOrderAgentSystem, runOrderAgentTurn, validateToolCall, type AgentLine, type AgentModel, type AgentPending, type AgentProduct, type AgentStore, type ToolCall } from "../src/lib/orderAgent";
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

function bareFixed(rows: RawCatalogRow[], profile: StoreProfile): AgentProduct[] {
  return buildCatalog(rows, profile).rows.map((row) => ({
    id: row.id,
    name: row.name,
    price: row.precio,
    available: row.disponible,
    unit: row.unit,
    variants: row.variants,
    brand: null,
    presentation: null,
    alias: [],
    category: row.categoria,
  }));
}

type SampleRow = { id: number; nombre: string; real: boolean };

function bareList(rows: SampleRow[]): AgentProduct[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.nombre,
    price: null,
    available: true,
    unit: "pz" as const,
    variants: [],
    brand: null,
    presentation: null,
    alias: [],
    category: null,
  }));
}

const catalogs = JSON.parse(readFileSync(new URL("./fixtures/catalogs.json", import.meta.url), "utf8")) as {
  tienda_5_george: RawCatalogRow[];
  tienda_6_la_central: RawCatalogRow[];
};
const pekesSample = JSON.parse(readFileSync(new URL("./fixtures/pekes-muestra.json", import.meta.url), "utf8")) as {
  productos: SampleRow[];
};

const georgeProducts = bareFixed(catalogs.tienda_5_george, "restaurante");
const centralProducts = bareFixed(catalogs.tienda_6_la_central, "carniceria");
const pekesProducts = bareList(pekesSample.productos);

const georgeStore: AgentStore = { id: 5, name: "Hamburguesas Hotdogs George", category: "restaurante", catalogMode: "fixed" };
const centralStore: AgentStore = { id: 6, name: "Carnicería La Central", category: "carniceria", catalogMode: "fixed" };
const pekesStore: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true };

const GEORGE = "3 dogos de pollo y dos Pepsis y una orden de papas gajo";

async function play(params: {
  message: string;
  store: AgentStore;
  products: AgentProduct[];
  steps: Array<{ toolCalls: ToolCall[] }>;
  cart?: AgentLine[];
  pending?: AgentPending | null;
  calls?: string[];
}) {
  return runOrderAgentTurn({
    message: params.message,
    cart: params.cart ?? [],
    pending: params.pending ?? null,
    history: [],
    store: params.store,
    products: params.products,
    model: scripted(params.steps, params.calls ?? []),
    escalationModel: null,
    logEvent: () => {},
  });
}

function asks(reply: string): boolean {
  return reply.includes("?") || reply.includes("¿");
}

async function main(): Promise<void> {
  assert(georgeProducts.length === 30, "el fixture de George trae los ids 1 a 30");
  assert(georgeProducts.every((item) => item.brand == null && item.presentation == null && item.alias.length === 0), "George no trae marca, presentación ni alias");
  assert(centralProducts.some((item) => item.id === 57) && centralProducts.some((item) => item.id === 75), "La Central trae 57 a 75");
  assert(pekesProducts.filter((item) => [4034, 5378, 5449, 4005, 5399].includes(item.id)).length === 5, "los cinco Nito usan el id real");

  const menu = buildOrderAgentSystem(georgeStore, [], georgeProducts);
  assert(menu.includes("22 | Dogo de Pollo | 45"), "el prompt de George trae el menú compacto");
  assert(menu.includes("No inventes otro id"), "el prompt prohíbe inventar el id");

  const ranked = rankListaCandidates(
    pekesProducts.map((item) => ({ nombre: item.name, marca: null, presentacion: null, alias: [] })),
    "un nito",
  ).map((item) => item.nombre);
  const nitoAt = ranked.findIndex((name) => name.startsWith("Nito 62g"));
  const cariAt = ranked.findIndex((name) => /carinitos/i.test(name.normalize("NFD").replace(/\p{Diacritic}/gu, "")));
  const gusaAt = ranked.findIndex((name) => /gusanito/i.test(name));
  assert(nitoAt >= 0 && nitoAt < cariAt && nitoAt < gusaAt, "Nito 62g gana a cariñitos y gusanito");

  const sql = readFileSync(new URL("../supabase/migrations/20261016_lista_productos_orden_exacto.sql", import.meta.url), "utf8");
  assert(sql.includes("exact_words desc") && sql.includes("name_starts desc"), "el SQL ordena palabra exacta y nombre que empieza");
  assert(!/^\s*drop\b/im.test(sql) && !/^\s*delete\b/im.test(sql), "la migración no borra");

  const george = await play({
    message: GEORGE,
    store: georgeStore,
    products: georgeProducts,
    steps: [
      {
        toolCalls: [
          tool("search_products", { query: "dogo de pollo" }, "s1"),
          tool("search_products", { query: "pepsi" }, "s2"),
          tool("search_products", { query: "papas gajo" }, "s3"),
          tool("set_cart_line", { product_id: 22, qty: 3, unit: "pz" }, "d"),
          tool("set_cart_line", { product_id: 30, qty: 2, unit: "pz" }, "r"),
          tool("set_cart_line", { product_id: 16, qty: 1, unit: "pz" }, "p"),
          tool("finish_cart", {}, "fin"),
        ],
      },
    ],
  });
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
  assert(invented.cart.length === 0, "los ids inventados no entran al carrito");
  assert(inventedCalls.length === 2, "repite la misma llamada fallida y se corta");
  assert(asks(invented.reply) && !invented.reply.includes("¿Están bien estos productos?"), "el modelo que inventa ids deja una pregunta");
  assert(/dogo|pepsi|gajo|papas/i.test(invented.reply), "la pregunta habla de lo que pidió");

  const unDogo = await play({
    message: "un dogo",
    store: georgeStore,
    products: georgeProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "dogo" }, "s"), tool("set_cart_line", { product_id: 21, qty: 1, unit: "pz" }, "c"), tool("finish_cart", {}, "f")] }],
  });
  assert(unDogo.cart.length === 1 && unDogo.cart[0].productId === 21, "un dogo es el Clásico");
  assert(unDogo.reply.includes("Clásico") && !unDogo.reply.includes("de Pollo"), "no elige el de pollo");

  const papas = await play({
    message: "unas papas",
    store: georgeStore,
    products: georgeProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "papas" }, "s"), tool("set_cart_line", { product_id: 16, qty: 1, unit: "pz" }, "g"), tool("finish_cart", {}, "f")] }],
  });
  assert(papas.cart.length === 0, "unas papas no elige gajo ni francesa");
  assert(/gajo/i.test(papas.reply) && /francesa/i.test(papas.reply), "pregunta gajo o francesa");
  assert(!papas.reply.includes("¿Están bien estos productos?"), "no cierra el pedido con las papas en duda");

  const res = await play({
    message: "una hamburguesa de res",
    store: georgeStore,
    products: georgeProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "hamburguesa de res" }, "s"), tool("set_cart_line", { product_id: 1, qty: 1, unit: "pz" }, "c"), tool("finish_cart", {}, "f")] }],
  });
  assert(res.cart.length === 0 && /chica/i.test(res.reply) && /grande/i.test(res.reply), "pregunta chica o grande");

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

  const nito = await play({
    message: "un Nito",
    store: pekesStore,
    products: pekesProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"), tool("finish_cart", {}, "f")] }],
  });
  assert(nito.cart.length === 0, "un Nito no elige la caja");
  assert(/62g/.test(nito.reply) && /duo/i.test(nito.reply) && /caja/i.test(nito.reply), "pregunta 62g, Duo y Caja");
  assert(!nito.reply.includes("¿Están bien estos productos?"), "no cierra sin tamaño");

  const caja = await play({
    message: "una caja de Nito",
    store: pekesStore,
    products: pekesProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "caja"), tool("finish_cart", {}, "f")] }],
  });
  assert(caja.cart.length === 1 && caja.cart[0].productId === 5378, "una caja de Nito anota la caja");
  assert(!/cuál de estos/i.test(caja.reply), "no vuelve a preguntar el tamaño");

  const agua = await play({
    message: "agua mineral",
    store: pekesStore,
    products: pekesProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "agua mineral" }, "s"), tool("set_cart_line", { product_id: 91020, qty: 1, unit: "pz" }, "ciel"), tool("finish_cart", {}, "f")] }],
  });
  assert(agua.cart.length === 0 && /ciel/i.test(agua.reply) && /peñafiel|penafiel/i.test(agua.reply), "agua mineral pregunta la marca");

  const azucar = await play({
    message: "un kilo de azúcar",
    store: pekesStore,
    products: pekesProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "azucar" }, "s"), tool("set_cart_line", { product_id: 91040, qty: 1, unit: "pz" }, "az"), tool("finish_cart", {}, "f")] }],
  });
  assert(azucar.cart.length === 1 && azucar.cart[0].productId === 91040 && azucar.cart[0].unit === "kg" && azucar.cart[0].qty === 1, "un kilo de azúcar se queda en kg");
  assert(!azucar.cart.some((item) => item.productId === 91041), "no anota el de 500 g");

  const ole = await play({
    message: "un Nito y un olé capuchino",
    store: pekesStore,
    products: pekesProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "nito" }, "s"), tool("finish_cart", {}, "f")] }],
  });
  const oleText = `${ole.reply}\n${(ole.pending?.queue ?? []).map((item) => item.question).join("\n")}`;
  assert(/ol[eé] capuchino/i.test(oleText), "olé capuchino no se pierde");
  assert(!ole.reply.includes("¿Están bien estos productos?"), "no resume si falta el olé");

  const seis = "un Nito, agua mineral, unos Pringles, una Coca, azúcar y un olé capuchino";
  const seisTurn = await play({
    message: seis,
    store: pekesStore,
    products: pekesProducts,
    steps: [
      {
        toolCalls: [
          tool("search_products", { query: "nito" }, "n"),
          tool("search_products", { query: "agua mineral" }, "a"),
          tool("search_products", { query: "pringles" }, "p"),
          tool("search_products", { query: "coca" }, "c"),
          tool("search_products", { query: "azucar" }, "z"),
          tool("search_products", { query: "ole capuchino" }, "o"),
          tool("set_cart_line", { product_id: 5378, qty: 1, unit: "pz" }, "nito"),
          tool("set_cart_line", { product_id: 91020, qty: 1, unit: "pz" }, "agua"),
          tool("set_cart_line", { product_id: 91030, qty: 1, unit: "pz" }, "pri"),
          tool("set_cart_line", { product_id: 91011, qty: 1, unit: "pz" }, "coca"),
          tool("set_cart_line", { product_id: 91041, qty: 1, unit: "pz" }, "azu"),
          tool("set_cart_line", { product_id: 91051, qty: 1, unit: "pz" }, "ole"),
          tool("finish_cart", {}, "f"),
        ],
      },
    ],
  });
  assert(seisTurn.cart.length === 0, "el mensaje de seis productos no elige solo");
  assert((seisTurn.reply.match(/¿/g) ?? []).length >= 1 && !seisTurn.reply.includes("¿Están bien estos productos?"), "pregunta uno");
  assert(!/pringles|coca|peñafiel|penafiel/i.test(seisTurn.reply), "los demás no van en el mismo mensaje");
  assert((seisTurn.pending?.queue?.length ?? 0) >= 5, "los otros cinco esperan en la cola");

  const cajaLine = line({ lineId: "l1", productId: 5378, name: "Caja Nito 15paq" });
  const pieza = await play({
    message: "no es una caja, solo una pieza",
    store: pekesStore,
    products: pekesProducts,
    cart: [cajaLine],
    steps: [
      {
        toolCalls: [
          tool("search_products", { query: "nito" }, "s"),
          tool("remove_line", { line_id: "l1" }, "quita"),
          tool("set_cart_line", { product_id: 4034, qty: 1, unit: "pz" }, "pieza"),
          tool("finish_cart", {}, "f"),
        ],
      },
    ],
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
  assert(chorizo.cart.length === 1 && chorizo.cart[0].productId === 75 && chorizo.cart[0].unit === "pesos" && chorizo.cart[0].qty === 100, "$100 de chorizo queda en pesos, el normal");
  assert(chorizo.reply.includes("$100"), "el ticket muestra los $100");

  const arrachera = await play({
    message: "arrachera",
    store: centralStore,
    products: centralProducts,
    steps: [{ toolCalls: [tool("search_products", { query: "arrachera" }, "s"), tool("set_cart_line", { product_id: 59, qty: 1, unit: "kg" }, "a"), tool("finish_cart", {}, "f")] }],
  });
  assert(arrachera.cart.some((item) => item.productId === 59) && !/marinada o normal/i.test(arrachera.reply), "arrachera sola es la marinada, sin pregunta");

  console.log("check-order-matching: ok");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
