import { foldAgent } from "@/lib/orderAgent/catalog";
import { asideNote, answerMatchesPresentation, lineMatchesQuery, variantFromMessage } from "@/lib/orderAgent/match";
import type { AgentLine, AgentPending, AgentProduct, AgentUnit } from "@/lib/orderAgent/types";

function asNumber(text: string): number | null {
  const match = foldAgent(text).match(/^(?:(?:la|el|del|opcion|numero|pues|es|de)\s+)?(\d+)$/);
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

function shownProductName(name: string, variant: string | null): string {
  if (!variant) return name;
  const base = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (foldAgent(base).includes(foldAgent(variant))) return base;
  return `${base} ${variant}`;
}

function lineFor(
  product: AgentProduct,
  qty: number,
  unit: AgentUnit,
  variant: string | null,
  lineId: string,
  note: string | null,
): AgentLine {
  return {
    lineId,
    productId: product.id,
    freeText: null,
    name: shownProductName(product.name, variant),
    qty,
    unit,
    variant,
    note,
    unitPrice: product.price,
    brand: product.brand,
    presentation: product.presentation,
  };
}

function lineIds(base: string, count: number): string[] {
  const match = /^l(\d+)$/.exec(base);
  const start = match ? Number(match[1]) : 1;
  return Array.from({ length: count }, (_, index) => `l${start + index}`);
}

const WORD_QTY: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
};

function explicitQty(text: string): number | null {
  const folded = foldAgent(text);
  const digit = folded.match(/\b(\d+)\b/);
  if (digit) {
    const value = Number(digit[1]);
    if (value > 0 && value <= 40) return value;
  }
  for (const [word, qty] of Object.entries(WORD_QTY)) {
    if (new RegExp(`\\b${word}\\b`).test(folded)) return qty;
  }
  return null;
}

function answerParts(message: string): string[] {
  return foldAgent(message)
    .split(/\s*(?:,|;|\by\b|\be\b|\btambien\b)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function optionIndexes(message: string, count: number): number[] | null {
  const text = foldAgent(message).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const rest = text.replace(/\b(?:el|la|los|las|opcion|numero|y|e|tambien|\d+)\b/g, " ").trim();
  if (rest) return null;
  const nums = [...text.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  if (nums.length < 2) return null;
  if (nums.some((value) => !Number.isInteger(value) || value < 1 || value > count)) return null;
  return nums;
}

/**
 * Resuelve «grande», «2», «normal», «Pepsi» contra las opciones de la pregunta.
 * Varias opciones en la misma respuesta son varias líneas, cada una con su cantidad.
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
  const fallbackQty = pending.qty && pending.qty > 0 ? pending.qty : 1;
  const unit: AgentUnit = pending.unit ?? (rows[0].unit === "kg" ? "kg" : "pz");
  const note = asideNote(pending.query ?? "");
  const indexes = optionIndexes(message, rows.length);
  if (indexes) {
    const ids = lineIds(params.nextLineId, indexes.length);
    const chosenIds = new Set(indexes.map((number) => rows[number - 1]?.id).filter((id): id is number => id != null));
    const cart = params.cart.filter((line) => line.productId == null || !chosenIds.has(line.productId) || line.variant);
    indexes.forEach((number, index) => {
      const product = rows[number - 1];
      if (!product) return;
      cart.push(lineFor(product, 1, unit, null, ids[index] ?? params.nextLineId, note));
    });
    return { cart, pending: null };
  }

  const drink = rows.find((row) => row.variants.length);
  if (drink) {
    const parts = answerParts(message);
    const picks = parts
      .map((part) => ({ flavor: variantFromMessage(drink.variants, part), qty: explicitQty(part) }))
      .filter((pick): pick is { flavor: string; qty: number | null } => Boolean(pick.flavor));
    if (picks.length >= 2) {
      const anyQty = picks.some((pick) => pick.qty != null);
      if (!anyQty && pending.qty && pending.qty !== picks.length) return null;
      const qtys = picks.map((pick) => pick.qty ?? 1);
      const ids = lineIds(params.nextLineId, picks.length);
      const cart = params.cart.filter((line) => {
        if (line.productId !== drink.id) return true;
        if (!line.variant) return false;
        return !picks.some((pick) => foldAgent(line.variant ?? "") === foldAgent(pick.flavor));
      });
      picks.forEach((pick, index) => {
        cart.push(lineFor(drink, qtys[index] ?? 1, "pz", pick.flavor, ids[index] ?? params.nextLineId, note));
      });
      return { cart, pending: null };
    }
    if (picks.length === 1 && parts.length > 1) return null;
  }

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

  if (!chosen && drink) {
    const flavor = variantFromMessage(drink.variants, message);
    if (flavor) {
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

  const qty = number != null ? fallbackQty : (explicitQty(message) ?? fallbackQty);
  const query = pending.query ?? "";
  const cart = params.cart.filter((line) => {
    if (line.productId == null || !pending.candidateIds.includes(line.productId)) return true;
    if (variant) {
      if (line.productId !== chosen?.id) return true;
      if (!line.variant) return false;
      return foldAgent(line.variant) !== foldAgent(variant);
    }
    if (!query) return false;
    return !lineMatchesQuery(line.name, query);
  });
  cart.push(lineFor(chosen, qty, variant ? "pz" : unit, variant, params.nextLineId, note));
  return { cart, pending: null };
}
