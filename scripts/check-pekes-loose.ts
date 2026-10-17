/**
 * Palabras sueltas que aparecen en productos de varios tipos.
 * Ninguna se anota directo: todas salen con opciones numeradas.
 *
 *   npx tsx scripts/check-pekes-loose.ts
 *
 * No llama a OpenAI, no manda WhatsApp y no escribe en Supabase.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { createSimAgentModel } from "./sim/agent-model";

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

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const raw = gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz"));
const rows = JSON.parse(raw.toString("utf8")) as Fixture[];
const products: AgentProduct[] = rows
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

const store: AgentStore = {
  id: 7,
  name: "Mini Super Peke's",
  category: "abarrotes",
  catalogMode: "list",
  hasProductList: true,
};

function looseWords(size: number): string[] {
  const types = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const product of products) {
    const seen = new Set<string>();
    const category = (product.category ?? "").trim().toLowerCase();
    for (const token of fold(product.name).split(" ")) {
      if (token.length < 4 || token.length > 20 || /\d/.test(token) || seen.has(token)) continue;
      seen.add(token);
      const set = types.get(token) ?? new Set<string>();
      set.add(category);
      types.set(token, set);
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...types.entries()]
    .map(([token, cats]) => ({ token, types: cats.size, count: counts.get(token) ?? 0 }))
    .filter((row) => row.types >= 2 && row.count >= 2)
    .sort((left, right) => right.types - left.types || right.count - left.count || left.token.localeCompare(right.token))
    .slice(0, size)
    .map((row) => row.token);
}

function optionNames(reply: string): string[] {
  return reply.split("\n").flatMap((line) => {
    const match = line.trim().match(/^\d+\.\s+\*([^*]+)\*/);
    if (!match) return [];
    return [match[1].replace(/\s+—.*$/, "").replace(/\s+-\s+.*$/, "").trim()];
  });
}

async function ask(message: string): Promise<{ cart: AgentLine[]; reply: string }> {
  const turn = await runOrderAgentTurn({
    message,
    cart: [],
    pending: null,
    history: [],
    store,
    products: [],
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
  return { cart: turn.cart, reply: turn.reply };
}

async function main(): Promise<void> {
  assert(rows.length === 12865, `el catálogo trae ${rows.length}, se esperaban 12865`);
  const words = looseWords(50);
  assert(words.length === 50, `salieron ${words.length} palabras, se esperaban 50`);
  assert(words.includes("naranja") && words.includes("fresa"), `faltan sabores: ${words.slice(0, 12).join(", ")}`);
  console.log(`[pekes-loose] ${words.length} palabras: ${words.join(", ")}`);

  const failures: string[] = [];
  for (const word of words) {
    const result = await ask(word);
    const options = optionNames(result.reply);
    const numbered = /1\. \*/.test(result.reply) && options.length >= 2;
    if (result.cart.length) {
      failures.push(`${word}: anotó ${result.cart.map((line) => line.name).slice(0, 2).join(", ")}`);
    } else if (!numbered) {
      failures.push(`${word}: sin opciones numeradas (${result.reply.slice(0, 80).replace(/\s+/g, " ")})`);
    }
  }

  const cases: Array<{ message: string; need: RegExp[] }> = [
    { message: "chinita", need: [/sal china/i, /chinita/i] },
    { message: "jugo manzana boda", need: [/jugo bida/i] },
    { message: "jugo fresa boda", need: [/jugo bida/i] },
    { message: "jugo cosecha para", need: [/cosecha pura/i, /naranja/i] },
    { message: "speed cool stcke", need: [/speed/i, /cool/i] },
    { message: "naranja", need: [/naranja/i] },
    { message: "marlboro", need: [/marlboro/i] },
  ];
  for (const item of cases) {
    const result = await ask(item.message);
    const blob = `${result.reply}\n${result.cart.map((line) => line.name).join(" ")}`;
    if (result.cart.length) failures.push(`${item.message}: anotó ${result.cart.map((line) => line.name).join(", ")}`);
    if (!/1\. \*/.test(result.reply)) failures.push(`${item.message}: sin opciones`);
    for (const need of item.need) {
      if (!need.test(blob)) failures.push(`${item.message}: no muestra ${need}`);
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(failure);
    throw new Error(`${failures.length} fallos de palabras sueltas`);
  }
  console.log(`[pekes-loose] ${words.length} palabras y los casos de falta, sin anotar directo.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
