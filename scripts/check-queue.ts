/**
 * Cola de Peke's: una pregunta, sin repetir, conteo y filtro por tipo.
 * Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-queue.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
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

const rows = JSON.parse(gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz")).toString("utf8")) as Fixture[];
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
const store: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true };

async function turn(message: string, pending: AgentPending | null = null) {
  return runOrderAgentTurn({
    message,
    cart: [],
    pending,
    history: [],
    store,
    products: [],
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
}

function chain(pending: AgentPending | null): AgentPending[] {
  if (!pending) return [];
  return [pending, ...(pending.queue ?? [])];
}

async function main(): Promise<void> {
const four = await turn("2 kilos de tortillas 1 electrolitos de coco una papas sabor takis y jamón");
const queued = chain(four.pending);
assert(queued.length === 4, `eran 4 dudas y salieron ${queued.length}: ${queued.map((item) => item.query).join(" | ")}\n${four.reply}`);
assert(/Producto 1 de 4/.test(four.reply), `conteo:\n${four.reply}`);
assert((four.reply.match(/¿/g) ?? []).length === 1, `una pregunta:\n${four.reply}`);
const keys = queued.map((item) => (item.query ?? item.question).toLowerCase());
assert(new Set(keys).size === keys.length, `repitió producto: ${keys.join(" | ")}`);

const chile = await turn("una lata de chiles jalapeños");
assert(chile.pending, `no preguntó jalapeños:\n${chile.reply}`);
assert(!/icee/i.test(chile.reply), `se coló Chile Icee:\n${chile.reply}`);
assert(/jalape/i.test(chile.reply), `opciones de jalapeño:\n${chile.reply}`);

const coca = await turn("una coca de 600 y una coca de 2 litros");
const cocaChain = chain(coca.pending);
const cocaQueries = cocaChain.map((item) => item.query ?? "");
assert(cocaQueries.length <= 2, `coca se duplicó: ${cocaQueries.join(" | ")}\n${coca.reply}`);
assert(!coca.cart.some((line) => line.qty > 1 && /coca/i.test(line.name)), "no duplicó la cantidad de coca");

console.log(`Cola: 4 dudas, jalapeños sin Icee, coca ${cocaQueries.length} pregunta(s)`);
}

main();
