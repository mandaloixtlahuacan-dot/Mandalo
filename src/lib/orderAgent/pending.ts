import { foldAgent } from "@/lib/orderAgent/catalog";
import { answerMatchesPresentation } from "@/lib/orderAgent/match";
import type { AgentLine, AgentPending, AgentProduct, AgentUnit } from "@/lib/orderAgent/types";

function asNumber(text: string): number | null {
  const match = foldAgent(text).match(/^(?:(?:la|el|opcion|numero|pues|es)\s+)?(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function pointsAtFirst(text: string): boolean {
  return /^(?:pues\s+|es\s+)?(?:ese|esa|eso|ese mismo|esa misma|el primero|la primera|el de arriba)$/.test(foldAgent(text));
}

function sizeWord(text: string): string | null {
  const folded = foldAgent(text);
  if (/\bgrandes?\b/.test(folded)) return "grande";
  if (/\bchicas?\b/.test(folded)) return "chica";
  if (/\bchicos?\b/.test(folded)) return "chico";
  return null;
}

function wantsPlain(text: string): boolean {
  return /\b(normal|natural|sencilla|sin marinar)\b/.test(foldAgent(text));
}

function wantsMarinade(text: string): boolean {
  return /\bmarinad|\badobad/.test(foldAgent(text));
}

function lineFor(product: AgentProduct, qty: number, unit: AgentUnit, variant: string | null, lineId: string): AgentLine {
  return {
    lineId,
    productId: product.id,
    freeText: null,
    name: variant ? `${product.name} ${variant}` : product.name,
    qty,
    unit,
    variant,
    note: null,
    unitPrice: product.price,
    brand: product.brand,
    presentation: product.presentation,
  };
}

/**
 * Resuelve «grande», «2», «normal», «Pepsi» contra las opciones de la pregunta.
 * No toca el resto del carrito.
 */
export function resolveAgentPending(params: {
  pending: AgentPending;
  message: string;
  products: AgentProduct[];
  cart: AgentLine[];
  nextLineId: string;
}): { cart: AgentLine[]; pending: null } | null {
  const { pending, message, products } = params;
  const rows = pending.candidateIds
    .map((id) => products.find((product) => product.id === id))
    .filter((row): row is AgentProduct => Boolean(row));
  if (!rows.length) return null;
  const qty = pending.qty && pending.qty > 0 ? pending.qty : 1;
  const unit: AgentUnit = pending.unit ?? (rows[0].unit === "kg" ? "kg" : "pz");
  let chosen: AgentProduct | null = null;
  let variant: string | null = null;

  const number = asNumber(message);
  if (number != null) chosen = rows[number - 1] ?? null;
  if (!chosen && pointsAtFirst(message)) chosen = rows[0] ?? null;

  const size = sizeWord(message);
  if (!chosen && size) {
    chosen = rows.find((row) => foldAgent(`${row.name} ${row.presentation ?? ""}`).includes(size)) ?? null;
  }

  if (!chosen && (wantsPlain(message) || wantsMarinade(message))) {
    const seasoned = wantsMarinade(message) && !wantsPlain(message);
    const matched = rows.filter((row) => /marinad|adobad/.test(foldAgent(`${row.name} ${row.presentation ?? ""}`)) === seasoned);
    if (matched.length === 1) chosen = matched[0];
    else if (wantsPlain(message) && rows.length === 1 && !/marinad|adobad/.test(foldAgent(rows[0].name))) chosen = rows[0];
  }

  if (!chosen) {
    const folded = foldAgent(message);
    const drink = rows.find((row) => row.variants.length);
    const flavor = drink?.variants.find((option) => new RegExp(`\\b${foldAgent(option)}\\b`).test(folded));
    if (drink && flavor) {
      chosen = drink;
      variant = flavor;
    }
  }

  if (!chosen) {
    const folded = foldAgent(message);
    const words = folded.split(" ").filter((token) => token.length >= 3);
    const named = rows.filter((row) => {
      const name = foldAgent(`${row.brand ?? ""} ${row.name} ${row.presentation ?? ""}`);
      if (folded.length >= 3 && name.includes(folded)) return true;
      return words.length > 0 && words.every((token) => name.includes(token) || name.split(" ").some((word) => word.startsWith(token) || token.startsWith(word)));
    });
    if (named.length === 1) chosen = named[0];
  }
  if (!chosen) {
    const bySize = rows.filter((row) => answerMatchesPresentation(message, row));
    if (bySize.length === 1) chosen = bySize[0];
  }
  if (!chosen) return null;

  const drop = new Set(pending.candidateIds);
  const cart = params.cart.filter((line) => line.productId == null || !drop.has(line.productId));
  cart.push(lineFor(chosen, qty, unit, variant, params.nextLineId));
  return { cart, pending: null };
}
