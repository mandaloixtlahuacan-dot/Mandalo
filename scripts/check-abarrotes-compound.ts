/**
 * Frases de dos palabras del catálogo de Peke's y las dudas de una tienda sin lista.
 * Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-abarrotes-compound.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { conjunctionPhrases, contentTokens, orderClauses } from "../src/lib/orderAgent/match";
import { prepareQuoteItems, quoteItemNeedsDetail, quoteQuestionForItems } from "../src/lib/quoteProductClarity";
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

const raw = gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz"));
const rows = JSON.parse(raw.toString("utf8")) as Fixture[];
assert(rows.length === 12865, `catálogo ${rows.length}`);
const products: AgentProduct[] = rows.filter((row) => row.disponible !== false).map((row) => ({
  id: row.id,
  name: row.nombre_producto,
  price: row.precio ?? null,
  available: true,
  unit: "pz",
  variants: [],
  brand: row.marca ?? null,
  presentation: row.presentacion ?? null,
  alias: row.alias ?? [],
  category: row.categoria ?? null,
}));

const STOP = new Set(["para", "con", "del", "las", "los", "una", "uno", "por", "que"]);
const phrases = new Set<string>();
for (const row of rows) {
  const words = row.nombre_producto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zñ0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP.has(word));
  for (let index = 0; index < words.length - 1; index += 1) {
    phrases.add(`${words[index]} ${words[index + 1]}`);
  }
}
assert(phrases.size > 500, `salieron ${phrases.size} frases`);

const catalogAnd = conjunctionPhrases(products.map((product) => product.name));
let kept = 0;
for (const phrase of phrases) {
  if (contentTokens(phrase).length < 2) continue;
  const clauses = orderClauses(phrase, catalogAnd);
  assert(clauses.length === 1, `partió "${phrase}" en ${clauses.join(" | ")}`);
  kept += 1;
}
for (const phrase of catalogAnd) {
  const clauses = orderClauses(`1 ${phrase}`, catalogAnd);
  assert(clauses.length === 1, `partió el nombre con y "${phrase}"`);
}

function questionFor(text: string): string {
  const items = prepareQuoteItems([], text);
  const open = items.filter((item) => quoteItemNeedsDetail(item));
  return quoteQuestionForItems(open.length ? [open[0]] : items) ?? "";
}

const crema = questionFor("2 queso crema");
assert(/philadelphia/i.test(crema), `queso crema pregunta Philadelphia:\n${crema}`);
assert(!/alpura o santa clara/i.test(crema), `queso crema no es la crema:\n${crema}`);
const leche = questionFor("leche Lala entera");
assert(/leche/i.test(leche) && !/condensada/i.test(leche), "leche Lala sigue siendo leche");
const condensada = questionFor("leche condensada");
assert(/condensada|lechera|carnation/i.test(condensada), `leche condensada:\n${condensada}`);
assert(!/deslactosada/i.test(condensada), "leche condensada no pregunta entera/deslactosada");
const cacahuate = questionFor("crema de cacahuate");
assert(/cacahuate|skippy|aladino/i.test(cacahuate), `crema de cacahuate:\n${cacahuate}`);
assert(!/alpura o santa clara/i.test(cacahuate), "crema de cacahuate no es la crema de leche");
const oaxaca = questionFor("queso oaxaca");
assert(/oaxaca/i.test(oaxaca) && !/philadelphia/i.test(oaxaca), `queso oaxaca sigue siendo queso:\n${oaxaca}`);

const found = searchAgentProducts(products, "queso crema", 24);
assert(found.some((product) => /philadelphia/i.test(product.name)), `queso crema no encontró Philadelphia: ${found.map((product) => product.name).slice(0, 8).join(" | ")}`);

async function main(): Promise<void> {
const pekes: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true };
const agua: AgentStore = { id: 1, name: "Abarrotes Agua Santa", category: "abarrotes", catalogMode: "list", hasProductList: false };

async function turn(store: AgentStore, message: string, cart: AgentLine[] = [], pending: AgentPending | null = null) {
  return runOrderAgentTurn({
    message,
    cart,
    pending,
    history: [],
    store,
    products: store.hasProductList ? [] : [],
    search: store.hasProductList ? async (query) => searchAgentProducts(products, query, 24) : undefined,
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
}

const night = "Quiero 2 queso crema 1 litro de leche 1 pan Bimbo para sandwiches y 1 paquete de jamón";
const cursor = await turn(agua, night);
const chain = [cursor.pending, ...(cursor.pending?.queue ?? [])].filter((item): item is NonNullable<typeof cursor.pending> => Boolean(item));
const blob = chain.map((item) => `${item.query ?? ""} ${item.question}`).join(" | ");
assert(/queso crema/i.test(blob), `se perdió el queso crema:\n${blob}\n${cursor.reply}`);
assert(/leche/i.test(blob), `se perdió la leche:\n${blob}`);
assert(/jam[oó]n/i.test(blob), `se perdió el jamón:\n${blob}`);
assert((cursor.reply.match(/¿/g) ?? []).length <= 1, `más de una pregunta:\n${cursor.reply}`);
const keys = chain.map((item) => (item.query ?? item.question).toLowerCase());
assert(new Set(keys).size === keys.length, `repitió duda: ${keys.join(" | ")}`);
const queso = chain.find((item) => /queso crema/i.test(`${item.query ?? ""} ${item.question}`));
assert(queso, "no hay pregunta de queso crema");
const refined = await turn(agua, "Es queso crema", cursor.cart, { ...queso, queue: chain.filter((item) => item !== queso) });
assert(/queso crema/i.test(`${refined.pending?.query ?? ""} ${refined.reply}`), `Es queso crema se perdió:\n${refined.reply}`);
assert(!/alpura o santa clara/i.test(refined.reply), `se volvió crema de leche:\n${refined.reply}`);

const comma = await turn(pekes, "jalapeños, 2, queso crema");
const creamAsk = [comma.pending, ...(comma.pending?.queue ?? [])].find((item) => /queso/i.test(`${item?.query ?? ""} ${item?.question ?? ""}`));
assert(creamAsk || comma.cart.some((line) => /queso/i.test(line.name)), `no preguntó queso crema:\n${comma.reply}\n${JSON.stringify(comma.cart)}`);
const creamLine = comma.cart.find((line) => /queso/i.test(line.name));
assert((creamAsk?.qty ?? 0) === 2 || creamLine?.qty === 2, `el 2 se quedó con el queso:\n${JSON.stringify(creamAsk ?? creamLine)}`);

console.log(`Abarrotes: ${kept} frases de dos palabras, ${catalogAnd.length} con y, queso crema y tienda sin lista ok`);
}

main();
