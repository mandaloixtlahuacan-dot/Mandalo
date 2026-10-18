/**
 * No se pierde un producto y un pedido no pasa de 2 preguntas.
 * Usa el catálogo real y un AgentModel mock. No llama a OpenAI.
 * Correr: npx tsx scripts/check-order-loss.ts
 */
import { readFileSync } from "node:fs";

import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import type { RawCatalogRow } from "../src/lib/catalogOrder/types";
import { agentProductsFromCatalog, runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
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
      brand: null,
      presentation: null,
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

const pekesRows = load("scripts/fixtures/pekes-real.json");
const georgeRows = load("scripts/fixtures/george-catalogo.json");
const centralRows = load("scripts/fixtures/lacentral-catalogo.json");
const pekesProducts = asLista(pekesRows);
const georgeProducts = agentProductsFromCatalog(buildCatalog(asRaw(georgeRows), "restaurante"));
const centralProducts = agentProductsFromCatalog(buildCatalog(asRaw(centralRows), "carniceria"));

const QUESTION = /cu[aá]l de estos|marinada o normal|qu[eé] sabor/i;

type Case = {
  id: string;
  store: "pekes" | "george" | "central";
  message: string;
  /** Si pregunta, estas respuestas, en orden. Máximo 2. */
  answers?: string[];
  cartIncludes: string[];
  qty?: Array<{ name: string; qty: number }>;
  missing?: string[];
  priced?: boolean;
  quote?: boolean;
};

const VICTOR_PEKES = "Quiero 2 fuste de frutos rojos también 1 kilo de frijol 1 litro de fabuloso y un nito";
const VICTOR_GEORGE = "Quiero dos hamburguesas Una recia de pollo, también quiero un dogo clásico, después unas papas gajo y tres Pepsi";

const cases: Case[] = [
  {
    id: "victor-pekes",
    store: "pekes",
    message: VICTOR_PEKES,
    answers: ["sí", "1"],
    cartIncludes: ["Fuzetea/Frutos Rojos 600ml", "Fabuloso", "Nito 62g"],
    qty: [
      { name: "Fuzetea/Frutos Rojos 600ml", qty: 2 },
      { name: "Nito 62g", qty: 1 },
    ],
    missing: ["frijol"],
    quote: true,
  },
  {
    id: "victor-george",
    store: "george",
    message: VICTOR_GEORGE,
    cartIncludes: ["Hamburguesa de Pollo Chica", "Dogo Clásico", "Papas Gajo", "Pepsi"],
    qty: [
      { name: "Hamburguesa de Pollo Chica", qty: 2 },
      { name: "Pepsi", qty: 3 },
    ],
    priced: true,
  },
  {
    id: "central-kilos",
    store: "central",
    message: "medio kilo de arrachera, 300 gramos de bistec de res y un kilo de diezmillo",
    answers: ["normal"],
    cartIncludes: ["Arrachera", "Bistec de res", "Diezmillo"],
    qty: [
      { name: "Arrachera", qty: 0.5 },
      { name: "Diezmillo", qty: 1 },
    ],
    priced: true,
  },
  { id: "pekes-coca-lata", store: "pekes", message: "una coca de 600 y un sabritas", answers: ["1"], cartIncludes: ["600", "Sabritas"], quote: true },
  { id: "pekes-caja-nito", store: "pekes", message: "una caja de nito y un pan bimbo", answers: ["1"], cartIncludes: ["Caja Nito"], quote: true },
  { id: "pekes-bonafont", store: "pekes", message: "un agua donado de litro y un rollo de petalo", answers: ["1"], cartIncludes: ["Bonafont", "Petalo"], missing: [], quote: true },
  { id: "pekes-no-esta", store: "pekes", message: "un kilo de frijol negro y una coca de 600", cartIncludes: ["Coca", "600"], missing: ["frijol"], quote: true },
  { id: "pekes-aceite", store: "pekes", message: "un litro de aceite y un kilo de azucar", answers: ["1", "1"], cartIncludes: ["Aceite"], quote: true },
  { id: "pekes-leche", store: "pekes", message: "2 leches lala de litro y un pan dulce", answers: ["1"], cartIncludes: ["Lala"], quote: true },
  { id: "pekes-jabon", store: "pekes", message: "un jabon zote y un cloro", cartIncludes: ["Cloro"], missing: ["zote"], quote: true },
  { id: "pekes-galletas", store: "pekes", message: "unas galletas marias y un nito", answers: ["1", "1"], cartIncludes: ["Marias", "Nito"], quote: true },
  { id: "pekes-huevo", store: "pekes", message: "un kilo de caviar y una coca de 600", cartIncludes: ["600"], missing: ["caviar"], quote: true },
  { id: "pekes-jugo", store: "pekes", message: "un jugo del valle y un agua ciel", answers: ["1", "1"], cartIncludes: ["Ciel"], quote: true },
  { id: "pekes-papel", store: "pekes", message: "un papel higienico y un fabuloso de litro", answers: ["1", "1"], cartIncludes: ["Fabuloso"], quote: true },
  { id: "george-sencillo", store: "george", message: "una hamburguesa de res grande y unas papas a la francesa", cartIncludes: ["Hamburguesa de Res Grande", "Papas a la francesa"], priced: true },
  { id: "george-dogos", store: "george", message: "3 dogos y una pepsi", cartIncludes: ["Dogo Clásico", "Pepsi"], qty: [{ name: "Dogo Clásico", qty: 3 }], priced: true },
  { id: "george-mixto", store: "george", message: "2 dogos de pollo, una hamburguesa cubana grande y dos seven", cartIncludes: ["Dogo de Pollo", "Cubana Grande", "Seven"], qty: [{ name: "Dogo de Pollo", qty: 2 }, { name: "Seven", qty: 2 }], priced: true },
  { id: "george-sin-pizza", store: "george", message: "una pizza y un dogo clasico", cartIncludes: ["Dogo Clásico"], missing: ["pizza"], priced: true },
  { id: "george-papas", store: "george", message: "unas papas gajo y una manzanita", cartIncludes: ["Papas Gajo", "Manzana"], priced: true },
  { id: "george-pollo", store: "george", message: "una hamburguesa de pollo", cartIncludes: ["Hamburguesa de Pollo Chica"], priced: true },
  { id: "central-varios", store: "central", message: "un kilo de chorizo, medio de pulpa de puerco y un carbon", answers: ["1"], cartIncludes: ["Pulpa de puerco", "Carbón"], priced: true },
  { id: "central-pesos", store: "central", message: "100 pesos de diezmillo y medio kilo de chamberete", cartIncludes: ["Diezmillo", "Chamberete"], priced: true },
  { id: "central-no-esta", store: "central", message: "un kilo de salmon y medio kilo de arrachera", cartIncludes: ["Arrachera"], missing: ["salmon"], priced: true },
  { id: "central-pastor", store: "central", message: "300 gramos de carne al pastor y un kilo de costilla de puerco", answers: ["normal"], cartIncludes: ["pastor", "Costilla"], priced: true },
];

function catalogOf(store: Case["store"]): { store: AgentStore; products: AgentProduct[] } {
  if (store === "pekes") return { store: pekesStore, products: pekesProducts };
  if (store === "george") return { store: georgeStore, products: georgeProducts };
  return { store: centralStore, products: centralProducts };
}

async function play(item: Case): Promise<{ cart: AgentLine[]; replies: string[]; questions: number }> {
  const catalog = catalogOf(item.store);
  let cart: AgentLine[] = [];
  let pending: AgentPending | null = null;
  const replies: string[] = [];
  let questions = 0;
  const messages = [item.message, ...(item.answers ?? [])];
  const seen = new Map<number, number>();
  for (const message of messages) {
    const before = cart.map((line) => line.productId);
    const turn = await runOrderAgentTurn({
      message,
      cart,
      pending,
      history: [],
      store: catalog.store,
      products: catalog.store.catalogMode === "fixed" ? catalog.products : [],
      search: async (query) => searchAgentProducts(catalog.products, query, 24),
      model: createSimAgentModel(item.id),
      escalationModel: null,
      logEvent: () => {},
    });
    for (const id of before) {
      if (id == null) continue;
      if (!turn.cart.some((line) => line.productId === id)) {
        throw new Error(`${item.id}: se perdió el producto ${id} al contestar «${message}»`);
      }
    }
    cart = turn.cart;
    pending = turn.pending;
    replies.push(turn.reply);
    for (const line of cart) {
      if (line.productId == null) continue;
      seen.set(line.productId, (seen.get(line.productId) ?? 0) + 1);
    }
    if (QUESTION.test(turn.reply)) questions += 1;
    if (!pending && !QUESTION.test(turn.reply)) break;
  }
  return { cart, replies, questions };
}

function blob(lines: AgentLine[]): string {
  return lines.map((line) => `${line.qty} ${line.name} ${line.variant ?? ""}`).join(" | ");
}

async function main(): Promise<void> {
  assert(cases.length >= 23, "hacen falta los pedidos de Víctor y unos 20 más");
  const failed: string[] = [];
  for (const item of cases) {
    try {
      const result = await play(item);
      const names = blob(result.cart);
      const said = result.replies.join("\n");
      for (const piece of item.cartIncludes) {
        assert(names.toLowerCase().includes(piece.toLowerCase()) || said.toLowerCase().includes(piece.toLowerCase()), `${item.id}: no quedó «${piece}». Carrito: ${names}`);
      }
      for (const piece of item.qty ?? []) {
        const line = result.cart.find((row) => `${row.name} ${row.variant ?? ""}`.toLowerCase().includes(piece.name.toLowerCase()));
        assert(line, `${item.id}: falta ${piece.name}`);
        assert(Math.abs(line.qty - piece.qty) < 0.001, `${item.id}: ${piece.name} quedó en ${line.qty}, se pidió ${piece.qty}`);
      }
      for (const piece of item.missing ?? []) {
        assert(new RegExp(`${piece}.*no (?:lo )?(?:tenemos|contamos)|no (?:lo )?(?:tenemos|contamos).*${piece}`, "i").test(said), `${item.id}: no dijo que no tiene ${piece}. ${said.slice(0, 400)}`);
      }
      assert(result.questions <= 2, `${item.id}: ${result.questions} preguntas, el tope es 2`);
      if (item.priced) {
        assert(/\$35/.test(said), `${item.id}: el ticket no trae los $35`);
        assert(/est[aá]n bien estos productos/i.test(said), `${item.id}: no pidió el sí`);
      }
      if (item.quote) {
        const closed = result.replies[result.replies.length - 1] ?? "";
        if (/est[aá]n bien estos productos/i.test(closed)) {
          const withoutFee = closed.replace(/\$35/g, "");
          assert(!/\$\d/.test(withoutFee), `${item.id}: Peke's mostró precio de producto`);
          assert(/\$35/.test(closed), `${item.id}: la lista de Peke's no trae los $35`);
        }
      }
      if (item.id === "victor-george") {
        assert(result.questions === 0, "George se arma a la primera, sin preguntar");
        assert(!/cubana/i.test(result.replies[0] ?? ""), "la pregunta de pollo no mete otra hamburguesa");
        assert(!/chica chica/i.test(said), "la opción no repite chica");
      }
      if (item.id === "victor-pekes") {
        const fuze = result.cart.find((line) => line.productId === 6476);
        const nito = result.cart.find((line) => line.productId === 4034);
        assert(fuze && fuze.qty === 2, "fuste queda en Fuzetea/Frutos Rojos 600ml id 6476, cantidad 2");
        assert(nito && nito.qty === 1, "un nito queda en Nito 62g id 4034");
        assert(result.questions === 1, "Peke's pregunta el Fabuloso; el frijol va en su propio mensaje");
      }
      console.log(`PASA  ${item.id}  preguntas=${result.questions}  ${names}`);
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
  console.log(`\n[order-loss] ${cases.length} pedidos, sin perder producto y con máximo 2 preguntas`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
