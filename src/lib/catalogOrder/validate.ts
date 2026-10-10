/**
 * Revisa la lectura del modelo. No vuelve a armar el pedido con regex:
 * solo acepta, recorta o devuelve al carrito anterior lo que no está respaldado.
 * El tamaño, el tipo y el sabor tienen que haber salido de la boca del cliente.
 */
import { familyRows } from "@/lib/catalogOrder/catalog";
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { compact, editDistance, fuzzyIncludes, fold, tokens } from "@/lib/catalogOrder/text";
import type { CartLine, CatalogRow, CatalogSnapshot, ModelOutput, SellUnit, Unmatched } from "@/lib/catalogOrder/types";

const FILLERS = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "y", "o", "con", "por", "para", "que", "me", "se", "al", "lo", "quiero",
  "dame", "tambien", "ademas", "mas", "porfa", "favor", "este", "eh", "oye",
  "si", "ok", "va", "bien", "asi", "gracias", "pedido", "kilo", "kilos", "kg",
  "gramo", "gramos", "pesos", "quiero", "manda", "mandas", "serian", "otra",
  "otro", "orden", "pieza", "piezas", "por", "favor",
]);

const QTY_WORDS = new Set(["mejor", "medio", "media", "kilo", "kilos", "kg", "cuarto", "gramos", "gramo", "pesos", "solo", "solamente", "son", "seria", "serian"]);

const SYN: Array<[RegExp, string]> = [
  [/\bcerdos?\b/g, "puerco"],
  [/\bjochos?\b/g, "dogo"],
  [/\bhot ?dogs?\b/g, "dogo"],
  [/\bdogs?\b/g, "dogo"],
];

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

function norm(text: string): string {
  let folded = fold(text);
  for (const [pattern, to] of SYN) folded = folded.replace(pattern, to);
  return folded;
}

function fz(text: string, token: string): boolean {
  if (fuzzyIncludes(text, token)) return true;
  const pin = compact(token);
  return pin.length >= 6 && tokens(text).some((word) => editDistance(compact(word), pin) <= 2);
}

function sizeSaid(text: string, size: string): boolean {
  if (new RegExp(`\\b${size}s?\\b`).test(text)) return true;
  const target = compact(size);
  return tokens(text).some((word) => {
    const got = compact(word);
    return got.length >= 4 && editDistance(got, target) <= 1;
  });
}

function mentionedVariants(text: string, row: CatalogRow): string[] {
  const folded = fold(text);
  return row.variants.filter((variant) => new RegExp(`\\b${fold(variant).slice(0, 4)}`).test(folded));
}

/** El texto nombra esta fila, no solo la familia. El tamaño y el marinado tienen que estar dichos. */
export function rowNamedBy(text: string, row: CatalogRow, catalog: CatalogSnapshot): boolean {
  const folded = norm(text);
  if (row.variants.length && (mentionedVariants(folded, row).length || /\brefresco/.test(folded))) return true;
  const aliasHit = row.alias.some((alias) => {
    if (!fuzzyIncludes(folded, alias) || fold(alias).length < 4) return false;
    if (familyRows(catalog, row.family).length !== 1) return false;
    return !catalog.rows.some((other) => other.id !== row.id && other.alias.some((item) => fold(item) === fold(alias)));
  });
  if (aliasHit) return true;

  const own = tokens(row.searchName).filter((token) => !/^(chica|grande|marinad[oa]|\d+g)$/.test(token));
  const peers = catalog.rows.filter((other) => {
    if (other.id === row.id) return false;
    const otherTokens = new Set(tokens(other.searchName));
    return own.some((token) => otherTokens.has(token));
  });
  const distinctive = own.filter((token) => !peers.length || !peers.every((other) => tokens(other.searchName).includes(token)));
  const plainWithMarinated = !/marinad/.test(fold(row.name)) && familyRows(catalog, row.family).some((other) => /marinad/.test(fold(other.name)));
  const need = plainWithMarinated ? own : distinctive.length ? distinctive : own;
  const named = need.every((token) => fz(folded, token));
  if (!named) return false;

  const siblings = familyRows(catalog, row.family);
  if (siblings.length > 1) {
    if (row.size && /^(chica|grande)$/.test(row.size) && !sizeSaid(folded, row.size)) return false;
    if (row.size && /^\d+$/.test(row.size) && !new RegExp(`\\b${row.size}\\b`).test(folded)) return false;
    const marinated = /marinad/.test(fold(row.name));
    if (siblings.some((other) => /marinad/.test(fold(other.name)) !== marinated) && marinated && !/marinad/.test(folded)) return false;
  }
  return true;
}

function specificity(text: string, row: CatalogRow): number {
  const folded = norm(text);
  return tokens(row.searchName).filter((token) => fz(folded, token)).length;
}

function lineFromRow(row: CatalogRow, text: string, catalog: CatalogSnapshot): CartLine {
  const parsed = parseQuantity(text, catalog.profile);
  let unit: SellUnit = row.unit === "kg" ? "kg" : "pz";
  let qty = parsed.qty > 0 ? parsed.qty : 1;
  if (parsed.unit === "pesos" && row.unit === "kg") {
    unit = "pesos";
    qty = parsed.qty;
  } else if (parsed.unit === "kg") unit = "kg";
  const flavors = mentionedVariants(text, row);
  return {
    productId: row.id,
    qty,
    unit,
    variant: flavors.length === 1 ? flavors[0] : null,
    notes: null,
  };
}

function matchingIds(text: string, catalog: CatalogSnapshot): number[] {
  const said = tokens(norm(text)).filter((token) => token.length >= 4);
  if (!said.length) return [];
  const scored = catalog.rows.map((row) => {
    const blob = norm(`${row.searchName} ${row.name} ${row.alias.join(" ")} ${row.family}`);
    const hit = said.filter((token) => blob.includes(token) || fz(blob, token)).length;
    return { id: row.id, hit };
  }).filter((item) => item.hit > 0);
  const max = scored.reduce((best, item) => Math.max(best, item.hit), 0);
  if (!max) return [];
  return scored.filter((item) => item.hit === max).map((item) => item.id);
}

function collapsePack(text: string, line: CartLine, row: CatalogRow): CartLine {
  if (!row.size || !/^\d+$/.test(row.size)) return line;
  const pieces = Number(row.size);
  if (!Number.isFinite(pieces) || pieces < 2 || Math.abs(line.qty - pieces) > 0.001) return line;
  const folded = fold(text);
  const saysPack = /\b(media\s+)?docena\b/.test(folded)
    || new RegExp(`\\b${pieces}\\s*piezas?\\b`).test(folded)
    || new RegExp(`\\bde\\s+${pieces}\\b`).test(folded);
  return saysPack ? { ...line, qty: 1 } : line;
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
  pendingText?: string;
}): ValidationOutcome {
  const { output, prior, message, catalog } = params;
  const pendingText = params.pendingText ?? "";
  const context = `${message} ${pendingText}`.trim();
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
        qty: line.qty,
        unit: line.unit,
      });
      return false;
    }
    if (line.variant && !row.variants.length) line.variant = null;
    return true;
  });

  function sourceFor(productId: number | null): string {
    const change = (output.changes ?? []).find((item) => item.product_id === productId && item.source_text);
    return change?.source_text || message;
  }

  proposed = proposed.map((line) => {
    const row = catalog.byId.get(line.productId);
    if (!row) return line;
    const src = `${sourceFor(line.productId)} ${message}`;
    const parsed = parseQuantity(sourceFor(line.productId), catalog.profile);
    const fromMessage = parseQuantity(message, catalog.profile);
    const pesos = parsed.unit === "pesos" ? parsed : fromMessage.unit === "pesos" ? fromMessage : null;
    let next = line;
    if (row.unit === "kg" && pesos && pesos.qty > 0 && line.unit !== "pesos") {
      next = { ...line, unit: "pesos", qty: pesos.qty };
    }
    return collapsePack(src, next, row);
  });

  for (const item of output.unmatched ?? []) {
    if (item.reason === "ambiguous" && item.candidate_ids.length) {
      const rows = item.candidate_ids.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
      const named = rows.filter((row) => rowNamedBy(message, row, catalog));
      const scored = named.map((row) => ({ row, score: specificity(message, row) }));
      const best = scored.reduce((max, itemScore) => Math.max(max, itemScore.score), 0);
      const winners = scored.filter((itemScore) => itemScore.score === best);
      const picked = named.length === 1 ? named[0] : winners.length === 1 ? winners[0].row : null;
      if (picked) {
        const flavors = mentionedVariants(`${message} ${item.source_text}`, picked);
        if (picked.variants.length && flavors.length !== 1) {
          unmatched.push({ ...item, qty: item.qty ?? parseQuantity(item.source_text || message, catalog.profile).qty });
          continue;
        }
        const built = lineFromRow(picked, item.source_text || message, catalog);
        if (flavors.length === 1) built.variant = flavors[0];
        forced.push(built);
        continue;
      }
    }
    unmatched.push(item);
  }

  function changeBacks(op: string, productId: number | null): boolean {
    return (output.changes ?? []).some((change) => change.op === op && (productId == null || change.product_id === productId || change.from_product_id === productId) && fuzzyIncludes(message, change.source_text));
  }

  function touches(productId: number): boolean {
    return (output.changes ?? []).some((change) => (change.product_id === productId || change.from_product_id === productId) && fuzzyIncludes(message, change.source_text));
  }

  const priorByKey = new Map(prior.map((line) => [key(line), line]));
  const nextByKey = new Map(proposed.map((line) => [key(line), line]));
  const kept: CartLine[] = [];
  let lumpedFlavors = false;
  const answerWithoutNumber = Boolean(pendingText) && !/\d/.test(message);
  const inherited = prior
    .map((item) => fold(catalog.byId.get(item.productId)?.searchName ?? ""))
    .map((name) => name.replace(/\b(chica|grande)\b/g, " ").replace(/\b\d+\s*piezas?\b/g, " "))
    .join(" ");
  const heard = `${context} ${inherited}`.trim();

  function messageHits(row: CatalogRow): boolean {
    if (row.variants.length && mentionedVariants(message, row).length) return true;
    const said = tokens(norm(message));
    return tokens(row.searchName)
      .filter((token) => !/^(chica|grande|marinad[oa]|\d+g)$/.test(token))
      .some((token) => said.includes(token) || fz(message, token));
  }

  for (const line of proposed) {
    const row = catalog.byId.get(line.productId);
    if (!row) continue;
    const prev = priorByKey.get(key(line));
    if (!prev) {
      const flavors = mentionedVariants(message, row);
      if (row.variants.length && flavors.length >= 2 && proposed.filter((item) => item.productId === row.id).length < flavors.length) {
        if (!lumpedFlavors) unmatched.push({ source_text: message, reason: "unclear", candidate_ids: [] });
        lumpedFlavors = true;
        continue;
      }
      if (row.variants.length && !line.variant && flavors.length === 1) line.variant = flavors[0];
      const named = rowNamedBy(heard, row, catalog);
      const backed = named || changeBacks("add", line.productId) || changeBacks("replace", line.productId) || changeBacks("set_variant", line.productId);
      if (backed && named && !(row.variants.length && !line.variant)) {
        kept.push(line);
        continue;
      }
      if (backed && row.variants.length && !line.variant) {
        unmatched.push({ source_text: sourceFor(line.productId), reason: "ambiguous", candidate_ids: [row.id], qty: line.qty, unit: line.unit });
        continue;
      }
      if (backed && !named) {
        const matches = matchingIds(message, catalog);
        const namedRows = matches
          .map((id) => catalog.byId.get(id))
          .filter((item): item is CatalogRow => Boolean(item && messageHits(item) && rowNamedBy(heard, item, catalog)));
        if (namedRows.length === 1 && !(namedRows[0].variants.length && mentionedVariants(message, namedRows[0]).length !== 1 && namedRows[0].variants.length > 0)) {
          const built = lineFromRow(namedRows[0], message, catalog);
          if (line.qty > 0 && built.unit === line.unit) built.qty = line.qty;
          kept.push(built);
          continue;
        }
        const familyIds = new Set(familyRows(catalog, row.family).map((item) => item.id));
        const inFamily = matches.filter((id) => familyIds.has(id));
        const pool = inFamily.length >= 2 ? inFamily : matches;
        if (!pool.length) {
          unmatched.push({ source_text: sourceFor(line.productId), reason: "not_on_menu", candidate_ids: [] });
          continue;
        }
        unmatched.push({
          source_text: sourceFor(line.productId),
          reason: "ambiguous",
          candidate_ids: pool.slice(0, 12),
          qty: line.qty,
          unit: line.unit,
        });
        continue;
      }
      unmatched.push({ source_text: row.name, reason: "unclear", candidate_ids: [line.productId] });
      continue;
    }
    if (Math.abs(prev.qty - line.qty) > 0.001) {
      const allowed = !answerWithoutNumber && (changeBacks("set_qty", line.productId) || touches(line.productId));
      kept.push(allowed ? line : prev);
    } else kept.push(line);
  }

  const partialFlavor = /\bcambia\b/.test(fold(message)) && /\b(una|uno|1)\b/.test(fold(message));
  for (const line of prior) {
    if (nextByKey.has(key(line))) continue;
    const incoming = proposed.find((item) => item.productId === line.productId && item.variant && item.variant !== line.variant);
    const removed = (output.changes ?? []).some((change) => {
      const backed = fuzzyIncludes(message, change.source_text);
      if (!backed) return false;
      if (change.op === "remove") return change.product_id === line.productId || change.from_product_id === line.productId;
      if (change.op === "replace" || change.op === "set_variant") return change.from_product_id === line.productId;
      return false;
    });
    if (partialFlavor && incoming && removed && line.qty > 1) {
      kept.push({ ...line, qty: line.qty - 1 });
      const added = kept.find((item) => item.productId === incoming.productId && item.variant === incoming.variant);
      if (added) added.qty = 1;
      continue;
    }
    if (!removed) kept.push(line);
  }

  if (/\bquita\b/.test(fold(message)) && /\b(una|uno|1)\b/.test(fold(message))) {
    const flavors = new Set<string>();
    for (const row of catalog.rows) {
      if (!row.variants.length || !messageHits(row)) continue;
      for (const variant of mentionedVariants(message, row)) flavors.add(fold(variant));
    }
    const hits = prior.filter((line) => {
      const row = catalog.byId.get(line.productId);
      if (!row || !messageHits(row)) return false;
      if (flavors.size === 1) return flavors.has(fold(line.variant ?? ""));
      return flavors.size === 0;
    });
    if (hits.length === 1 && hits[0].qty >= 2) {
      const target = hits[0];
      const index = kept.findIndex((line) => line.productId === target.productId && line.unit === target.unit && (line.variant ?? null) === (target.variant ?? null));
      const current = index >= 0 ? kept[index] : undefined;
      if (current && Math.abs(current.qty - target.qty) < 0.001) {
        kept[index] = { ...current, qty: target.qty - 1 };
      }
    }
  }

  const priorNames = prior.map((line) => catalog.byId.get(line.productId)?.name ?? "").join(" ");
  for (const change of output.changes ?? []) {
    if (change.op === "remove" || change.product_id == null) continue;
    if (kept.some((line) => line.productId === change.product_id)) continue;
    const row = catalog.byId.get(change.product_id);
    if (!row || !fuzzyIncludes(message, change.source_text)) continue;
    if (!rowNamedBy(`${message} ${priorNames} ${change.source_text}`, row, catalog)) continue;
    const built = lineFromRow(row, change.source_text || message, catalog);
    if (row.variants.length && !built.variant) continue;
    kept.push(built);
  }

  const qtyOnly = tokens(message).filter((token) => !QTY_WORDS.has(token)).length === 0;
  const measured = parseQuantity(message, catalog.profile);
  const current = kept[0];
  if (qtyOnly && prior.length === 1 && kept.length === 1 && current && (measured.unit === "kg" || measured.unit === "pesos" || /\b(medio|cuarto|kilo)\b/.test(fold(message)))) {
    const unit: SellUnit = measured.unit === "pesos" ? "pesos" : measured.unit === "kg" ? "kg" : current.unit;
    const updated = { ...current, qty: measured.qty > 0 ? measured.qty : current.qty, unit };
    kept[0] = updated;
    for (let index = unmatched.length - 1; index >= 0; index -= 1) {
      const item = unmatched[index];
      if (item?.reason === "ambiguous" && item.candidate_ids.includes(updated.productId)) unmatched.splice(index, 1);
    }
  }

  const covered = [...(output.changes ?? []).map((change) => change.source_text), ...unmatched.map((item) => item.source_text)];
  const messageTokens = tokens(message).filter((token) => !FILLERS.has(token) && !/^(chica|grande|kilo|medio)$/.test(token));
  const uncovered = messageTokens.filter((token) => !covered.some((source) => fuzzyIncludes(source, token) || fold(source).includes(token)));
  if (uncovered.length && output.confidence !== "high" && !lumpedFlavors) {
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
