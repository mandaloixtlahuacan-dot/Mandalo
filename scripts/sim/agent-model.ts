/**
 * AgentModel de simulador. No llama a OpenAI.
 * Busca y, si el código real ya elige una sola fila, la anota.
 * Si hay varias, no escoge: el loop del agente pregunta.
 */
import { stripOrderVerbs, isOrderVerbOnly } from "../../src/lib/orderAgent/catalog";
import { messageSelectsProduct, orderClauses } from "../../src/lib/orderAgent/match";
import type { AgentModel, AgentProduct } from "../../src/lib/orderAgent/types";

function asProducts(value: unknown): AgentProduct[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AgentProduct => Boolean(item) && typeof item === "object" && "id" in item && "name" in item);
}

function qtyFromMessage(message: string): number {
  const folded = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|lt|lts|litros?|g|gr|gramos?|kg|kilos?|toallas?|servilletas?|hojas?|rollos?|pz|pzas?|piezas?|paq|paquetes?)\b/g, " ");
  const digit = folded.match(/\b(\d+(?:\.\d+)?)\b/);
  // «coca 600» y «100 toallas» son presentación, no cantidad.
  if (digit && Number(digit[1]) > 0 && Number(digit[1]) <= 40) return Number(digit[1]);
  const words: Array<[RegExp, number]> = [
    [/\bmedio\b|\bmedia\b/, 0.5],
    [/\bun\b|\buna\b/, 1],
    [/\bdos\b/, 2],
    [/\btres\b/, 3],
    [/\bcuatro\b/, 4],
    [/\bcinco\b/, 5],
  ];
  for (const [pattern, qty] of words) {
    if (pattern.test(folded)) return qty;
  }
  return 1;
}

function unitFromMessage(message: string): "pz" | "kg" | "pesos" {
  const folded = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  if (/\bpesos\b|\$\s*\d/.test(folded)) return "pesos";
  if (/\bkilos?\b|\bkg\b/.test(folded)) return "kg";
  return "pz";
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function clausesOf(message: string): string[] {
  const parts = orderClauses(message)
    .map((clause) => stripOrderVerbs(clause).trim())
    .filter((clause) => clause.length > 1);
  return parts.length ? parts : [message.trim()].filter(Boolean);
}

export function createSimAgentModel(name: string): AgentModel {
  return {
    name: `sim-${name}`,
    async complete(request) {
      if (request.repairErrors.length) return { toolCalls: [], text: null };
      const clauses = clausesOf(request.message)
        .map((clause) => stripOrderVerbs(clause).trim())
        .filter((clause) => clause && !isOrderVerbOnly(clause));
      const searched = request.toolTrace.filter((entry) => entry.ok && entry.call.name === "search_products");
      const searchedQueries = new Set(searched.map((entry) => fold(String(entry.call.arguments?.query ?? ""))));
      const pending = clauses.filter((clause) => !searchedQueries.has(fold(clause)));
      if (pending.length && searched.length === 0) {
        return {
          toolCalls: pending.map((clause, index) => ({
            id: `sim-search-${index}`,
            name: "search_products" as const,
            arguments: { query: clause },
          })),
          text: null,
        };
      }
      if (pending.length) {
        return {
          toolCalls: [{ id: "sim-search-next", name: "search_products", arguments: { query: pending[0] } }],
          text: null,
        };
      }
      const calls: Array<{ id: string; name: "set_cart_line"; arguments: { product_id: number; qty: number; unit: string } }> = [];
      for (const entry of searched) {
        const products = asProducts(entry.result);
        const query = String(entry.call.arguments?.query ?? "");
        const picked = products.filter((product) => messageSelectsProduct(product, products, query));
        if (picked.length !== 1) continue;
        const product = picked[0];
        const inCart = request.cart.some((line) => line.productId === product.id);
        const alreadySet = request.toolTrace.some(
          (item) => item.call.name === "set_cart_line" && Number(item.call.arguments?.product_id) === product.id,
        );
        if (inCart || alreadySet) continue;
        calls.push({
          id: `sim-set-${product.id}`,
          name: "set_cart_line",
          arguments: {
            product_id: product.id,
            qty: qtyFromMessage(query),
            unit: unitFromMessage(query),
          },
        });
      }
      if (!calls.length) return { toolCalls: [], text: null };
      return { toolCalls: calls, text: null };
    },
  };
}
