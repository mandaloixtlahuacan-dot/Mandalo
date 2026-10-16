/**
 * AgentModel de simulador. No llama a OpenAI.
 * Busca y, si el código real ya elige una sola fila, la anota.
 * Si hay varias, no escoge: el loop del agente pregunta.
 */
import { stripOrderVerbs, isOrderVerbOnly } from "../../src/lib/orderAgent/catalog";
import { messageSelectsProduct } from "../../src/lib/orderAgent/match";
import type { AgentModel, AgentProduct } from "../../src/lib/orderAgent/types";

function asProducts(value: unknown): AgentProduct[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AgentProduct => Boolean(item) && typeof item === "object" && "id" in item && "name" in item);
}

function qtyFromMessage(message: string): number {
  const folded = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const digit = folded.match(/\b(\d+(?:\.\d+)?)\b/);
  if (digit) return Number(digit[1]);
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

export function createSimAgentModel(name: string): AgentModel {
  return {
    name: `sim-${name}`,
    async complete(request) {
      const searched = request.toolTrace.some((entry) => entry.ok && entry.call.name === "search_products");
      if (!searched) {
        const query = stripOrderVerbs(request.message).trim();
        if (!query || isOrderVerbOnly(query)) return { toolCalls: [], text: null };
        return {
          toolCalls: [{ id: "sim-search", name: "search_products", arguments: { query } }],
          text: null,
        };
      }
      const alreadySet = request.toolTrace.some((entry) => entry.call.name === "set_cart_line");
      if (alreadySet || request.repairErrors.length) return { toolCalls: [], text: null };
      const last = [...request.toolTrace].reverse().find((entry) => entry.ok && entry.call.name === "search_products");
      const products = asProducts(last?.result);
      const picked = products.filter((product) => messageSelectsProduct(product, products, request.message));
      if (picked.length !== 1) return { toolCalls: [], text: null };
      return {
        toolCalls: [
          {
            id: "sim-set",
            name: "set_cart_line",
            arguments: {
              product_id: picked[0].id,
              qty: qtyFromMessage(request.message),
              unit: unitFromMessage(request.message),
            },
          },
        ],
        text: null,
      };
    },
  };
}
