/**
 * Búsqueda de Peke's con el catálogo real (1,278 filas) más las filas que
 * Víctor nombró y las que ya salían en el SQL (Cloralex, sanitario, Zote).
 * Modelo mock. No llama a OpenAI, no manda WhatsApp y no escribe en Supabase.
 * Correr: npx tsx scripts/check-pekes-search.ts
 */
import { readFileSync } from "node:fs";

import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { LISTA_MIN_SCORE, rankListaCandidates } from "../src/lib/storeProductSearch";
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
  marca?: string | null;
  presentacion?: string | null;
  alias?: string[] | null;
};

function load(path: string): Fixture[] {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture[];
}

function asProducts(rows: Fixture[]): AgentProduct[] {
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

const rows = [...load("scripts/fixtures/pekes-real.json"), ...load("scripts/fixtures/pekes-gap.json")];
const products = asProducts(rows);
const store: AgentStore = {
  id: 7,
  name: "Mini Super Peke's",
  category: "abarrotes",
  catalogMode: "list",
  hasProductList: true,
};

type Case = {
  input: string;
  shows: string[];
  hides: string[];
  cartIncludes?: string[];
  cartExcludes?: string[];
  missing?: string;
  numbered?: boolean;
};

const cases: Case[] = [
  {
    input: "sanitas",
    shows: ["Sanitas"],
    hides: ["cloralex", "sanitario"],
    cartIncludes: ["Sanitas"],
    cartExcludes: ["Toallas", "Cloralex", "Sanitario"],
  },
  {
    input: "una caja de sanitas",
    shows: ["Sanitas", "100 Toallas"],
    hides: ["cloralex", "sanitario"],
    cartExcludes: ["Sanitas", "Cloralex", "Sanitario"],
    numbered: true,
  },
  {
    input: "cocacola",
    shows: ["Coca"],
    hides: ["cloralex", "sanitario"],
  },
  {
    input: "sabritas",
    shows: ["Sabritas"],
    hides: ["cloralex", "sanitario"],
  },
  {
    input: "fabulozo",
    shows: ["Fabuloso"],
    hides: ["cloralex", "sanitario"],
  },
  {
    input: "jabon zote",
    shows: ["Zote"],
    hides: ["savile", "cloralex"],
  },
  {
    input: "papel higienico petalo",
    shows: ["no contamos con", "papel higienico petalo", "deseas quitarlo de la lista"],
    hides: ["cloralex", "sanitario", "pantiprotect", "kleenex"],
    missing: "petalo",
  },
  {
    input: "servilletas",
    shows: ["no contamos con", "servilletas", "deseas quitarlo de la lista"],
    hides: ["cloralex", "sanitario", "sanitas"],
    missing: "servilletas",
  },
  {
    input: "pan bimbo",
    shows: ["Bimbo"],
    hides: ["pantene", "cloralex"],
    numbered: true,
  },
  {
    input: "nito",
    shows: ["Nito 62g"],
    hides: ["cariñitos", "gusanito", "cloralex"],
    cartIncludes: ["Nito 62g"],
    cartExcludes: ["Caja Nito"],
  },
  {
    input: "chicles",
    shows: ["Chicle"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "algo de limpieza",
    shows: ["Fabuloso"],
    hides: ["sanitas", "cloralex", "chicle"],
    numbered: true,
  },
  {
    input: "refresco",
    shows: ["Coca"],
    hides: ["cloralex", "sanitario", "sanitas"],
    numbered: true,
  },
  {
    input: "unicornio",
    shows: ["no contamos con", "unicornio", "deseas quitarlo de la lista"],
    hides: ["cloralex", "sanitario", "sanitas", "coca"],
    missing: "unicornio",
  },
];

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

async function ask(input: string): Promise<{ cart: AgentLine[]; reply: string }> {
  const turn = await runOrderAgentTurn({
    message: input,
    cart: [],
    pending: null,
    history: [],
    store,
    products: [],
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(input),
    escalationModel: null,
    logEvent: () => {},
  });
  return { cart: turn.cart, reply: turn.reply };
}

function preview(reply: string, cart: AgentLine[]): string {
  const names = cart.map((line) => line.name).join(", ");
  const text = reply.replace(/\s+/g, " ").trim();
  const body = names ? `Carrito: ${names}. ${text}` : text;
  return body.length > 180 ? `${body.slice(0, 177)}...` : body;
}

function rankNames(query: string): string[] {
  return rankListaCandidates(
    products.map((product) => ({
      id: product.id,
      nombre: product.name,
      marca: product.brand,
      presentacion: product.presentation,
      categoria: product.category,
      alias: product.alias,
      precio: product.price,
    })),
    query,
    8,
  ).map((row) => row.nombre);
}

async function main(): Promise<void> {
  assert(LISTA_MIN_SCORE === 2, "el umbral de una falta de ortografía es 2; por debajo no se ofrece");
  assert(products.some((product) => product.id === 7783 && product.name === "Sanitas"), "falta Sanitas 7783");
  assert(products.some((product) => product.id === 12913), "falta Sanitas 100 Toallas");

  const sanitas = rankNames("una caja de sanitas");
  assert(sanitas.some((name) => name === "Sanitas") && sanitas.some((name) => /100 toallas/i.test(name)), `el ranking no sube Sanitas: ${sanitas.join(" | ")}`);
  assert(!sanitas.some((name) => /sanitario|cloralex/i.test(name)), `sanitas se mezcló: ${sanitas.join(" | ")}`);
  const nito = rankNames("nito");
  assert(nito[0] === "Nito 62g", `Nito 62g no queda primero: ${nito.slice(0, 4).join(" | ")}`);
  assert(!nito.some((name) => /carinitos|gusanito/i.test(fold(name))), `nito sigue mezclando: ${nito.slice(0, 6).join(" | ")}`);

  const table: string[] = [];
  const failed: string[] = [];
  for (const item of cases) {
    try {
      const result = await ask(item.input);
      const blob = fold(`${result.reply}\n${result.cart.map((line) => line.name).join(" ")}`);
      for (const piece of item.shows) {
        assert(blob.includes(fold(piece)), `no muestra «${piece}»`);
      }
      for (const piece of item.hides) {
        assert(!blob.includes(fold(piece)), `sí muestra «${piece}»`);
      }
      const names = result.cart.map((line) => line.name).join(" | ");
      for (const piece of item.cartIncludes ?? []) {
        assert(names.toLowerCase().includes(piece.toLowerCase()), `el carrito no tiene «${piece}»: ${names}`);
      }
      for (const piece of item.cartExcludes ?? []) {
        assert(!names.toLowerCase().includes(piece.toLowerCase()), `el carrito no debía tener «${piece}»: ${names}`);
      }
      if (item.numbered) {
        assert(/1\. \*/.test(result.reply) && /2\. \*/.test(result.reply), "no salieron opciones numeradas");
        assert(result.cart.length === 0, "anotó solo en vez de preguntar");
      }
      if (item.missing) {
        assert(/no contamos con/i.test(result.reply) && /deseas quitarlo de la lista/i.test(result.reply), "no pidió quitarlo de la lista");
        assert(result.cart.length === 0, "anotó un producto que no está");
      }
      if (item.input === "sanitas") {
        assert(result.cart.length === 1 && result.cart[0]?.productId === 7783, `sanitas no tomó el producto obvio: ${names}`);
      }
      if (item.input === "una caja de sanitas") {
        assert(result.reply.includes("Sanitas") && result.reply.includes("Sanitas 100 Toallas"), "no ofreció las dos presentaciones");
      }
      table.push(`PASA\t${item.input}\t${preview(result.reply, result.cart)}`);
      console.log(`PASA  ${item.input}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(`${item.input}: ${message}`);
      table.push(`FALLA\t${item.input}\t${message}`);
      console.error(`FALLA ${item.input}: ${message}`);
    }
  }
  console.log("\ninput\tbot\tresultado");
  for (const line of table) {
    const [status, input, detail] = line.split("\t");
    console.log(`${status}\t${input}\t${detail}`);
  }
  if (failed.length) {
    console.error(`\n${failed.length} casos fallaron`);
    process.exit(1);
  }
  console.log(`\n[pekes-search] ${cases.length} casos. Umbral LISTA_MIN_SCORE=${LISTA_MIN_SCORE}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
