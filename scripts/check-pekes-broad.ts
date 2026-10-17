/**
 * Pedidos como los escribiría un cliente, sobre una muestra fija del
 * catálogo completo de Peke's. Semilla 20261017, o la que se pase.
 * Cubre todas las categorías cuando la muestra es de al menos una fila
 * por categoría.
 *
 *   npx tsx scripts/check-pekes-broad.ts
 *   npx tsx scripts/check-pekes-broad.ts 300 20261018
 *
 * No llama a OpenAI, no manda WhatsApp y no escribe en Supabase.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { sharesProductType } from "../src/lib/orderAgent/match";
import { listaWordHit } from "../src/lib/storeProductSearch";
import { createSimAgentModel } from "./sim/agent-model";

const SEED = Number(process.argv[3] ?? 20261017);
const TARGET = 0.98;

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

type Sample = { id: number; name: string; category: string; product: AgentProduct };

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap];
    copy[swap] = current;
  }
  return copy;
}

const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "dos", "tres", "y", "con", "sin", "para", "por", "en", "al", "ml", "gr",
  "kg", "pz", "paq", "caja", "cajas", "lata", "latas", "bolsa", "bolsas",
  "paquete", "paquetes", "pieza", "piezas", "botella", "botellas",
]);

function tokensOf(name: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of fold(name).split(" ")) {
    if (token.length < 4 || token.length > 40 || STOP.has(token) || seen.has(token)) continue;
    if (/^\d+$/.test(token) || /\d/.test(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function wordHit(name: string, token: string): boolean {
  return fold(name).split(" ").some((word) => word === token || listaWordHit(word, token));
}

const PACKAGING = new Set(["vaso", "tapa", "caja", "bolsa", "lata", "paquete", "botella", "pieza"]);

function customerTypo(token: string): string {
  if (PACKAGING.has(token) || (token.length >= 5 && /[ao]$/.test(token))) {
    if (token.endsWith("o")) return `${token.slice(0, -1)}ito`;
    if (token.endsWith("a")) return `${token.slice(0, -1)}ita`;
  }
  const vowels = "aeiou";
  const chars = [...token];
  for (let index = 1; index < chars.length; index += 1) {
    const at = vowels.indexOf(chars[index]);
    if (at >= 0) {
      chars[index] = vowels[(at + 1) % vowels.length];
      return chars.join("");
    }
  }
  return `${token}e`;
}

function optionNames(reply: string): string[] {
  return reply.split("\n").flatMap((line) => {
    const match = line.trim().match(/^\d+\.\s+\*([^*]+)\*/);
    if (!match) return [];
    return [match[1].replace(/\s+—.*$/, "").replace(/\s+-\s+.*$/, "").trim()];
  });
}

function bareQuestion(reply: string): boolean {
  if (/no contamos con/i.test(reply)) return false;
  if (!/cuál de estos|cuál de estas/i.test(reply)) return false;
  return !/1\. \*/.test(reply);
}

function loadCatalog(): Fixture[] {
  const raw = gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz"));
  return JSON.parse(raw.toString("utf8")) as Fixture[];
}

const rows = loadCatalog();
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

const frequency = new Map<string, number>();
for (const product of products) {
  for (const token of new Set(tokensOf(product.name))) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
}

function genericToken(name: string): string | null {
  const ranked = tokensOf(name)
    .map((token) => ({ token, count: frequency.get(token) ?? 0 }))
    .filter((row) => row.count >= 8)
    .sort((left, right) => right.count - left.count || left.token.length - right.token.length);
  return ranked[0]?.token ?? null;
}

function rareToken(name: string): string | null {
  const ranked = tokensOf(name)
    .map((token) => ({ token, count: frequency.get(token) ?? 0 }))
    .sort((left, right) => left.count - right.count || right.token.length - left.token.length);
  return ranked[0]?.token ?? null;
}

function sampleProducts(size: number, seed: number): Sample[] {
  const rng = mulberry32(seed);
  const groups = new Map<string, AgentProduct[]>();
  for (const product of products) {
    const category = product.category?.trim() || "(sin categoría)";
    const list = groups.get(category) ?? [];
    list.push(product);
    groups.set(category, list);
  }
  const picked: Sample[] = [];
  const rest: Sample[] = [];
  for (const [category, list] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const ordered = shuffle(list, rng);
    const [first, ...tail] = ordered;
    if (!first) continue;
    picked.push({ id: first.id, name: first.name, category, product: first });
    for (const product of tail) rest.push({ id: product.id, name: product.name, category, product });
  }
  const extra = shuffle(rest, rng);
  return [...picked, ...extra].slice(0, Math.max(size, groups.size));
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

function otherType(message: string, cart: AgentLine[], allowedId?: number): boolean {
  const asked = tokensOf(message);
  return cart.some((line) => {
    if (allowedId != null && line.productId === allowedId) return false;
    if (sharesProductType(message, { name: line.name, brand: line.brand, presentation: line.presentation })) return false;
    if (asked.some((token) => wordHit(line.name, token))) return false;
    return true;
  });
}

type Failure = { category: string; kind: string; name: string; message: string; reason: string };

function judgeExact(sample: Sample, cart: AgentLine[], reply: string): string | null {
  if (bareQuestion(reply)) return "pregunta sin opciones";
  if (otherType(sample.name, cart, sample.id)) return "otro tipo en el carrito";
  const foreign = cart.filter((line) => line.productId !== sample.id);
  if (foreign.length) return `anotó otro producto (${foreign.map((line) => line.name).slice(0, 2).join(", ")})`;
  if (cart.some((line) => line.productId === sample.id)) return null;
  const options = optionNames(reply);
  if (options.some((name) => fold(name).includes(fold(sample.name)))) return null;
  if (/no contamos con/i.test(reply)) return "dijo que no hay el nombre exacto";
  return "no anotó el producto ni lo ofreció";
}

function judgeGeneric(sample: Sample, cart: AgentLine[], reply: string): string | null {
  if (bareQuestion(reply)) return "pregunta sin opciones";
  const token = genericToken(sample.name);
  if (otherType(token ? token : sample.name, cart, sample.id)) return "otro tipo en el carrito";
  const options = optionNames(reply);
  if (!token) {
    if (cart.length === 0 && options.length === 0 && !/no contamos con/i.test(reply)) return "no anotó ni ofreció";
    const spoken = tokensOf(sample.name)[0] ?? sample.name;
    const asked = tokensOf(spoken);
    if (asked.length && options.some((name) => !asked.some((part) => wordHit(name, part)))) return "opción de otro tipo";
    return null;
  }
  if (options.length < 2 || !/1\. \*/.test(reply)) return "el tipo genérico no trajo opciones numeradas";
  const mixed = options.filter((name) => !wordHit(name, token));
  if (mixed.length) return `opción de otro tipo (${mixed[0]})`;
  return null;
}

function judgeTypo(sample: Sample, message: string, cart: AgentLine[], reply: string): string | null {
  if (bareQuestion(reply)) return "pregunta sin opciones";
  if (otherType(message, cart, sample.id)) return "otro tipo en el carrito";
  if (cart.length) return `anotó directo con falta (${cart.map((line) => line.name).slice(0, 2).join(", ")})`;
  const options = optionNames(reply);
  if (!options.length || !/1\. \*/.test(reply)) {
    if (/no contamos con/i.test(reply)) return "dijo que no hay";
    return "pregunta sin opciones";
  }
  const asked = tokensOf(message);
  const mixed = options.filter((name) => asked.some((part) => !wordHit(name, part)));
  if (mixed.length) return `opción de otro tipo (${mixed[0]})`;
  if (options.some((name) => fold(name).includes(fold(sample.name)))) return null;
  if (/tamañ|sabor|escríbelo/i.test(reply)) return null;
  return "las opciones no incluyen el producto";
}

async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? 300);
  const size = Number.isFinite(requested) && requested >= 300 ? requested : Math.max(requested, 1);
  if (rows.length !== 12865) throw new Error(`el catálogo trae ${rows.length}, se esperaban 12865`);
  if (!Number.isFinite(SEED)) throw new Error("la semilla no es un número");
  const sample = size >= 300 ? sampleProducts(size, SEED) : sampleProducts(Math.max(size, 1), SEED).slice(0, size);
  const categories = new Set(products.map((product) => product.category?.trim() || "(sin categoría)"));
  if (size >= 300 && new Set(sample.map((item) => item.category)).size < categories.size) {
    throw new Error("la muestra no cubre todas las categorías");
  }
  console.log(`[pekes-broad] ${sample.length} productos, ${new Set(sample.map((item) => item.category)).size} categorías, semilla ${SEED}`);

  const failures: Failure[] = [];
  const byCategory = new Map<string, { pass: number; total: number }>();
  let passed = 0;
  let total = 0;
  for (const item of sample) {
    const bucket = byCategory.get(item.category) ?? { pass: 0, total: 0 };
    const exactMessage = item.name;
    const generic = genericToken(item.name);
    const genericMessage = generic ?? tokensOf(item.name)[0] ?? item.name;
    const rare = rareToken(item.name);
    const typoMessage = rare
      ? [...tokensOf(item.name).filter((token) => token !== rare).slice(0, 2), customerTypo(rare)].join(" ")
      : item.name;
    const cases: Array<{ kind: string; message: string; judge: (cart: AgentLine[], reply: string) => string | null }> = [
      { kind: "exacto", message: exactMessage, judge: (cart, reply) => judgeExact(item, cart, reply) },
      { kind: "generico", message: genericMessage, judge: (cart, reply) => judgeGeneric(item, cart, reply) },
      { kind: "falta", message: typoMessage, judge: (cart, reply) => judgeTypo(item, typoMessage, cart, reply) },
    ];
    for (const entry of cases) {
      total += 1;
      bucket.total += 1;
      const result = await ask(entry.message);
      const reason = entry.judge(result.cart, result.reply);
      if (reason) {
        failures.push({ category: item.category, kind: entry.kind, name: item.name, message: entry.message, reason });
      } else {
        passed += 1;
        bucket.pass += 1;
      }
    }
    byCategory.set(item.category, bucket);
    if (total % 60 === 0) console.log(`  ${passed}/${total}`);
  }

  const rate = total ? passed / total : 0;
  const rowsByRate = [...byCategory.entries()].sort((left, right) => left[1].pass / left[1].total - right[1].pass / right[1].total);
  console.log("\ncategoría\taciertos\ttotal\t%");
  for (const [category, stats] of rowsByRate) {
    const pct = ((100 * stats.pass) / stats.total).toFixed(1);
    console.log(`${category}\t${stats.pass}\t${stats.total}\t${pct}`);
  }
  const reasons = new Map<string, number>();
  for (const failure of failures) {
    const key = `${failure.kind}: ${failure.reason.split("(")[0].trim()}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.log("\nfallos más comunes");
  for (const [reason, count] of [...reasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)) {
    console.log(`${count}\t${reason}`);
  }
  console.log("\nejemplos");
  for (const failure of failures) {
    console.log(`${failure.kind}\t${failure.category}\t${failure.name}\t«${failure.message}»\t${failure.reason}`);
  }
  console.log(`\n[pekes-broad] ${passed}/${total} (${(100 * rate).toFixed(1)}%). Meta ${TARGET * 100}%.`);
  if (rate < TARGET) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
