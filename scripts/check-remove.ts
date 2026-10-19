/**
 * Quitar productos: varios a la vez, sin pregunta abierta, y sin agregar.
 * Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-remove.ts
 */
import { runOrderAgentTurn, type AgentLine, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { createSimAgentModel } from "./sim/agent-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const store: AgentStore = {
  id: 7,
  name: "Mini Super Peke's",
  category: "abarrotes",
  catalogMode: "list",
  hasProductList: true,
};
const products: AgentProduct[] = [
  { id: 1, name: "Chile Serrano", price: 20, available: true, unit: "pz", variants: [], brand: null, presentation: null, alias: [], category: null },
  { id: 2, name: "Coca-Cola 600 ml", price: 18, available: true, unit: "pz", variants: [], brand: "Coca-Cola", presentation: "600 ml", alias: [], category: null },
  { id: 3, name: "Coca-Cola 2 l", price: 35, available: true, unit: "pz", variants: [], brand: "Coca-Cola", presentation: "2 l", alias: [], category: null },
  { id: 4, name: "Coca-Cola 2.5 l", price: 40, available: true, unit: "pz", variants: [], brand: "Coca-Cola", presentation: "2.5 l", alias: [], category: null },
];

function line(id: number, name: string): AgentLine {
  const product = products.find((item) => item.id === id);
  return {
    lineId: `l${id}`,
    productId: id,
    freeText: null,
    name,
    qty: 1,
    unit: "pz",
    variant: null,
    note: null,
    unitPrice: product?.price ?? null,
    brand: product?.brand ?? null,
    presentation: product?.presentation ?? null,
  };
}

const cart = [line(1, "Chile Serrano"), line(2, "Coca-Cola 600 ml"), line(3, "Coca-Cola 2 l"), line(4, "Coca-Cola 2.5 l")];

async function turn(message: string, lines: AgentLine[], pending = null as null) {
  return runOrderAgentTurn({
    message,
    cart: lines,
    pending,
    history: [],
    store,
    products,
    search: async () => products,
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
}

async function main(): Promise<void> {
const both = await turn("Quítame el chile serrano, también la coca de 2 l", cart);
assert(!both.cart.some((item) => item.productId === 1), "quitó el serrano");
assert(!both.cart.some((item) => item.productId === 3), "quitó la coca de 2 l");
assert(both.cart.some((item) => item.productId === 2), "se quedó la de 600");
assert(both.cart.some((item) => item.productId === 4), "se quedó la de 2.5");
assert(both.cart.length === 2, `no agregó: ${both.cart.map((item) => item.name).join(", ")}`);
assert(!/no contamos/i.test(both.reply), `quitar no dice que no hay:\n${both.reply}`);

const one = await turn("Quita la Coca-Cola de 2 l", cart);
assert(!one.cart.some((item) => item.productId === 3), "Quita la de 2 l");
assert(one.cart.length === 3, "quitar una no agrega");

const which = await turn("Falta que quite la cola", [line(2, "Coca-Cola 600 ml"), line(3, "Coca-Cola 2 l"), line(4, "Coca-Cola 2.5 l")]);
assert(which.cart.length === 3, "si hay varias, no borra todas");
assert(/cu[aá]l quieres quitar/i.test(which.reply), `pregunta cuál:\n${which.reply}`);
assert((which.reply.match(/¿/g) ?? []).length <= 1, "una sola pregunta");

const open = await turn("quite la coca de 2 l", cart, null);
assert(!open.cart.some((item) => item.productId === 3), "quite funciona sin pregunta abierta");

console.log("Quitar: serrano + coca 2 l, una sola, y pregunta si hay varias");
}

main();
