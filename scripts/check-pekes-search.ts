/**
 * Búsqueda de Peke's contra el catálogo real completo (12,865 filas).
 * Modelo mock. No llama a OpenAI, no manda WhatsApp y no escribe en Supabase.
 * Correr: npx tsx scripts/check-pekes-search.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { LISTA_MIN_SCORE, listaSqlTokens, rankListaCandidates } from "../src/lib/storeProductSearch";
import { createSimAgentModel } from "./sim/agent-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Fixture = {
  id: number;
  nombre_producto: string;
  precio?: number | null;
  disponible?: boolean;
  categoria?: string | null;
  marca?: string | null;
  presentacion?: string | null;
  alias?: string[] | null;
};

function loadCatalog(): Fixture[] {
  const raw = gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz"));
  return JSON.parse(raw.toString("utf8")) as Fixture[];
}

function asProducts(rows: Fixture[]): AgentProduct[] {
  return rows
    .filter((row) => row.disponible !== false)
    .map((row) => ({
      id: row.id,
      name: row.nombre_producto,
      price: row.precio ?? null,
      available: true,
      unit: "pz" as const,
      variants: [],
      brand: row.marca ?? null,
      presentation: row.presentacion ?? null,
      alias: row.alias ?? [],
      category: row.categoria ?? null,
    }));
}

const rows = loadCatalog();
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
  direct?: boolean;
};

const cases: Case[] = [
  {
    input: "sanitas",
    shows: ["Sanitas", "100 Toallas"],
    hides: ["cloralex", "sanitario"],
    cartExcludes: ["Sanitas"],
    numbered: true,
  },
  {
    input: "Sanitas 100 Toallas",
    shows: ["Sanitas 100 Toallas"],
    hides: ["cloralex", "sanitario"],
    cartIncludes: ["Sanitas 100 Toallas"],
    direct: true,
  },
  {
    input: "una caja de sanitas",
    shows: ["Sanitas", "100 Toallas"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "servilletas",
    shows: ["Servilleta"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "servilletas petalo",
    shows: ["Servilleta", "Petalo"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "papel petalo",
    shows: ["Hig", "Petalo"],
    hides: ["aluminio", "cloralex"],
    numbered: true,
  },
  {
    input: "papel higienico petalo",
    shows: ["Hig", "Petalo"],
    hides: ["aluminio", "servilleta"],
    numbered: true,
  },
  {
    input: "coca 600",
    shows: ["Coca", "600"],
    hides: ["cloralex", "2.5"],
    cartIncludes: ["600"],
    direct: true,
  },
  {
    input: "cocacola",
    shows: ["Coca"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "jabon zote",
    shows: ["Zote"],
    hides: ["savile", "cloralex"],
    numbered: true,
  },
  {
    input: "zote",
    shows: ["Zote"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "pawer",
    shows: ["Powerade"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "Pepe si",
    shows: ["Pepsi"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "fuste",
    shows: ["Fuzetea"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "halls",
    shows: ["Halls"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "takis",
    shows: ["Takis"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "maruchan",
    shows: ["Maruchan"],
    hides: ["cloralex"],
    numbered: true,
  },
  {
    input: "una caja de nito",
    shows: ["Caja Nito"],
    hides: ["cariñitos", "gusanito"],
    cartIncludes: ["Caja Nito"],
    direct: true,
  },
  {
    input: "un nito",
    shows: ["Nito 62g"],
    hides: ["cariñitos", "gusanito", "Caja Nito"],
    cartIncludes: ["Nito 62g"],
    cartExcludes: ["Caja Nito"],
    direct: true,
  },
  {
    input: "algo de limpieza",
    shows: ["Fabuloso"],
    hides: ["sanitas", "cloralex"],
    numbered: true,
  },
  {
    input: "refresco",
    shows: ["Coca"],
    hides: ["cloralex", "sanitario"],
    numbered: true,
  },
  {
    input: "kombucha",
    shows: ["no contamos con", "kombucha", "deseas quitarlo de la lista"],
    hides: ["cloralex", "sanitario", "coca"],
    missing: "kombucha",
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
  return body.length > 220 ? `${body.slice(0, 217)}...` : body;
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

/** Misma idea que la migración no aplicada: palabra exacta antes que el pedazo, tope 200. */
function sqlWindow(query: string): string[] {
  const tokens = listaSqlTokens(query);
  const scored: Array<{ name: string; exact: number; starts: number; matched: number; rank: number }> = [];
  for (const row of rows) {
    const nombre = fold(row.nombre_producto).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const words = nombre.split(" ").filter(Boolean);
    const glued = nombre.replace(/(\d)\s+(ml|l|lt|g|gr|kg|pz)\b/g, "$1$2");
    let exact = 0;
    let matched = 0;
    let rank = 0;
    let starts = 0;
    for (const token of tokens) {
      const whole = words.some((word) => word === token);
      const piece = nombre.includes(token) || glued.includes(token);
      if (!whole && !piece) continue;
      matched += 1;
      rank += whole ? 8 : 2;
      if (whole) exact += 1;
      if (nombre === token || nombre.startsWith(`${token} `)) starts = 1;
    }
    if (rank > 0) scored.push({ name: row.nombre_producto, exact, starts, matched, rank });
  }
  scored.sort((a, b) => b.exact - a.exact || b.starts - a.starts || b.matched - a.matched || b.rank - a.rank || a.name.localeCompare(b.name));
  return scored.slice(0, 200).map((row) => row.name);
}

async function main(): Promise<void> {
  assert(rows.length === 12865, `el catálogo completo trae ${rows.length}, se esperaban 12865`);
  assert(LISTA_MIN_SCORE === 2, "el umbral de una falta de ortografía es 2; por debajo no se ofrece");
  assert(products.some((product) => product.id === 7783 && product.name === "Sanitas"), "falta Sanitas 7783");
  assert(products.some((product) => product.id === 12913 && product.name === "Sanitas 100 Toallas"), "falta Sanitas 100 Toallas");
  assert(products.some((product) => /servilleta petalo/i.test(product.name)), "el catálogo completo no trae servilletas Pétalo");
  assert(products.some((product) => /hig petalo/i.test(product.name)), "el catálogo completo no trae papel Hig Pétalo");

  const sanitas = rankNames("sanitas");
  assert(sanitas.some((name) => name === "Sanitas") && sanitas.some((name) => /100 toallas/i.test(name)), `el ranking no sube las dos Sanitas: ${sanitas.join(" | ")}`);
  assert(!sanitas.some((name) => /sanitario|cloralex/i.test(name)), `sanitas se mezcló: ${sanitas.join(" | ")}`);
  const nito = rankNames("nito");
  assert(nito[0] === "Nito 62g", `Nito 62g no queda primero: ${nito.slice(0, 4).join(" | ")}`);
  assert(!nito.some((name) => /carinitos|gusanito/i.test(fold(name))), `nito sigue mezclando: ${nito.slice(0, 6).join(" | ")}`);

  const windowChecks: Array<{ query: string; need: RegExp }> = [
    { query: "sanitas", need: /Sanitas/ },
    { query: "servilletas petalo", need: /Servilleta Petalo/ },
    { query: "papel higienico petalo", need: /Hig Petalo/ },
    { query: "coca 600", need: /Coca Cola 600/ },
    { query: "jabon zote", need: /Zote/ },
    { query: "pawer", need: /Powerade/ },
    { query: "Pepe si", need: /Pepsi/ },
    { query: "fuste", need: /Fuzetea|Fuze Tea/ },
    { query: "halls", need: /Halls/ },
    { query: "takis", need: /Takis/ },
    { query: "maruchan", need: /Maruchan/ },
    { query: "un nito", need: /Nito 62g/ },
    { query: "una caja de nito", need: /Caja Nito/ },
    { query: "algo de limpieza", need: /Fabuloso/ },
    { query: "refresco", need: /Coca/ },
  ];
  for (const check of windowChecks) {
    const window = sqlWindow(check.query);
    assert(window.length <= 200, `${check.query} pasó de 200`);
    assert(window.some((name) => check.need.test(name)), `${check.query} se quedó fuera del top 200`);
  }

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
      if (item.direct) {
        assert(result.cart.length === 1, `no anotó un solo producto: ${names || result.reply.slice(0, 120)}`);
        assert(!/1\. \*/.test(result.reply), "preguntó en vez de anotar el producto exacto");
      }
      if (item.missing) {
        assert(/no contamos con/i.test(result.reply) && /deseas quitarlo de la lista/i.test(result.reply), "no pidió quitarlo de la lista");
        assert(result.cart.length === 0, "anotó un producto que no está");
      }
      if (item.input === "sanitas") {
        assert(result.reply.includes("Sanitas") && result.reply.includes("Sanitas 100 Toallas"), "sanitas no ofreció las dos presentaciones");
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
  console.log(`\n[pekes-search] ${cases.length} casos sobre ${rows.length} productos. Umbral LISTA_MIN_SCORE=${LISTA_MIN_SCORE}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
