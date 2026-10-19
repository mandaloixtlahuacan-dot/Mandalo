/**
 * Menú de George con el modelo simulado. No llama a OpenAI.
 * Cada producto disponible, cada sabor de refresco, y las frases
 * reales del 18 oct 2026.
 * Correr: npx tsx scripts/check-george-menu.ts
 */
import { readFileSync } from "node:fs";
import { foldAgent } from "../src/lib/orderAgent/catalog";
import { runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
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

function drinkVariants(name: string): string[] {
  const match = name.match(/^(.*)\(([^)]+)\)\s*$/);
  if (!match) return [];
  return match[2]
    .split(/,|\by\b|\bo\b/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 1 && !/^o$/i.test(part));
}

const rows = JSON.parse(readFileSync(new URL("./fixtures/george-catalogo.json", import.meta.url), "utf8")) as Row[];
const products: AgentProduct[] = rows.map((row) => ({
  id: row.id,
  name: row.nombre_producto,
  price: row.precio,
  available: row.disponible !== false,
  unit: "pz",
  variants: drinkVariants(row.nombre_producto),
  brand: row.marca,
  presentation: row.presentacion,
  alias: row.alias ?? [],
  category: row.categoria,
}));
const store: AgentStore = {
  id: 5,
  name: "Hamburguesas Hotdogs George",
  category: "restaurante",
  catalogMode: "fixed",
};

function questions(reply: string): number {
  return (reply.match(/¿/g) ?? []).length + (reply.match(/no contamos/gi) ?? []).length;
}

async function turn(message: string, cart: AgentLine[] = [], pending: AgentPending | null = null) {
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

function hasLine(cart: AgentLine[], id: number, variant?: string | null): boolean {
  return cart.some((line) => {
    if (line.productId !== id) return false;
    if (variant == null) return true;
    return foldAgent(line.variant ?? "") === foldAgent(variant);
  });
}

async function settle(message: string, id: number, variant?: string | null): Promise<AgentLine[]> {
  let result = await turn(message);
  for (let step = 0; step < 3 && result.pending && !hasLine(result.cart, id, variant); step += 1) {
    const choice = result.reply.split("\n").find((line) => {
      if (!/^\d+\./.test(line.trim())) return false;
      if (variant) return foldAgent(line).includes(foldAgent(variant));
      return foldAgent(line).includes(foldAgent(products.find((product) => product.id === id)?.name ?? "___"));
    });
    const number = choice?.match(/^(\d+)\./)?.[1] ?? "1";
    result = await turn(number, result.cart, result.pending);
  }
  assert(hasLine(result.cart, id, variant), `${message} no anotó ${id} ${variant ?? ""}\n${result.reply}`);
  assert(questions(result.reply) <= 1, `${message} juntó avisos:\n${result.reply}`);
  return result.cart;
}

async function main(): Promise<void> {
const available = products.filter((product) => product.available);
const drink = available.find((product) => product.variants.length);
assert(drink, "el refresco está en el menú");
let covered = 0;

for (const product of available) {
  if (product.variants.length) {
    for (const flavor of product.variants) {
      await settle(`1 ${flavor}`, product.id, flavor);
      covered += 1;
    }
    continue;
  }
  await settle(`1 ${product.name}`, product.id);
  covered += 1;
}

const solids = available.filter((product) => product.variants.length === 0);
for (let index = 0; index < solids.length; index += 2) {
  const left = solids[index];
  const right = solids[index + 1];
  if (!left || !right) break;
  let result = await turn(`1 ${left.name} y 1 ${right.name}`);
  for (let step = 0; step < 4 && result.pending; step += 1) {
    const pendingIds = new Set(result.pending.candidateIds);
    const wanted = [left, right].find((product) => pendingIds.has(product.id));
    const number = result.reply.split("\n").find((line) => wanted && /^\d+\./.test(line.trim()) && foldAgent(line).includes(foldAgent(wanted.name).split(" ").slice(-2).join(" ")))?.match(/^(\d+)\./)?.[1];
    result = await turn(number ?? "1", result.cart, result.pending);
  }
  assert(hasLine(result.cart, left.id), `combinado sin ${left.name}\n${result.reply}`);
  assert(hasLine(result.cart, right.id), `combinado sin ${right.name}\n${result.reply}`);
  assert(questions(result.reply) <= 1, `combinado juntó avisos:\n${result.reply}`);
}

const res = await turn("una hamburguesa de res");
assert(res.cart.length === 0, "hamburguesa de res no se anota sin tamaño");
assert(/chica/i.test(res.reply) && /grande/i.test(res.reply), `pregunta el tamaño:\n${res.reply}`);
assert(/1\./.test(res.reply) && /2\./.test(res.reply), `opciones numeradas:\n${res.reply}`);
assert(questions(res.reply) <= 1, `un solo aviso:\n${res.reply}`);

const otra = await turn("otra hamburguesa de pollo");
assert(/chica/i.test(otra.reply) && /grande/i.test(otra.reply), `otra hamburguesa pregunta tamaño:\n${otra.reply}`);
assert(!/no contamos/i.test(otra.reply), "otra hamburguesa no es un producto faltante");

const mar = await turn("1 hamburguesa mar y tierra grande");
assert(hasLine(mar.cart, 12), `mar y tierra grande:\n${mar.reply}\n${JSON.stringify(mar.cart)}`);
assert(!mar.cart.some((line) => /tierra grande/i.test(line.name) && line.productId !== 12), "no partió mar y tierra");

const dedos = await turn("una orden de dos de queso");
assert(hasLine(dedos.cart, 18), `dedos de queso:\n${dedos.reply}\n${JSON.stringify(dedos.cart)}`);
assert(dedos.cart.find((line) => line.productId === 18)?.qty === 1, "una orden es 1, no 2");

const mirandas = await turn("dos meriendas");
assert(hasLine(mirandas.cart, drink.id, "mirinda"), `meriendas:\n${mirandas.reply}`);
assert(mirandas.cart.find((line) => foldAgent(line.variant ?? "") === "mirinda")?.qty === 2, "dos meriendas son 2");

const seven = await turn("un 7up");
assert(hasLine(seven.cart, drink.id, "seven"), `7up:\n${seven.reply}\n${JSON.stringify(seven.cart)}`);

const held = await turn("quiero una manzana y una pepsi", [
  { lineId: "l1", productId: 1, freeText: null, name: "Hamburguesa de Res Chica", qty: 1, unit: "pz", variant: null, note: null, unitPrice: 60, brand: null, presentation: null },
]);
assert(hasLine(held.cart, drink.id, "manzana"), `manzana con carrito:\n${held.reply}`);
assert(hasLine(held.cart, drink.id, "pepsi"), `pepsi con carrito:\n${held.reply}`);
assert(hasLine(held.cart, 1), "la hamburguesa que ya estaba se queda");

const flavors = await turn("una Pepsi y una manzana", [], {
  question: "¿Qué sabor de refresco?",
  candidateIds: [drink.id],
  qty: 2,
  unit: "pz",
  axis: "flavor",
  query: "dos refrescos",
});
const pepsi = flavors.cart.find((line) => foldAgent(line.variant ?? "") === "pepsi");
const manzana = flavors.cart.find((line) => foldAgent(line.variant ?? "") === "manzana");
assert(pepsi?.qty === 1 && manzana?.qty === 1, `sabores 1 y 1:\n${JSON.stringify(flavors.cart)}`);

const both = await turn("las dos Pepsi", [], {
  question: "¿Qué sabor?",
  candidateIds: [drink.id],
  qty: 2,
  unit: "pz",
  axis: "flavor",
  query: "dos refrescos",
});
assert(both.cart.find((line) => foldAgent(line.variant ?? "") === "pepsi")?.qty === 2, "las dos Pepsi");

const kept = await turn("Pepsi", [
  { lineId: "l1", productId: drink.id, freeText: null, name: "Refresco Mirinda", qty: 1, unit: "pz", variant: "Mirinda", note: null, unitPrice: 20, brand: null, presentation: null },
], {
  question: "¿Qué sabor?",
  candidateIds: [drink.id],
  qty: 1,
  unit: "pz",
  axis: "flavor",
  query: "refresco",
});
assert(kept.cart.filter((line) => line.productId === drink.id).length === 2, "Pepsi no borra la Mirinda");

const extra = await turn("agrega otro refresco de Mirinda", [
  { lineId: "l1", productId: drink.id, freeText: null, name: "Refresco Mirinda", qty: 1, unit: "pz", variant: "Mirinda", note: null, unitPrice: 20, brand: null, presentation: null },
]);
assert(extra.cart.find((line) => foldAgent(line.variant ?? "") === "mirinda")?.qty === 2, `otro mirinda suma:\n${JSON.stringify(extra.cart)}\n${extra.reply}`);
assert(!/no contamos/i.test(extra.reply), "otro mirinda no es faltante");

const plain = await turn("una hamburguesa sin verdura");
assert(!/no contamos/i.test(plain.reply), `sin verdura no es faltante:\n${plain.reply}`);
assert(/hamburguesa/i.test(plain.reply), `pregunta la hamburguesa:\n${plain.reply}`);
assert(/sin verdura/i.test(`${plain.reply} ${plain.pending?.query ?? ""}`), "guarda la nota sin verdura");
assert(questions(plain.reply) <= 1, `un aviso:\n${plain.reply}`);

const sync = await turn("1 sincronizada de pierna y tocino");
assert(sync.cart.length === 0, "la sincronizada no disponible no se anota");
assert(/no contamos/i.test(sync.reply), `avisa que no está:\n${sync.reply}`);
assert(!/cu[aá]l de estos|Dime qu[eé] se te antoja/i.test(sync.reply), `un solo aviso de faltante:\n${sync.reply}`);

const caro = await turn("Es muy caro, yo no quiero pedir");
assert(/cancelar el pedido/i.test(caro.reply), `caro cancela:\n${caro.reply}`);
assert(!/no contamos/i.test(caro.reply), "caro no es un producto");
const yaNo = await turn("Me refiero que ya no quiero un pedido");
assert(/cancelar el pedido/i.test(yaNo.reply), `ya no quiero un pedido:\n${yaNo.reply}`);

const comma = await turn("Agrega 2, Mirindas");
assert(comma.cart.find((line) => foldAgent(line.variant ?? "") === "mirinda")?.qty === 2, `2 mirindas:\n${JSON.stringify(comma.cart)}\n${comma.reply}`);

console.log(`George menú: ${covered} productos/sabores, combinados ${Math.floor(solids.length / 2)}, frases del 18 oct ok`);
}

main();
