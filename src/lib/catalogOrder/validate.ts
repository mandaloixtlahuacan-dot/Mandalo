/**
 * Revisa la lectura del modelo. No vuelve a armar el pedido con regex:
 * solo acepta, recorta o devuelve al carrito anterior lo que no está respaldado.
 */
import { familyRows } from "@/lib/catalogOrder/catalog";
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { fuzzyIncludes, fold, tokens } from "@/lib/catalogOrder/text";
import type { CartLine, CatalogSnapshot, ModelOutput, SellUnit, Unmatched } from "@/lib/catalogOrder/types";

const FILLERS = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "y", "o", "con", "por", "para", "que", "me", "se", "al", "lo", "quiero",
  "dame", "tambien", "ademas", "mas", "porfa", "favor", "este", "eh", "oye",
  "si", "ok", "va", "bien", "asi", "gracias", "pedido", "kilo", "kilos", "kg",
  "gramo", "gramos", "pesos", "quiero", "manda", "mandas", "serian", "otra",
  "otro", "orden", "pieza", "piezas", "por", "favor",
]);

function key(line: { productId?: number; product_id?: number; unit: string; variant: string | null }): string {
  const id = "productId" in line && line.productId ? line.productId : line.product_id;
  return `${id}|${line.unit}|${line.variant ?? ""}`;
}

function asCart(lines: ModelOutput["cart"]): CartLine[] {
  return lines.map((line) => ({
    productId: line.product_id,
    qty: line.qty,
    unit: line.unit,
    variant: line.variant,
    notes: line.notes,
  }));
}

function saneQty(unit: SellUnit, qty: number): boolean {
  if (!Number.isFinite(qty) || qty <= 0) return false;
  if (unit === "pz") return qty <= 200;
  if (unit === "kg") return qty <= 50;
  return qty <= 5000;
}

function fractionGuard(message: string, line: CartLine, catalog: CatalogSnapshot): CartLine {
  const row = catalog.byId.get(line.productId);
  if (!row || row.unit !== "kg") return line;
  const text = fold(message);
  const fraction = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  const word = /\b(un |una )?cuarto\b/.test(text);
  const slash = text.includes("1/4") || text.includes("¼");
  if ((fraction && Number(fraction[1]) === 1 && Number(fraction[2]) === 4) || word || slash) {
    if (line.qty === 4 || line.unit === "pz") return { ...line, qty: 0.25, unit: "kg" };
  }
  if (/\b3\s*\/\s*4\b|¾/.test(text) && (line.qty === 4 || line.qty === 3)) return { ...line, qty: 0.75, unit: "kg" };
  return line;
}

export type ValidationOutcome = {
  cart: CartLine[];
  unmatched: Unmatched[];
  intent: ModelOutput["intent"];
};

export function validateModelOutput(params: {
  output: ModelOutput;
  prior: CartLine[];
  message: string;
  catalog: CatalogSnapshot;
}): ValidationOutcome {
  const { output, prior, message, catalog } = params;
  const unmatched: Unmatched[] = [];
  const forced: CartLine[] = [];

  let proposed = asCart(output.cart).map((line) => fractionGuard(message, line, catalog));
  proposed = proposed.filter((line) => {
    const row = catalog.byId.get(line.productId);
    if (!row || !row.disponible) return false;
    if (!saneQty(line.unit, line.qty)) return false;
    if (line.unit === "kg" && row.unit === "pz") return false;
    if (line.unit === "pesos" && row.unit !== "kg") return false;
    if (line.variant && row.variants.length && !row.variants.some((variant) => fold(variant) === fold(line.variant ?? ""))) {
      unmatched.push({
        source_text: line.variant,
        reason: "ambiguous",
        candidate_ids: [row.id],
      });
      return false;
    }
    if (line.variant && !row.variants.length) line.variant = null;
    return true;
  });

  for (const item of output.unmatched ?? []) {
    if (item.reason === "ambiguous" && item.candidate_ids.length === 1) {
      const row = catalog.byId.get(item.candidate_ids[0]);
      const siblings = row ? familyRows(catalog, row.family) : [];
      const needsSize = siblings.length > 1 && !row?.size;
      const needsFlavor = Boolean(row && row.variants.length);
      if (row && !needsSize && !needsFlavor) {
        const qty = parseQuantity(message, catalog.profile);
        forced.push({
          productId: row.id,
          qty: qty.qty || 1,
          unit: qty.unit === "pesos" ? "pesos" : row.unit,
          variant: null,
          notes: null,
        });
        continue;
      }
    }
    if (item.reason === "ambiguous" && item.candidate_ids.length > 1) {
      const rows = item.candidate_ids.map((id) => catalog.byId.get(id)).filter((row) => row);
      const families = [...new Set(rows.map((row) => row!.family))];
      if (families.length === 1 && familyRows(catalog, families[0]).length === 1) {
        const only = familyRows(catalog, families[0])[0];
        const qty = parseQuantity(message, catalog.profile);
        forced.push({
          productId: only.id,
          qty: qty.qty || 1,
          unit: qty.unit === "pesos" ? "pesos" : only.unit,
          variant: null,
          notes: null,
        });
        continue;
      }
    }
    unmatched.push(item);
  }

  function changeBacks(op: string, productId: number | null): boolean {
    return (output.changes ?? []).some((change) => change.op === op && (productId == null || change.product_id === productId || change.from_product_id === productId) && fuzzyIncludes(message, change.source_text));
  }

  const priorByKey = new Map(prior.map((line) => [key(line), line]));
  const nextByKey = new Map(proposed.map((line) => [key(line), line]));
  const kept: CartLine[] = [];

  for (const line of proposed) {
    const prev = priorByKey.get(key(line));
    if (!prev) {
      if (changeBacks("add", line.productId) || changeBacks("replace", line.productId)) kept.push(line);
      else unmatched.push({ source_text: catalog.byId.get(line.productId)?.name ?? String(line.productId), reason: "unclear", candidate_ids: [line.productId] });
    } else if (Math.abs(prev.qty - line.qty) > 0.001) {
      kept.push(changeBacks("set_qty", line.productId) ? line : prev);
    } else kept.push(line);
  }

  for (const line of prior) {
    if (nextByKey.has(key(line))) continue;
    const removed = output.changes?.some((change) => change.op === "remove" && (change.product_id === line.productId || change.from_product_id === line.productId) && fuzzyIncludes(message, change.source_text));
    if (!removed) kept.push(line);
  }

  const covered = [...(output.changes ?? []).map((change) => change.source_text), ...unmatched.map((item) => item.source_text)];
  const messageTokens = tokens(message).filter((token) => !FILLERS.has(token) && !/^(chica|grande|kilo|medio)$/.test(token));
  const uncovered = messageTokens.filter((token) => !covered.some((source) => fuzzyIncludes(source, token) || fold(source).includes(token)));
  if (uncovered.length && output.confidence !== "high") {
    unmatched.push({ source_text: uncovered.join(" "), reason: "unclear", candidate_ids: [] });
  }

  const dedup = new Map<string, CartLine>();
  for (const line of [...kept, ...forced]) {
    const id = key(line);
    const prev = dedup.get(id);
    if (!prev) dedup.set(id, line);
    else dedup.set(id, { ...prev, qty: Math.max(prev.qty, line.qty) });
  }

  return { cart: [...dedup.values()], unmatched, intent: output.intent };
}
