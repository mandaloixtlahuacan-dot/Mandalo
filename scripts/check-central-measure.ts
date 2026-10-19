/**
 * La Central: la medida contestada se queda en el corte de la pregunta.
 * Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-central-measure.ts
 */
import { readFileSync } from "node:fs";
import { foldAgent, searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { createSimAgentModel } from "./sim/agent-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Row = {
  id: number;
  nombre_producto: string;
  precio: number | null;
  disponible: boolean;
  categoria: string | null;
  marca: string | null;
  presentacion: string | null;
  alias: string[] | null;
};

const rows = JSON.parse(readFileSync(new URL("./fixtures/lacentral-catalogo.json", import.meta.url), "utf8")) as Row[];
const products: AgentProduct[] = rows.map((row) => ({
  id: row.id,
  name: row.nombre_producto,
  price: row.precio,
  available: row.disponible !== false,
  unit: foldAgent(row.categoria ?? "") === "extras" ? "pz" : "kg",
  variants: [],
  brand: row.marca,
  presentation: row.presentacion,
  alias: row.alias ?? [],
  category: row.categoria,
}));
const store: AgentStore = { id: 6, name: "Carnicería La Central", category: "carniceria", catalogMode: "fixed" };

async function turn(message: string, cart: AgentLine[] = [], pending: AgentPending | null = null) {
  return runOrderAgentTurn({
    message,
    cart,
    pending,
    history: pending ? [{ role: "assistant", text: pending.question }] : [],
    store,
    products,
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
}

async function main(): Promise<void> {
const first = await turn("medio kilo de pulpa de puerco, un kilo de costilla de puerco");
assert(first.pending, `tenía que preguntar el corte:\n${first.reply}`);
assert((first.reply.match(/¿/g) ?? []).length <= 1, `una pregunta:\n${first.reply}`);
const about = `${first.pending.query ?? ""} ${first.pending.question}`;
const costillaFirst = /costilla/i.test(about) && !/pulpa/i.test(first.pending.query ?? "");
const answered = await turn("Normal", first.cart, first.pending);
const added = answered.cart.filter((line) => !first.cart.some((prev) => prev.lineId === line.lineId));
const target = added[0] ?? answered.cart.find((line) => costillaFirst ? /costilla/i.test(line.name) : /pulpa/i.test(line.name));
assert(target, `no anotó el corte de la pregunta:\n${answered.reply}\n${JSON.stringify(answered.cart)}`);
if (/costilla/i.test(target.name)) {
  assert(target.qty === 1 && target.unit === "kg", `la costilla debe ser 1 kg y fue ${target.qty} ${target.unit}`);
} else {
  assert(/pulpa/i.test(target.name), target.name);
  assert(target.qty === 0.5 && target.unit === "kg", `la pulpa debe ser medio kilo y fue ${target.qty} ${target.unit}`);
}
assert(!answered.cart.some((line) => /costilla/i.test(line.name) && line.qty === 0.5), "la costilla no heredó el medio kilo de la pulpa");

console.log(`La Central: ${target.name} ${target.qty} ${target.unit}`);
}

main();
