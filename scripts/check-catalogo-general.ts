/**
 * Cinco casos del catálogo. Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-catalogo-general.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
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

function loadRows(path: string, gzip: boolean): Fixture[] {
  const raw = readFileSync(path);
  const text = gzip ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text) as Fixture[];
}

function toProducts(rows: Fixture[], unit: "pz" | "kg" = "pz"): AgentProduct[] {
  return rows.filter((row) => row.disponible !== false).map((row) => ({
    id: row.id,
    name: row.nombre_producto,
    price: row.precio ?? null,
    available: true,
    unit,
    variants: [],
    brand: row.marca ?? null,
    presentation: row.presentacion ?? null,
    alias: row.alias ?? [],
    category: row.categoria ?? null,
  }));
}

const pekesProducts = toProducts(loadRows("scripts/fixtures/pekes-catalogo-completo.json.gz", true));
const georgeProducts = toProducts(loadRows("scripts/fixtures/george-catalogo.json", false));
const pekes: AgentStore = { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true };
const george: AgentStore = { id: 5, name: "Hamburguesas Hotdogs George", category: "restaurante", catalogMode: "fixed", hasProductList: true };

async function turn(
  store: AgentStore,
  products: AgentProduct[],
  message: string,
  cart: AgentLine[] = [],
  pending: AgentPending | null = null,
) {
  return runOrderAgentTurn({
    message,
    cart,
    pending,
    history: [],
    store,
    products,
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
}

function offeredIds(pending: AgentPending | null): number[] {
  if (!pending) return [];
  return [pending, ...(pending.queue ?? [])].flatMap((item) => item.candidateIds);
}

function chain(pending: AgentPending | null): AgentPending[] {
  if (!pending) return [];
  return [pending, ...(pending.queue ?? [])];
}

async function main(): Promise<void> {
  const mary = await turn(george, georgeProducts, "Mary tierra");
  const maryBlob = `${mary.reply}\n${mary.cart.map((line) => line.name).join("\n")}`;
  assert(/mar y tierra/i.test(maryBlob), `1 Mary tierra no salió Mar y Tierra:\n${mary.reply}`);
  assert(!/no contamos/i.test(mary.reply), `1 Mary tierra se rechazó:\n${mary.reply}`);
  console.log("1 pasa: Mary tierra → Mar y Tierra");

  const tortillas = await turn(pekes, pekesProducts, "tortillas de maíz");
  const tortillaIds = [...tortillas.cart.map((line) => line.productId), ...offeredIds(tortillas.pending)];
  assert(tortillaIds.includes(723), `2 no está Tortillas 723. carrito=${tortillas.cart.map((line) => line.productId).join(",")} opciones=${offeredIds(tortillas.pending).join(",")}\n${tortillas.reply}`);
  console.log("2 pasa: tortillas de maíz → 723");

  const queso = await turn(pekes, pekesProducts, "queso chelita");
  const quesoIds = offeredIds(queso.pending);
  assert(queso.cart.length === 0, `3 anotó solo:\n${queso.cart.map((line) => line.name).join(" | ")}\n${queso.reply}`);
  assert(quesoIds.includes(11082) && quesoIds.includes(11507), `3 no ofrece 1 kg y 250 g: ${quesoIds.join(",")}\n${queso.reply}`);
  assert(/1\s*kg/i.test(queso.reply) && /250/.test(queso.reply), `3 la lista no muestra los dos tamaños:\n${queso.reply}`);
  console.log("3 pasa: queso chelita → 1 kg y 250 g");

  let state = await turn(pekes, pekesProducts, "2 litros de leche lala, 3 sprites, 2 kg de tortillas y un chocolate");
  const queued = chain(state.pending);
  assert(queued.length === 4, `4 salieron ${queued.length} preguntas, no 4: ${queued.map((item) => `${item.query} qty=${item.qty} ${item.unit}`).join(" | ")}\n${state.reply}`);
  for (let step = 0; step < 4; step += 1) {
    assert(state.pending, `4 se cerró antes de la respuesta ${step + 1}`);
    state = await turn(pekes, pekesProducts, "1", state.cart, state.pending);
  }
  assert(!state.pending, `4 quedó una pregunta:\n${state.reply}`);
  const tortillaLine = state.cart.find((line) => line.productId === 723);
  assert(tortillaLine?.qty === 2 && tortillaLine.unit === "kg", `4 tortillas quedó ${tortillaLine?.qty} ${tortillaLine?.unit} (${tortillaLine?.name})`);
  const sprite = state.cart.find((line) => /sprite/i.test(line.name));
  const leche = state.cart.find((line) => /lala|leche/i.test(line.name));
  const chocolate = state.cart.find((line) => /chocolate/i.test(line.name));
  assert(sprite?.qty === 3, `4 Sprite quedó ${sprite?.qty} (${sprite?.name})`);
  assert(leche?.qty === 2, `4 leche quedó ${leche?.qty} ${leche?.unit} (${leche?.name})`);
  assert(chocolate?.qty === 1, `4 chocolate quedó ${chocolate?.qty} (${chocolate?.name})`);
  assert(/2 kilos/i.test(state.reply), `4 el resumen no trae 2 kilos:\n${state.reply}`);
  console.log("4 pasa: cuatro «1» y el resumen trae 2 kg de tortillas");

  const typo = await turn(pekes, pekesProducts, "bocadim");
  const typoNames = [
    ...typo.cart.map((line) => line.name),
    ...chain(typo.pending).flatMap((item) => item.candidateIds.map((id) => pekesProducts.find((product) => product.id === id)?.name ?? "")),
  ].filter(Boolean);
  assert(typoNames.some((name) => /bocadin/i.test(name)), `5 «bocadim» no reconoció Bocadin:\n${typo.reply}`);
  assert(typoNames.every((name) => /bocadin/i.test(name)), `5 «bocadim» metió otro producto: ${typoNames.join(" | ")}\n${typo.reply}`);
  console.log("5 pasa: bocadim → solo Bocadin");

  console.log("Catálogo general: 5/5");
}

main();
