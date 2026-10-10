/**
 * Chequeo del carrito que devolvió el modelo.
 * Acepta línea por línea. Conserva lo que el cliente no quitó.
 * Una línea mala no borra las demás.
 */
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { compact, editDistance, fold, tokens } from "@/lib/catalogOrder/text";
import type {
  AiOutput,
  CartLine,
  CatalogRow,
  CatalogSnapshot,
  PendingCatalogAsk,
  SellUnit,
} from "@/lib/catalogOrder/types";

export type AcceptedQuestion = {
  text: string;
  candidateIds: number[];
  qty: number | null;
  unit: SellUnit | null;
  sourceText: string | null;
};

export type CheckResult = {
  cart: CartLine[];
  errors: string[];
  question: AcceptedQuestion | null;
  notOnMenu: string[];
};

export type CheckContext = {
  prior?: CartLine[];
  message?: string;
  pending?: PendingCatalogAsk | null;
};

const SIZE_WORDS = new Set(["chica", "chicas", "chico", "grande", "grandes", "pieza", "piezas"]);

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, veinte: 20, treinta: 30,
};

export function pesosToKg(amount: number, precio: number): number {
  return Math.round((amount / precio) * 100) / 100;
}

function stem(token: string): string {
  const folded = fold(token);
  const noPlural = folded.endsWith("s") && folded.length > 4 ? folded.slice(0, -1) : folded;
  return noPlural.length > 4 && /[ao]$/.test(noPlural) ? noPlural.slice(0, -1) : noPlural;
}

function contentTokens(text: string): string[] {
  return tokens(text).filter((token) => !SIZE_WORDS.has(token) && NUMBER_WORDS[token] == null && !/^\d+$/.test(token));
}

function rowHitsToken(row: CatalogRow, token: string): boolean {
  const key = stem(token);
  if (key.length < 3) return false;
  const bag = [row.searchName, row.name, ...row.alias, ...row.variants];
  return bag.some((value) => tokens(value).some((item) => stem(item) === key));
}

function mentioned(row: CatalogRow, message: string): boolean {
  return contentTokens(message).some((token) => rowHitsToken(row, token));
}

function asUnit(value: unknown): SellUnit | null {
  return value === "pz" || value === "kg" || value === "pesos" ? value : null;
}

function allowedUnit(rowUnit: "pz" | "kg", unit: string): unit is SellUnit {
  if (rowUnit === "kg") return unit === "kg" || unit === "pesos";
  return unit === "pz";
}

function namesRemoval(message: string): boolean {
  return /\b(quita(r|me|le|la|lo|las|los)?|elimina(r|me)?|borra(r|me)?|ya no|nada de|no quiero|sin la|sin el)\b/.test(fold(message));
}

function isReplace(message: string): boolean {
  const text = fold(message);
  return /\b(cambia(r|lo|la|le|los|las)?|no es|en vez|en lugar)\b/.test(text) || /\bmejor\b.{0,40}\b(sean|sea)\b/.test(text);
}

function explicitQty(text: string, profile: CatalogSnapshot["profile"]): number | null {
  const folded = fold(text);
  if (/\b(kilo|kilos|kg|pesos|\$|medio|cuarto)\b/.test(folded)) {
    const parsed = parseQuantity(text, profile);
    if (parsed.qty > 0 && (parsed.unit === "kg" || parsed.unit === "pesos" || /\bmedio\b|\bcuarto\b/.test(folded))) return parsed.qty;
  }
  const digit = folded.match(/\b(\d+(?:\.\d+)?)\b/);
  if (digit) return Number(digit[1]);
  const words = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length);
  for (const word of words) {
    if (new RegExp(`\\b${word}\\b`).test(folded)) return NUMBER_WORDS[word];
  }
  return null;
}

function pieceSizeOf(row: CatalogRow): number | null {
  if (row.size && /^\d+$/.test(row.size)) return Number(row.size);
  const match = fold(row.name).match(/\b(\d+)\s*piezas?\b/);
  return match ? Number(match[1]) : null;
}

function sizeWord(row: CatalogRow): "chica" | "grande" | null {
  return row.size === "chica" || row.size === "grande" ? row.size : null;
}

function siblingWithSize(catalog: CatalogSnapshot, row: CatalogRow, size: "chica" | "grande"): CatalogRow | null {
  const base = tokens(row.searchName).filter((token) => token !== "chica" && token !== "grande").join(" ");
  const hits = catalog.rows.filter((candidate) => {
    if (sizeWord(candidate) !== size) return false;
    const other = tokens(candidate.searchName).filter((token) => token !== "chica" && token !== "grande").join(" ");
    return other === base;
  });
  return hits.length === 1 ? hits[0] : null;
}

function closeName(left: string, right: string): boolean {
  const a = fold(left);
  const b = fold(right);
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  if (a === b) return true;
  const ca = compact(a);
  const cb = compact(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const dist = editDistance(ca, cb);
  const min = Math.min(ca.length, cb.length);
  if (min >= 6 && dist <= 2) return true;
  if (min >= 4 && dist <= 1) return true;
  return false;
}

function lineOf(row: CatalogRow, qty: number, unit: SellUnit, variant: string | null): CartLine {
  return { productId: row.id, qty, unit, variant, notes: null };
}

function sameLine(left: CartLine, right: CartLine): boolean {
  return left.productId === right.productId && left.unit === right.unit && (left.variant ?? null) === (right.variant ?? null);
}

function rowsMatchingWord(catalog: CatalogSnapshot, word: string): CatalogRow[] {
  const key = stem(word);
  if (key.length < 4) return [];
  return catalog.rows.filter((row) => tokens(row.searchName).some((token) => stem(token) === key) || row.variants.some((variant) => stem(variant) === key));
}

function narrowCandidates(rows: CatalogRow[], source: string): CatalogRow[] {
  const distinctive = contentTokens(source).filter((token) => rows.some((row) => rowHitsToken(row, token)));
  if (!distinctive.length) return rows;
  const subset = rows.filter((row) => distinctive.every((token) => rowHitsToken(row, token)));
  return subset.length ? subset : rows;
}

function bestRow(clause: string, rows: CatalogRow[]): CatalogRow | null {
  const wantsGrande = /\bgrandes?\b/.test(fold(clause));
  const wantsChica = /\bchicas?\b/.test(fold(clause));
  if (wantsGrande && wantsChica) return null;
  let pool = rows;
  if (wantsGrande) pool = rows.filter((row) => row.size === "grande");
  if (wantsChica) pool = rows.filter((row) => row.size === "chica");
  const content = contentTokens(clause);
  if (!content.length) return pool.length === 1 ? pool[0] : null;
  const full = pool.filter((row) => content.every((token) => rowHitsToken(row, token)));
  if (!full.length) return null;
  if (full.length === 1) return full[0];
  if (!content.some((token) => stem(token) === "marinad")) {
    const plain = full.filter((row) => !/marinad/.test(fold(row.name)));
    if (plain.length === 1) return plain[0];
  }
  return null;
}

function splitClauses(message: string): string[] {
  const text = fold(message);
  const parts = text.split(/\s+y\s+|\s*,\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [text];
}

function variantFromClause(row: CatalogRow, clause: string): string | null {
  return row.variants.find((variant) => contentTokens(clause).some((token) => stem(token) === stem(variant))) ?? null;
}

function otherRow(catalog: CatalogSnapshot, clause: string, candidates: CatalogRow[]): { row: CatalogRow; variant: string | null } | null {
  const hits = catalog.rows.filter((row) => !candidates.some((candidate) => candidate.id === row.id) && mentioned(row, clause));
  if (hits.length !== 1) return null;
  const row = hits[0];
  if (row.variants.length) {
    const variant = variantFromClause(row, clause);
    if (!variant) return null;
    return { row, variant };
  }
  return { row, variant: null };
}

function selectFromPending(message: string, pending: PendingCatalogAsk, catalog: CatalogSnapshot): CartLine[] | null {
  const rows = pending.candidateIds.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  if (!rows.length) return null;
  const narrowed = narrowCandidates(rows, pending.sourceText);
  if (narrowed.length === 1 && narrowed[0].variants.length) {
    const variant = variantFromClause(narrowed[0], message);
    if (!variant) return null;
    const qty = explicitQty(message, catalog.profile) ?? pending.qty;
    const unit = pending.unit || narrowed[0].unit;
    return [lineOf(narrowed[0], qty > 0 ? qty : 1, unit, variant)];
  }
  const whole = bestRow(message, narrowed);
  const clauses = splitClauses(message);
  if (whole) {
    const qty = explicitQty(message, catalog.profile) ?? pending.qty;
    const parsed = parseQuantity(message, catalog.profile);
    const unit = parsed.unit === "kg" || parsed.unit === "pesos" ? parsed.unit : pending.unit || whole.unit;
    return [lineOf(whole, qty > 0 ? qty : 1, unit, null)];
  }
  const lines: CartLine[] = [];
  let matched = 0;
  for (const clause of clauses) {
    const chosen = bestRow(clause, narrowed);
    if (chosen) {
      const qty = explicitQty(clause, catalog.profile) ?? (clauses.length === 1 ? pending.qty : 1);
      const parsed = parseQuantity(clause, catalog.profile);
      const unit = parsed.unit === "kg" || parsed.unit === "pesos" ? parsed.unit : pending.unit || chosen.unit;
      lines.push(lineOf(chosen, qty > 0 ? qty : 1, unit, null));
      matched += 1;
      continue;
    }
    const extra = otherRow(catalog, clause, rows);
    if (extra) {
      const qty = explicitQty(clause, catalog.profile) ?? 1;
      lines.push(lineOf(extra.row, qty > 0 ? qty : 1, extra.row.unit, extra.variant));
      matched += 1;
      continue;
    }
    return null;
  }
  return matched ? lines : null;
}

function packGroups(catalog: CatalogSnapshot): Map<string, CatalogRow[]> {
  const groups = new Map<string, CatalogRow[]>();
  for (const row of catalog.rows) {
    if (pieceSizeOf(row) == null) continue;
    const list = groups.get(row.family) ?? [];
    list.push(row);
    groups.set(row.family, list);
  }
  return groups;
}

function numbersIn(text: string): number[] {
  const folded = fold(text);
  const found: number[] = [];
  for (const match of folded.matchAll(/\b\d+(?:\.\d+)?\b/g)) found.push(Number(match[0]));
  if (/\bmedia docena\b/.test(folded)) found.push(6);
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(folded)) found.push(value);
  }
  return found;
}

function explicitPiece(text: string): number | null {
  const folded = fold(text);
  if (/\bmedia docena\b/.test(folded)) return 6;
  const match = folded.match(/\b(?:de|sean|sea)\s+(\d+|cinco|seis|diez|doce|quince|veinte|treinta)\b/);
  if (!match) return null;
  return NUMBER_WORDS[match[1]] ?? Number(match[1]);
}

function familyMentioned(group: CatalogRow[], message: string): boolean {
  return group.some((row) => mentioned(row, message));
}

function interpretPack(message: string, group: CatalogRow[]): { size: number | null; orders: number | null; missing: boolean } {
  const sizes = new Set(group.map((row) => pieceSizeOf(row)).filter((size): size is number => size != null));
  const nums = [...new Set(numbersIn(message))];
  const spoken = explicitPiece(message);
  const sizeHits = nums.filter((value) => sizes.has(value));
  const orderHits = nums.filter((value) => !sizes.has(value) && Number.isInteger(value) && value > 0);
  let size: number | null = spoken ?? (sizeHits.length === 1 ? sizeHits[0] : null);
  const missing = size != null && !sizes.has(size);
  let orders: number | null = null;
  if (orderHits.length === 1) orders = orderHits[0];
  else if (size != null && sizes.has(size)) orders = 1;
  else if (size == null && orderHits.length === 1 && group.length === 1) orders = orderHits[0];
  if (size != null && sizes.has(size) && orders == null) orders = 1;
  return { size, orders, missing };
}

function applyPacks(
  cart: CartLine[],
  prior: CartLine[],
  catalog: CatalogSnapshot,
  message: string,
): { cart: CartLine[]; question: AcceptedQuestion | null } {
  let question: AcceptedQuestion | null = null;
  const groups = packGroups(catalog);
  const phrase = explicitPiece(message);
  const presentFamilies = [...groups.values()].filter((group) => {
    const ids = new Set(group.map((row) => row.id));
    return cart.some((line) => ids.has(line.productId)) || prior.some((line) => ids.has(line.productId));
  });
  for (const group of groups.values()) {
    const ids = new Set(group.map((row) => row.id));
    const mentionedFamily = familyMentioned(group, message);
    const implied = !mentionedFamily && phrase != null && presentFamilies.length === 1 && presentFamilies[0] === group;
    if (!mentionedFamily && !implied) continue;
    const clause = splitClauses(message).find((part) => familyMentioned(group, part)) ?? message;
    const reading = interpretPack(clause === message && phrase != null ? message : clause, group);
    if (reading.missing && reading.size != null) {
      cart = cart.filter((line) => !ids.has(line.productId) || prior.some((item) => item.productId === line.productId));
      const sizes = group.map((row) => pieceSizeOf(row)).filter((size): size is number => size != null).sort((a, b) => a - b);
      question = {
        text: `¿De cuántas piezas? Hay de ${sizes.join(", ")}.`,
        candidateIds: group.map((row) => row.id),
        qty: 1,
        unit: "pz",
        sourceText: message,
      };
      continue;
    }
    if (group.length > 1 && reading.size == null) {
      const guessed = cart.filter((line) => ids.has(line.productId) && !prior.some((item) => item.productId === line.productId));
      if (guessed.length) {
        cart = cart.filter((line) => !guessed.includes(line));
        const sizes = group.map((row) => pieceSizeOf(row)).filter((size): size is number => size != null).sort((a, b) => a - b);
        question = {
          text: `¿De cuántas piezas? Hay de ${sizes.join(", ")}.`,
          candidateIds: group.map((row) => row.id),
          qty: explicitQty(message, catalog.profile) ?? 1,
          unit: "pz",
          sourceText: message,
        };
      }
      continue;
    }
    if (reading.size == null || reading.orders == null) continue;
    const target = group.find((row) => pieceSizeOf(row) === reading.size);
    if (!target || !Number.isInteger(reading.orders) || reading.orders < 1) continue;
    cart = cart.filter((line) => !ids.has(line.productId));
    cart.push(lineOf(target, reading.orders, "pz", null));
  }
  return { cart, question };
}

function closestVariant(row: CatalogRow, term: string): string | null {
  let best: { name: string; dist: number } | null = null;
  for (const variant of row.variants) {
    if (!closeName(term, variant) && stem(term) !== stem(variant)) continue;
    const dist = editDistance(compact(term), compact(variant));
    if (!best || dist < best.dist) best = { name: variant, dist };
  }
  return best?.name ?? null;
}

function menuRescue(catalog: CatalogSnapshot, term: string, message: string): { row: CatalogRow; variant: string | null } | null {
  const hits: Array<{ row: CatalogRow; variant: string | null }> = [];
  for (const row of catalog.rows) {
    const names = [row.name, row.searchName, ...row.alias];
    const nameHit = names.some((name) => closeName(term, name));
    const variant = row.variants.find((item) => closeName(term, item)) ?? null;
    if (!nameHit && !variant) continue;
    hits.push({ row, variant });
  }
  const ids = new Set(hits.map((hit) => hit.row.id));
  if (ids.size !== 1) return null;
  const row = hits[0].row;
  const variant = hits.find((hit) => hit.variant)?.variant ?? null;
  if (row.variants.length) {
    const chosen = variant ?? variantFromClause(row, term) ?? variantFromClause(row, message) ?? closestVariant(row, term);
    if (!chosen) return null;
    return { row, variant: chosen };
  }
  return { row, variant: null };
}

function conflicts(row: CatalogRow, message: string, candidates: CatalogRow[]): boolean {
  return contentTokens(message).some((token) => rowHitsToken(row, token) && candidates.some((candidate) => candidate.id !== row.id && rowHitsToken(candidate, token)));
}

function questionRelates(question: AcceptedQuestion, catalog: CatalogSnapshot, message: string): boolean {
  const rows = question.candidateIds.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  if (!rows.length) return false;
  return rows.some((row) => mentioned(row, message) || contentTokens(row.family).some((token) => token.length >= 4 && fold(message).includes(token)));
}

function fromModelQuestion(output: AiOutput, catalog: CatalogSnapshot): AcceptedQuestion | null {
  const question = output.question;
  if (!question?.text.trim()) return null;
  const ids = question.candidate_ids.map((id) => Number(id)).filter((id) => catalog.byId.has(id));
  if (!ids.length) return null;
  return {
    text: question.text.trim(),
    candidateIds: ids,
    qty: question.qty != null && Number.isFinite(question.qty) ? question.qty : null,
    unit: asUnit(question.unit),
    sourceText: question.source_text?.trim() ? question.source_text.trim() : null,
  };
}

function remapVariant(line: CartLine, row: CatalogRow, catalog: CatalogSnapshot): { line: CartLine | null; question: AcceptedQuestion | null; error: string | null } {
  const word = line.variant?.trim() ?? "";
  if (!word) {
    if (!row.variants.length) return { line: { ...line, variant: null }, question: null, error: null };
    return {
      line: null,
      error: null,
      question: {
        text: `¿Cuál sabor: ${row.variants.join(", ")}?`,
        candidateIds: [row.id],
        qty: line.qty,
        unit: line.unit,
        sourceText: null,
      },
    };
  }
  if (row.variants.length) {
    const match = row.variants.find((variant) => fold(variant) === fold(word) || stem(variant) === stem(word));
    if (match) return { line: { ...line, variant: match }, question: null, error: null };
  } else if (/^(grande|chica)$/.test(fold(word))) {
    const size = fold(word) as "chica" | "grande";
    if (row.size === size) return { line: { ...line, variant: null }, question: null, error: null };
    const sibling = siblingWithSize(catalog, row, size);
    if (sibling) return { line: lineOf(sibling, line.qty, "pz", null), question: null, error: null };
  }
  const hits = rowsMatchingWord(catalog, word).filter((hit) => hit.id !== row.id);
  const shared = hits.filter((hit) => tokens(hit.searchName).some((token) => token.length >= 4 && tokens(row.searchName).includes(token)));
  const pool = shared.length ? shared : hits;
  if (pool.length === 1) {
    const target = pool[0];
    const variant = target.variants.find((variant) => stem(variant) === stem(word)) ?? null;
    if (target.variants.length && !variant) {
      return {
        line: null,
        error: null,
        question: {
          text: `¿Cuál sabor: ${target.variants.join(", ")}?`,
          candidateIds: [target.id],
          qty: line.qty,
          unit: target.unit,
          sourceText: word,
        },
      };
    }
    return { line: lineOf(target, line.qty, target.unit === "kg" ? (line.unit === "pesos" ? "pesos" : "kg") : "pz", variant), question: null, error: null };
  }
  if (pool.length > 1) {
    return {
      line: null,
      error: null,
      question: {
        text: `¿Cuál ${word}?`,
        candidateIds: pool.map((item) => item.id),
        qty: line.qty,
        unit: line.unit,
        sourceText: word,
      },
    };
  }
  return { line: null, question: null, error: `${row.name} no tiene «${word}» en el menú` };
}

function applyOtra(cart: CartLine[], prior: CartLine[], catalog: CatalogSnapshot, message: string): { cart: CartLine[]; question: AcceptedQuestion | null } {
  const text = fold(message);
  const of = text.match(/\botr[oa]s?\s+de\s+(.+)$/);
  if (of) {
    const hits = catalog.rows.filter((row) => mentioned(row, of[1]));
    const family = hits.length ? hits[0].family : "";
    const sameFamily = hits.length > 1 && hits.every((row) => row.family === family);
    let target = hits.length === 1 ? hits[0] : null;
    if (!target && sameFamily) {
      const previous = prior.map((line) => catalog.byId.get(line.productId)).find((row) => row && row.family === family);
      target = previous ?? null;
    }
    if (!target) {
      if (hits.length > 1) {
        return {
          cart,
          question: {
            text: `¿Cuál de estos?`,
            candidateIds: hits.map((row) => row.id),
            qty: 1,
            unit: hits[0].unit,
            sourceText: message,
          },
        };
      }
      return { cart, question: null };
    }
    const priorQty = prior.filter((line) => line.productId === target.id).reduce((sum, line) => sum + line.qty, 0);
    cart = cart.map((line) => {
      if (line.productId === target.id) return line;
      const previous = prior.find((item) => sameLine(item, line));
      return previous && line.qty > previous.qty ? { ...line, qty: previous.qty } : line;
    });
    const current = cart.find((line) => line.productId === target.id);
    if (current) current.qty = priorQty + 1;
    else cart.push(lineOf(target, priorQty + 1, target.unit, null));
    return { cart, question: null };
  }
  if (/^(otr[oa]|una mas|otro igual|una igual)$/.test(text.trim())) {
    const last = prior[prior.length - 1];
    if (!last) return { cart, question: null };
    const found = cart.find((line) => sameLine(line, last));
    if (found) found.qty = Math.max(found.qty, last.qty + 1);
    else cart.push({ ...last, qty: last.qty + 1 });
  }
  return { cart, question: null };
}

function preserveCorrection(cart: CartLine[], prior: CartLine[], catalog: CatalogSnapshot, message: string): CartLine[] {
  if (/\b(chicas?|grandes?)\b/.test(fold(message)) && !/\bno es\b/.test(fold(message))) return cart;
  if (!isReplace(message)) return cart;
  const dropped = prior.filter((line) => !cart.some((item) => item.productId === line.productId));
  const added = cart.filter((line) => !prior.some((item) => item.productId === line.productId));
  if (dropped.length !== 1 || added.length !== 1) return cart;
  const oldRow = catalog.byId.get(dropped[0].productId);
  const newRow = catalog.byId.get(added[0].productId);
  if (!oldRow || !newRow) return cart;
  const spokenQty = explicitQty(message, catalog.profile);
  let nextId = newRow.id;
  const oldSize = sizeWord(oldRow);
  if (oldSize && sizeWord(newRow) && sizeWord(newRow) !== oldSize && !/\b(chicas?|grandes?)\b/.test(fold(message))) {
    const sibling = siblingWithSize(catalog, newRow, oldSize);
    if (sibling) nextId = sibling.id;
  }
  return cart.map((line) => {
    if (line.productId !== added[0].productId) return line;
    return { ...line, productId: nextId, qty: spokenQty == null ? dropped[0].qty : line.qty };
  });
}

function familySwapped(prev: CartLine, cart: CartLine[], catalog: CatalogSnapshot, message: string): boolean {
  const row = catalog.byId.get(prev.productId);
  if (!row) return false;
  const swapped = cart.some((line) => {
    const other = catalog.byId.get(line.productId);
    return Boolean(other && other.id !== row.id && other.family === row.family);
  });
  if (!swapped) return false;
  return mentioned(row, message) || explicitPiece(message) != null;
}

function canDrop(prev: CartLine, cart: CartLine[], prior: CartLine[], catalog: CatalogSnapshot, message: string, pending: PendingCatalogAsk | null, answered: boolean): boolean {
  if (answered && pending?.candidateIds.includes(prev.productId)) return true;
  const row = catalog.byId.get(prev.productId);
  const named = row ? mentioned(row, message) : false;
  if (named && (namesRemoval(message) || isReplace(message))) return true;
  if (familySwapped(prev, cart, catalog, message)) return true;
  const missing = prior.filter((line) => !cart.some((item) => item.productId === line.productId));
  return missing.length === 1 && missing[0].productId === prev.productId && isReplace(message);
}

function eachOption(message: string, pending: PendingCatalogAsk | null, prior: CartLine[], catalog: CatalogSnapshot): CartLine[] | null {
  if (!pending || pending.candidateIds.length < 2 || pending.candidateIds.length > 8) return null;
  if (!/\b(una de cada una|uno de cada uno|de cada una|de cada uno|una y una|uno y uno)\b/.test(fold(message))) return null;
  const rows = pending.candidateIds.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  if (!rows.length || rows.some((row) => row.variants.length > 0)) return null;
  const kept = prior.filter((line) => !pending.candidateIds.includes(line.productId)).map((line) => ({ ...line }));
  return [...kept, ...rows.map((row) => lineOf(row, 1, row.unit, null))];
}

export function checkAiOutput(output: AiOutput, catalog: CatalogSnapshot, context: CheckContext = {}): CheckResult {
  const prior = context.prior ?? [];
  const message = context.message ?? "";
  const pending = context.pending ?? null;
  const errors: string[] = [];
  let cart: CartLine[] = [];
  let question = fromModelQuestion(output, catalog);
  let rejectedQuestion = false;
  if (output.question?.text.trim() && !question) rejectedQuestion = true;
  else if (question && message && !questionRelates(question, catalog, message)) {
    question = null;
    rejectedQuestion = true;
  }
  let flavor: AcceptedQuestion | null = null;

  for (const raw of output.cart) {
    const row = catalog.byId.get(raw.product_id);
    if (!row || !row.disponible) {
      errors.push(`el id ${raw.product_id} no está en el menú`);
      continue;
    }
    if (!Number.isFinite(raw.qty) || raw.qty <= 0) {
      errors.push(`la cantidad de ${row.name} no es un número positivo`);
      continue;
    }
    if (!allowedUnit(row.unit, raw.unit)) {
      errors.push(`${row.name} no se vende en ${raw.unit}`);
      continue;
    }
    if (raw.unit === "pesos" && !(row.precio > 0)) {
      errors.push(`${row.name} no tiene precio para pasar pesos a kilos`);
      continue;
    }
    const mapped = remapVariant(
      { productId: row.id, qty: raw.qty, unit: raw.unit, variant: raw.variant, notes: null },
      row,
      catalog,
    );
    if (mapped.error) errors.push(mapped.error);
    if (mapped.question && !flavor) flavor = { ...mapped.question, sourceText: mapped.question.sourceText || message };
    if (mapped.line) cart.push(mapped.line);
  }

  const packed = applyPacks(cart, prior, catalog, message);
  cart = packed.cart;
  if (packed.question) question = packed.question;

  const notOnMenu: string[] = [];
  for (const term of output.not_on_menu.map((item) => item.trim()).filter(Boolean)) {
    const hit = menuRescue(catalog, term, message);
    if (!hit) {
      notOnMenu.push(term);
      continue;
    }
    const qty = explicitQty(message, catalog.profile);
    const words = fold(message).split(/\s+/).filter(Boolean).length;
    const amount = words <= 5 && qty != null && qty > 0 ? qty : 1;
    if (!cart.some((line) => line.productId === hit.row.id && line.variant === hit.variant)) {
      cart.push(lineOf(hit.row, Number.isInteger(amount) ? amount : 1, hit.row.unit, hit.variant));
    }
  }
  if (notOnMenu.length === 0 && output.not_on_menu.length && question && !questionRelates(question, catalog, message)) question = null;

  if (question && notOnMenu.length && question.candidateIds.every((id) => cart.some((line) => line.productId === id))) {
    question = null;
  }

  if (flavor && (!question || flavor.candidateIds.every((id) => question?.candidateIds.includes(id)))) question = flavor;

  if (question) {
    cart = cart.filter((line) => {
      const existed = prior.some((item) => item.productId === line.productId);
      if (existed || !question?.candidateIds.includes(line.productId)) return true;
      return false;
    });
  }

  let answered = false;
  if (pending && message && !isReplace(message) && !/\botr[oa]\b/.test(fold(message))) {
    const selected = selectFromPending(message, pending, catalog);
    if (selected) {
      const candidates = new Set(pending.candidateIds);
      const others = cart.filter((line) => {
        if (candidates.has(line.productId)) return false;
        const row = catalog.byId.get(line.productId);
        return Boolean(row && mentioned(row, message) && !conflicts(row, message, [...candidates].map((id) => catalog.byId.get(id)!).filter(Boolean)));
      });
      const kept = prior.filter((line) => !candidates.has(line.productId)).map((line) => ({ ...line }));
      cart = [...kept];
      for (const line of [...selected, ...others]) {
        const found = cart.find((item) => sameLine(item, line));
        if (found) found.qty = line.qty;
        else cart.push({ ...line });
      }
      question = null;
      answered = true;
    }
  }

  const otra = applyOtra(cart, prior, catalog, message);
  cart = otra.cart;
  if (otra.question) question = otra.question;

  const each = eachOption(message, pending, prior, catalog);
  if (each) {
    cart = each;
    question = null;
    answered = true;
  }

  cart = preserveCorrection(cart, prior, catalog, message);

  for (const prev of prior) {
    if (cart.some((line) => line.productId === prev.productId)) continue;
    if (canDrop(prev, cart, prior, catalog, message, pending, answered)) continue;
    cart.push({ ...prev });
  }

  if (pending && !answered) {
    const candidates = pending.candidateIds.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
    const narrowed = narrowCandidates(candidates, pending.sourceText);
    cart = cart.filter((line) => {
      if (prior.some((item) => item.productId === line.productId)) return true;
      const row = catalog.byId.get(line.productId);
      if (!row) return false;
      const inside = pending.candidateIds.includes(line.productId);
      if (inside && narrowed.length && !narrowed.some((item) => item.id === line.productId)) {
        errors.push(`${row.name} no es la opción de la pregunta`);
        return false;
      }
      if (inside) return true;
      if (mentioned(row, message) && !conflicts(row, message, candidates)) return true;
      errors.push(`${row.name} no está entre las opciones de la pregunta`);
      return false;
    });
  }

  const seen = new Set<string>();
  cart = cart.filter((line) => {
    const key = `${line.productId}|${line.unit}|${line.variant ?? ""}`;
    if (seen.has(key)) {
      const row = catalog.byId.get(line.productId);
      errors.push(`hay dos líneas de ${row?.name ?? line.productId}; déjalas en una`);
      return false;
    }
    seen.add(key);
    return true;
  });

  cart = cart.filter((line) => {
    if (line.unit !== "pz" || Number.isInteger(line.qty)) return true;
    const row = catalog.byId.get(line.productId);
    errors.push(`${row?.name ?? "esa línea"} en piezas tiene que ser un número entero`);
    return false;
  });

  if (!each) {
    const words = fold(message).split(/\s+/).filter(Boolean);
    const priorIds = new Set(prior.map((line) => line.productId));
    const fresh = cart.filter((line) => !priorIds.has(line.productId));
    if (fresh.length > 6 && words.length <= 12) {
      errors.push("hay demasiadas líneas nuevas para un mensaje corto");
      const named = fresh.filter((line) => {
        const row = catalog.byId.get(line.productId);
        return row && mentioned(row, message);
      });
      const keep = new Set(named.slice(0, 6).map((line) => line.productId));
      cart = cart.filter((line) => priorIds.has(line.productId) || keep.has(line.productId));
    }
  }

  if (question && !question.sourceText) question = { ...question, sourceText: message || null };
  if (rejectedQuestion && !question && !answered && cart.length === 0 && notOnMenu.length === 0) {
    errors.push("la pregunta no trae opciones del menú");
  }

  return { cart, errors, question, notOnMenu };
}
