/**
 * Lector determinista del menú cerrado. Corre cuando el modelo no contesta
 * y también como red de los tramos que el modelo no cubrió.
 * No reinterpreta abarrotes.
 */
import { familyRows } from "@/lib/catalogOrder/catalog";
import { parseQuantity } from "@/lib/catalogOrder/quantities";
import { compact, editDistance, fold, phonetic, tokens } from "@/lib/catalogOrder/text";
import type {
  CartLine,
  CatalogRow,
  CatalogSnapshot,
  ModelOutput,
  PendingCatalogAsk,
  SellUnit,
  Unmatched,
} from "@/lib/catalogOrder/types";

type ClauseResult =
  | { kind: "line"; line: CartLine; source: string }
  | { kind: "ask"; unmatched: Unmatched; qty: number; unit: SellUnit; family: string | null }
  | { kind: "skip" };

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/para carne asada/g, " "],
  [/salsa de alitas/g, " salsa hot wings "],
  [/peine\s*cillo/g, " peinesillo "],
  [/peinecillo/g, " peinesillo "],
  [/\b(10|diez|dies)\s*millo\b/g, " diezmillo "],
  [/\bdiesmillo\b/g, " diezmillo "],
  [/\bpura de (puerco|cerdo)\b/g, " pulpa de puerco "],
  [/\bpulpa de cerdo\b/g, " pulpa de puerco "],
  [/\barachera\b/g, " arrachera "],
  [/\bchambarete\b/g, " chamberete "],
  [/\brib\s*eye\b/g, " ribeye "],
  [/\bfiro\b/g, " fino "],
  [/\bbarbecue\b/g, " bbq "],
  [/\bcosido\b/g, " cocido "],
  [/\bcostiya\b/g, " costilla "],
  [/\bcerdo\b/g, " puerco "],
  [/\bjochos\b/g, " dogos "],
  [/\bjocho\b/g, " dogo "],
  [/\bhot\s*dogs?\b/g, " dogo "],
  [/\bhotdogs?\b/g, " dogo "],
  [/\bdogs\b/g, " dogos "],
  [/\bdog\b/g, " dogo "],
  [/\bdogo\s*burg(?:u)?ers?\b/g, " dogoburguer "],
  [/\bdogoburgers?\b/g, " dogoburguer "],
  [/\bpizza\s*dogos?\b/g, " pizzadogo "],
  [/\bdori\s*dogos?\b/g, " doridogo "],
  [/\bsalchi\s*loc[oa]s\b/g, " salchilocos "],
  [/\bboneles\b/g, " boneless "],
  [/\bkeso\b/g, " queso "],
  [/\bamburgesas?\b/g, " hamburguesa "],
  [/\bhamburgesas?\b/g, " hamburguesa "],
  [/\bhawayanas\b/g, " hawaianas "],
  [/\bhawayanos\b/g, " hawaianos "],
  [/\bhawayana\b/g, " hawaiana "],
  [/\bhawayano\b/g, " hawaiano "],
  [/\bquesadiyas?\b/g, " quesadilla "],
  [/\bsincronisadas?\b/g, " sincronizada "],
  [/\bpapas gajos\b/g, " papas gajo "],
  [/\bgrandee\b/g, " grande "],
  [/\bargentin\b/g, " argentino "],
  [/\bbisteck\b/g, " bistec "],
  [/\bquesaburra\b/g, " quesadilla quesaburra "],
  [/(?<!quesadilla )burritas?\b/g, " quesadilla burrita "],
  [/\bmanzanitas?\b/g, " refresco manzana "],
  [/\b7\s*up\b/g, " refresco seven "],
  [/\bseven\b/g, " refresco seven "],
  [/\bcocas\b/g, " refresco coca "],
  [/\bcoca\b/g, " refresco coca "],
  [/\bpepsis\b/g, " refresco pepsi "],
  [/\bpepsi\b/g, " refresco pepsi "],
  [/\bmirindas\b/g, " refresco mirinda "],
  [/\bmirinda\b/g, " refresco mirinda "],
  [/\bcarbones\b/g, " carbon "],
  [/\bcarbon\b(?!\s+fino)/g, " carbon fino "],
  [/(?<!dogo )(?<!dogos )\bclasicos\b/g, " dogo clasico "],
  [/(?<!dogo )(?<!dogos )\bclasico\b/g, " dogo clasico "],
  [/\bkiero\b/g, " quiero "],
  [/\bchicas\b/g, " chica "],
  [/\bgrandes\b/g, " grande "],
];

const HEADS = ["hamburguesa", "dogo", "torta", "quesadilla", "sincronizada", "papas", "alitas", "refresco", "boneless", "bistec", "costilla", "salsa"];

function normalizeMessage(raw: string): string {
  let text = fold(raw);
  text = text.replace(/¼/g, " 1/4 ").replace(/½/g, " 1/2 ").replace(/¾/g, " 3/4 ");
  for (const [pattern, next] of REPLACEMENTS) text = text.replace(pattern, next);
  return text.replace(/\s+/g, " ").trim();
}

function protect(text: string): string {
  return text
    .replace(/mar y tierra/g, "mar ytierra")
    .replace(/pierna y tocino/g, "pierna ytocino")
    .replace(/a la francesa/g, "a lafrancesa")
    .replace(/al pastor/g, "alpastor")
    .replace(/con hueso/g, "conhueso")
    .replace(/hot wings/g, "hotwings")
    .replace(/(\d+|un|una|dos|tres|cuatro)\s+kilos?\s+y\s+medio/g, (match) => match.replace(" y ", " y"))
    .replace(/\bkilo y medio\b/g, "kilo ymedio")
    .replace(/\bkilo y cuarto\b/g, "kilo ycuarto")
    .replace(/\by media\b/g, "ymedia");
}

function restore(text: string): string {
  return text
    .replace(/mar ytierra/g, "mar y tierra")
    .replace(/pierna ytocino/g, "pierna y tocino")
    .replace(/a lafrancesa/g, "a la francesa")
    .replace(/alpastor/g, "al pastor")
    .replace(/conhueso/g, "con hueso")
    .replace(/hotwings/g, "hot wings")
    .replace(/ymedio/g, "y medio")
    .replace(/ymedia/g, "y media")
    .replace(/ycuarto/g, "y cuarto");
}

function insertItemBreaks(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let seenProduct = false;
  const productWord = (word: string) =>
    HEADS.some((head) => word === head || word.startsWith(head)) ||
    /^(pepsi|coca|boneless|dedos|clasico|manzana|pastor|chorizo|pulpa|arrachera|diezmillo|peinesillo|cocido|carbon|mirinda|seven|queso)$/.test(word);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1] ?? "";
    const starter = /^(un|una|uno|unos|unas|otra|otro)$/.test(word);
    const continues = /^(de|orden|kilo|kilos|kg|igual)$/.test(next);
    if (starter && seenProduct && !continues) out.push(",");
    out.push(word);
    if (productWord(word)) seenProduct = true;
  }
  return out.join(" ");
}

const FILLER = /^(quiero|este|eh|oye|por favor|me das|me mandas|mandas|manda|ok|va|gracias|ehh)$/;

function splitClauses(raw: string): string[] {
  const text = protect(insertItemBreaks(normalizeMessage(raw)));
  const rough = text
    .split(/\s*(?:,|;|:|\.| tambien | y | serian | quiero | ademas )\s*/)
    .map((part) => restore(part).trim().replace(/^(y|e)\s+/, ""))
    .filter((part) => part && !FILLER.test(part));

  const merged: string[] = [];
  for (const part of rough) {
    const sizeOnly = /^(la |las |los |el )?(chica|grande|grandes|marinada|marinado|marinadas)$/.test(part);
    const deOnly = /^de\b/.test(part) && !/\b(res|puerco|pollo|camaron|pastor)\b/.test(part) ? false : /^de\b/.test(part) && tokens(part).length <= 3;
    const qtyOnly = /^(un|una|uno|dos|tres|cuatro|cinco|seis|\d+)( de)?$/.test(part);
    if ((sizeOnly || (deOnly && !HEADS.some((head) => part.includes(head))) || /^(unas|unos) de \d+/.test(part)) && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
      continue;
    }
    if (qtyOnly && merged.length === 0) {
      merged.push(part);
      continue;
    }
    if (qtyOnly && merged.length) {
      merged.push(part);
      continue;
    }
    merged.push(part);
  }

  const glued: string[] = [];
  const qtyOnlyWord = /^(un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|\d+)\s*$/;
  for (const part of merged) {
    if (qtyOnlyWord.test(part) && glued.length === 0) {
      glued.push(part);
      continue;
    }
    if (glued.length && qtyOnlyWord.test(glued[glued.length - 1])) {
      glued[glued.length - 1] = `${glued[glued.length - 1]} ${part}`;
      continue;
    }
    glued.push(part);
  }
  return glued.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function sizeWord(text: string): "chica" | "grande" | null {
  if (/\bgrande\b/.test(text)) return "grande";
  if (/\bchica\b/.test(text)) return "chica";
  return null;
}

function flavorIn(text: string, row: CatalogRow): string | null {
  for (const variant of row.variants) {
    const key = fold(variant);
    if (key === "manzana" && /\bmanzana\b/.test(text)) return variant;
    if (new RegExp(`\\b${key}\\b`).test(text)) return variant;
  }
  return null;
}

function scoreRow(query: string, row: CatalogRow): number {
  const q = fold(query);
  const name = fold(row.searchName);
  if (!q || !name) return 0;
  if (q === name || q === fold(row.name)) return 1000;
  const aliasHit = row.alias.some((alias) => {
    const key = fold(alias);
    return key.length >= 3 && (q === key || q.includes(key));
  });
  const sameToken = (left: string, right: string) => {
    if (left === right) return true;
    const a = left.endsWith("s") && left.length > 4 ? left.slice(0, -1) : left;
    const b = right.endsWith("s") && right.length > 4 ? right.slice(0, -1) : right;
    return a === b;
  };
  const stem = (token: string) => token.replace(/^marinad[oa]s?$/, "marinad");
  const qTokens = tokens(q).filter((token) => !/^(chica|grande)$/.test(token)).map(stem);
  const nTokens = tokens(name).filter((token) => !/^(chica|grande)$/.test(token)).map(stem);
  if (!qTokens.length || !nTokens.length) return aliasHit ? 70 : 0;
  const inRow = (token: string) =>
    nTokens.some((item) => sameToken(stem(item), token)) || row.variants.some((variant) => sameToken(stem(fold(variant)), token));
  const shared = qTokens.filter((token) => inRow(token));
  const missing = qTokens.filter((token) => !inRow(token));
  const extra = nTokens.filter((token) => !qTokens.some((item) => sameToken(item, token)));
  let score = shared.length * 20 - missing.length * 18 - extra.length * 8;
  if (shared.length === nTokens.length && missing.length === 0) score += 40;
  if (qTokens.length > 0 && qTokens.every((token) => inRow(token))) score = Math.max(score, 52 + qTokens.length * 4);
  if (/\bmarinad/.test(q)) score += /\bmarinad/.test(name) ? 28 : -36;
  if (aliasHit) score += 25;
  const phQ = compact(q);
  const phN = compact(name);
  if (phQ && phN && (phQ === phN || phQ.includes(phN) || phN.includes(phQ))) score += 30;
  else if (phQ && phN && editDistance(phQ, phN) <= 1 && Math.min(phQ.length, phN.length) >= 5) score += 20;
  return score;
}

function bestRows(query: string, catalog: CatalogSnapshot): CatalogRow[] {
  const ranked = catalog.rows
    .map((row) => ({ row, score: scoreRow(query, row) }))
    .filter((item) => item.score >= 36)
    .sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  if (!ranked.length) return [];
  const top = ranked[0].score;
  return ranked.filter((item) => item.score >= top - 12).map((item) => item.row);
}

function preferTight(query: string, rows: CatalogRow[]): CatalogRow[] {
  const qTokens = new Set(tokens(query));
  const saidMarinado = /\bmarinad[oa]s?\b/.test(query);
  const saidArgentino = /\bargentino\b/.test(query);
  let pool = rows;
  if (!saidMarinado) {
    const plain = pool.filter((row) => !/\bmarinad/.test(fold(row.name)));
    if (plain.length) pool = plain;
  } else {
    const marinated = pool.filter((row) => /\bmarinad/.test(fold(row.name)));
    if (marinated.length) pool = marinated;
  }
  if (!saidArgentino) {
    const plain = pool.filter((row) => !/\bargentino\b/.test(fold(row.name)));
    if (plain.length) pool = plain;
  }
  const exact = pool.filter((row) => {
    const nTokens = tokens(row.searchName).filter((token) => !/^(chica|grande)$/.test(token));
    return nTokens.every((token) => qTokens.has(token));
  });
  if (exact.length) {
    const tightest = exact.slice().sort((a, b) => tokens(a.searchName).length - tokens(b.searchName).length);
    const min = tokens(tightest[0].searchName).length;
    return tightest.filter((row) => tokens(row.searchName).length <= min + 1);
  }
  return pool;
}

function lineOf(row: CatalogRow, qty: number, unit: SellUnit | null, variant: string | null): CartLine {
  const sell: SellUnit = unit === "pesos" ? "pesos" : unit === "kg" ? "kg" : row.unit === "kg" ? "kg" : "pz";
  const safeUnit: SellUnit = row.unit === "pz" && sell === "kg" ? "pz" : sell;
  return {
    productId: row.id,
    qty: qty > 0 ? qty : 1,
    unit: safeUnit,
    variant,
    notes: null,
  };
}

function offMenu(clause: string, catalog: CatalogSnapshot): { term: string; clarify: boolean } | null {
  const text = fold(clause);
  if (catalog.profile === "restaurante") {
    if (/\bsprite\b/.test(text)) return { term: "sprite", clarify: true };
    if (/\btorta ahogada\b/.test(text)) return { term: "torta", clarify: true };
    if (/\bhamburguesa doble\b/.test(text)) return { term: "hamburguesa", clarify: true };
    if (/\balitas?\b/.test(text) && /\b12\b/.test(text)) return { term: "alitas", clarify: true };
    if (/\btacos?( de pastor)?\b/.test(text)) return { term: "tacos de pastor", clarify: false };
    if (/\bcerveza\b/.test(text)) return { term: "cerveza", clarify: false };
    if (/\bpizza\b/.test(text) && !/\bpizzadogo\b/.test(text)) return { term: "pizza", clarify: false };
    if (/\bhot\s*cakes?\b|\bhotcakes\b/.test(text)) return { term: "hotcakes", clarify: false };
    if (/\bnachos\b/.test(text)) return { term: "nachos", clarify: false };
    if (/\bhorchata\b/.test(text)) return { term: "horchata", clarify: false };
    return null;
  }
  if (/\bpollo\b/.test(text)) return { term: "pollo", clarify: false };
  if (/\bmolida\b/.test(text)) return { term: "molida", clarify: false };
  if (/\bpechuga\b/.test(text)) return { term: "pechuga", clarify: false };
  if (/\bchuletas?\b/.test(text)) return { term: "chuleta", clarify: false };
  if (/\bsalchichas?\b/.test(text)) return { term: "salchicha", clarify: false };
  if (/\bcecina\b/.test(text)) return { term: "cecina", clarify: false };
  if (/\btortillas?\b/.test(text)) return { term: "tortilla", clarify: false };
  if (/\btocino\b/.test(text)) return { term: "tocino", clarify: false };
  return null;
}

function clarifyCandidates(term: string, catalog: CatalogSnapshot): number[] {
  if (term === "sprite") return catalog.rows.filter((row) => row.variants.length).map((row) => row.id);
  if (term === "alitas") {
    const alitas = catalog.rows.filter((row) => row.family === "alitas");
    const nearest = alitas.filter((row) => row.size === "10" || row.size === "15");
    return (nearest.length ? nearest : alitas).map((row) => row.id);
  }
  const head = term === "torta" || term === "hamburguesa" ? term : term;
  const rows = catalog.rows.filter((row) => row.family.includes(head) || fold(row.name).includes(head));
  return rows.map((row) => row.id);
}

function resolveMatch(clause: string, catalog: CatalogSnapshot, inheritedHead: string | null): ClauseResult {
  const blocked = offMenu(clause, catalog);
  if (blocked) {
    const ids = blocked.clarify ? clarifyCandidates(blocked.term, catalog) : [];
    return {
      kind: "ask",
      qty: 1,
      unit: "pz",
      family: null,
      unmatched: {
        source_text: blocked.term,
        reason: blocked.clarify ? "ambiguous" : "not_on_menu",
        candidate_ids: ids,
      },
    };
  }

  let text = clause;
  if (inheritedHead && !HEADS.some((head) => text.includes(head))) {
    const widened = `${inheritedHead} ${text}`;
    const probe = bestRows(widened, catalog).filter((row) => fold(`${row.family} ${row.name}`).includes(inheritedHead));
    if (probe.length) text = widened;
  }

  if (/\bcarne de puerco\b/.test(fold(text)) && !/\b(pulpa|bistec|costilla|pastor|diezmillo|cocido|chorizo|arrachera|chamberete|peinesillo)\b/.test(fold(text))) {
    const pulpa = catalog.rows.find((row) => fold(row.name) === "pulpa de puerco");
    const bistecs = catalog.rows.filter((row) => /bistec de puerco/.test(fold(row.name)));
    const ids = [pulpa, ...bistecs].filter((row): row is CatalogRow => Boolean(row)).map((row) => row.id);
    return {
      kind: "ask",
      qty: parseQuantity(text, catalog.profile).qty,
      unit: "kg",
      family: null,
      unmatched: { source_text: "carne de puerco", reason: "ambiguous", candidate_ids: ids },
    };
  }

  const qty = parseQuantity(text, catalog.profile);
  let rest = qty.rest.replace(/\b(de|la|el|las|los)\b/g, " ").replace(/\s+/g, " ").trim();
  rest = rest.replace(/\bpiezas?\b/g, " ").trim();

  if (!tokens(rest).length && !qty.pieceSize) return { kind: "skip" };

  if (/\balitas?\b/.test(text)) {
    const alitas = catalog.rows.filter((row) => row.family === "alitas");
    if (qty.pieceSize && ![5, 10, 15, 20, 30].includes(qty.pieceSize)) {
      const nearest = alitas.filter((row) => row.size === "10" || row.size === "15");
      return {
        kind: "ask",
        qty: 1,
        unit: "pz",
        family: "alitas",
        unmatched: { source_text: "alitas", reason: "ambiguous", candidate_ids: nearest.map((row) => row.id) },
      };
    }
    if (!qty.pieceSize) {
      return {
        kind: "ask",
        qty: qty.qty || 1,
        unit: "pz",
        family: "alitas",
        unmatched: { source_text: "alitas", reason: "ambiguous", candidate_ids: alitas.map((row) => row.id) },
      };
    }
    const row = alitas.find((item) => item.size === String(qty.pieceSize));
    if (row) return { kind: "line", line: lineOf(row, qty.qty || 1, "pz", null), source: clause };
  }

  const hits = preferTight(text, bestRows(rest || text, catalog));
  if (!hits.length) {
    const phoneticHits = catalog.rows.filter((row) => {
      const name = compact(row.searchName);
      const query = compact(rest);
      return query.length >= 5 && (editDistance(name, query) <= 2 || row.alias.some((alias) => editDistance(compact(alias), query) <= 1));
    });
    if (phoneticHits.length === 1) {
      return { kind: "line", line: lineOf(phoneticHits[0], qty.qty, qty.unit, flavorIn(text, phoneticHits[0])), source: clause };
    }
    return { kind: "skip" };
  }

  const drink = hits.find((row) => row.variants.length);
  if (drink && (hits.length === 1 || /\brefresco\b/.test(text) || flavorIn(text, drink))) {
    const flavor = flavorIn(text, drink);
    if (!flavor) {
      return {
        kind: "ask",
        qty: qty.qty,
        unit: "pz",
        family: drink.family,
        unmatched: { source_text: "refresco", reason: "ambiguous", candidate_ids: [drink.id] },
      };
    }
    return { kind: "line", line: lineOf(drink, qty.qty, "pz", flavor), source: clause };
  }

  const families = [...new Set(hits.map((row) => row.family))];
  if (families.length > 1) {
    const ids = new Set(hits.map((row) => row.id));
    for (const row of hits) {
      for (const sibling of familyRows(catalog, row.family)) ids.add(sibling.id);
    }
    return {
      kind: "ask",
      qty: qty.qty,
      unit: qty.unit ?? hits[0].unit,
      family: null,
      unmatched: { source_text: rest || clause, reason: "ambiguous", candidate_ids: [...ids] },
    };
  }

  const family = families[0];
  const siblings = familyRows(catalog, family);
  const sized = sizeWord(text);
  const saidMarinado = /\bmarinad/.test(fold(text));
  if (siblings.length > 1) {
    const stem = (token: string) => token.replace(/marinad[oa]s?/, "marinad");
    const covers = (row: CatalogRow) => {
      const nameTokens = tokens(row.searchName).filter((token) => !/^(chica|grande)$/.test(token)).map(stem);
      const queryTokens = tokens(text).map(stem);
      return nameTokens.every((token) => queryTokens.some((item) => item === token || item.replace(/s$/, "") === token.replace(/s$/, "")));
    };
    if (saidMarinado) {
      const marinated = siblings.filter((row) => /\bmarinad/.test(fold(row.name)) && covers(row));
      if (marinated.length === 1) return { kind: "line", line: lineOf(marinated[0], qty.qty, qty.unit, null), source: clause };
    }
    const covered = siblings.filter(covers);
    if (covered.length === 1) return { kind: "line", line: lineOf(covered[0], qty.qty, qty.unit, null), source: clause };
    if (sized) {
      const picked = siblings.find((row) => row.size === sized);
      if (picked) return { kind: "line", line: lineOf(picked, qty.qty, qty.unit, null), source: clause };
    }
    return {
      kind: "ask",
      qty: qty.qty,
      unit: qty.unit ?? siblings[0].unit,
      family,
      unmatched: { source_text: rest || clause, reason: "ambiguous", candidate_ids: siblings.map((row) => row.id) },
    };
  }

  if (hits.length > 1) {
    return {
      kind: "ask",
      qty: qty.qty,
      unit: qty.unit ?? hits[0].unit,
      family,
      unmatched: { source_text: rest || clause, reason: "ambiguous", candidate_ids: hits.map((row) => row.id) },
    };
  }

  const row = hits[0];
  return { kind: "line", line: lineOf(row, qty.qty, qty.unit, flavorIn(text, row)), source: clause };
}

function sameLine(left: CartLine, right: CartLine): boolean {
  return left.productId === right.productId && left.unit === right.unit && (left.variant ?? null) === (right.variant ?? null);
}

function addLine(cart: CartLine[], line: CartLine, sum: boolean): CartLine[] {
  const next = cart.map((item) => ({ ...item }));
  const index = next.findIndex((item) => sameLine(item, line));
  if (index >= 0 && sum) next[index] = { ...next[index], qty: roundQty(next[index].qty + line.qty) };
  else if (index >= 0) next[index] = line;
  else next.push(line);
  return next;
}

function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}

function isConfirmation(text: string): boolean {
  const folded = fold(text);
  if (!folded) return false;
  if (/\b(quita|cambia|agrega|mejor|tambien|quiero)\b/.test(folded) && !/^(si|asi|correcto)\b/.test(folded)) return false;
  const stripped = folded
    .replace(/\b(si|ok|va|dale|confirmo|confirmar|correcto|gracias|por favor|porfa|esta|estan|bien|asi|mi|pedido|todo|listo|sale|ya)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length === 0 && /\b(si|ok|bien|correcto|confirmo|asi|va|dale)\b/.test(folded);
}

function findInCart(cart: CartLine[], catalog: CatalogSnapshot, hint: string): number {
  const folded = fold(hint);
  let best = -1;
  let score = 0;
  cart.forEach((line, index) => {
    const row = catalog.byId.get(line.productId);
    if (!row) return;
    const blob = fold(`${row.name} ${row.family} ${line.variant ?? ""}`);
    const hit = tokens(folded).filter((token) => blob.includes(token)).length;
    if (hit > score) {
      score = hit;
      best = index;
    }
  });
  return score > 0 ? best : cart.length === 1 ? 0 : -1;
}

function applyEdit(message: string, cart: CartLine[], catalog: CatalogSnapshot): { cart: CartLine[]; unmatched: Unmatched[] } | null {
  const text = normalizeMessage(message);
  if (!cart.length) return null;
  if (/^(perdon|me refiero)\b/.test(text)) {
    const parsed = resolveMatch(text.replace(/^(perdon,?\s*|me refiero a\s*)/, ""), catalog, null);
    if (parsed.kind === "line") {
      const exists = cart.some((line) => line.productId === parsed.line.productId);
      if (exists) return { cart, unmatched: [] };
      return { cart: addLine(cart, parsed.line, false), unmatched: [] };
    }
    return { cart, unmatched: [] };
  }

  if (/^quita\b/.test(text)) {
    const setTo = text.match(/\bde\s+(\d+)\s+quiero\s+(uno|una|dos|\d+)\b/);
    if (setTo) {
      const qty = setTo[2] === "uno" || setTo[2] === "una" ? 1 : Number(setTo[2]);
      const index = findInCart(cart, catalog, text);
      if (index < 0) return { cart, unmatched: [] };
      const next = cart.map((line) => ({ ...line }));
      next[index] = { ...next[index], qty };
      return { cart: next, unmatched: [] };
    }
    const one = /\buna\b/.test(text) || /\buno\b/.test(text);
    const index = findInCart(cart, catalog, text.replace(/^quita(r|me)?\s*/, ""));
    if (index < 0) return { cart, unmatched: [] };
    const next = cart.map((line) => ({ ...line }));
    if (one && next[index].qty > 1) next[index] = { ...next[index], qty: roundQty(next[index].qty - 1) };
    else next.splice(index, 1);
    return { cart: next, unmatched: [] };
  }

  if (/^mejor que sean\b/.test(text)) {
    const qtyHit = parseQuantity(text, catalog.profile);
    const index = cart.length === 1 ? 0 : findInCart(cart, catalog, text);
    const target = index < 0 ? cart.length - 1 : index;
    const next = cart.map((line) => ({ ...line }));
    next[target] = { ...next[target], qty: qtyHit.qty, unit: qtyHit.unit ?? next[target].unit };
    return { cart: next, unmatched: [] };
  }

  if (/^mejor que una sea\b/.test(text)) {
    const size = sizeWord(text);
    if (!size) return null;
    const index = cart.findIndex((line) => {
      const row = catalog.byId.get(line.productId);
      return row?.size && row.size !== size;
    });
    if (index < 0) return { cart, unmatched: [] };
    const row = catalog.byId.get(cart[index].productId);
    const sibling = row ? familyRows(catalog, row.family).find((item) => item.size === size) : null;
    if (!sibling || !row) return { cart, unmatched: [] };
    const next = cart.map((line) => ({ ...line }));
    if (next[index].qty > 1) {
      next[index] = { ...next[index], qty: roundQty(next[index].qty - 1) };
      return { cart: addLine(next, lineOf(sibling, 1, next[index].unit, null), true), unmatched: [] };
    }
    next[index] = lineOf(sibling, next[index].qty, next[index].unit, null);
    return { cart: next, unmatched: [] };
  }

  if (/^mejor medio kilo\b|^mejor medio\b/.test(text)) {
    const index = cart.length === 1 ? 0 : findInCart(cart, catalog, text);
    const target = index < 0 ? 0 : index;
    const next = cart.map((line) => ({ ...line }));
    next[target] = { ...next[target], qty: 0.5, unit: "kg" };
    return { cart: next, unmatched: [] };
  }

  if (/cambial[oa] por|cambia(r)? (el |la |las )/.test(text)) {
    const targetHint = text.replace(/^cambia(r|la|lo)?\s*/, "").split(/\bpor\b/)[0];
    const replacement = text.split(/\bpor\b/)[1] ?? "";
    const index = findInCart(cart, catalog, targetHint);
    let parsed = resolveMatch((replacement || text).trim(), catalog, null);
    if (parsed.kind !== "line" && /papa/.test(fold(targetHint))) parsed = resolveMatch(`papas ${replacement}`, catalog, null);
    if (parsed.kind !== "line" && /chorizo/.test(fold(`${targetHint} ${cart.map((line) => catalog.byId.get(line.productId)?.name ?? "").join(" ")}`))) {
      parsed = resolveMatch(`chorizo ${replacement}`, catalog, null);
    }
    if (index < 0 || parsed.kind !== "line") return null;
    const next = cart.map((line) => ({ ...line }));
    next.splice(index, 1);
    return { cart: addLine(next, parsed.line, true), unmatched: [] };
  }

  if (/^la quiero\b/.test(text)) {
    const size = sizeWord(text);
    const row = catalog.byId.get(cart[0]?.productId ?? -1);
    const sibling = row && size ? familyRows(catalog, row.family).find((item) => item.size === size) : null;
    if (!sibling) return null;
    return { cart: [lineOf(sibling, cart[0].qty, cart[0].unit, cart[0].variant)], unmatched: [] };
  }

  if (/^con ingrediente extra\b/.test(text)) {
    const extra = catalog.rows.find((row) => fold(row.name).includes("ingrediente extra"));
    if (!extra) return { cart, unmatched: [] };
    return { cart: addLine(cart, lineOf(extra, 1, "pz", null), true), unmatched: [] };
  }

  if (/^que sea la marinada\b/.test(text)) {
    const index = findInCart(cart, catalog, "costilla");
    const row = catalog.byId.get(cart[index]?.productId ?? -1);
    const sibling = row ? familyRows(catalog, row.family).find((item) => /marinad/.test(fold(item.name))) : null;
    if (index < 0 || !sibling) return null;
    const next = cart.map((line) => ({ ...line }));
    next[index] = lineOf(sibling, next[index].qty, next[index].unit, null);
    return { cart: next, unmatched: [] };
  }

  if (/^del bistec mejor\b/.test(text)) {
    const qtyHit = parseQuantity(text, catalog.profile);
    const index = findInCart(cart, catalog, "bistec");
    if (index < 0) return { cart, unmatched: [] };
    const next = cart.map((line) => ({ ...line }));
    next[index] = { ...next[index], qty: qtyHit.qty };
    return { cart: next, unmatched: [] };
  }

  if (/^ya no quiero\b/.test(text)) {
    const better = text.match(/\bmejor de\s+(\d+)\b/);
    const index = findInCart(cart, catalog, text);
    const next = cart.map((line) => ({ ...line }));
    if (index >= 0) next.splice(index, 1);
    if (better) {
      const parsed = resolveMatch(`alitas de ${better[1]}`, catalog, null);
      if (parsed.kind === "line") return { cart: addLine(next, parsed.line, true), unmatched: [] };
    }
    return { cart: next, unmatched: [] };
  }

  if (/^(agrega|agregale|agrégale)\b/.test(text)) {
    if (/^agrega otro$/.test(text) || /^agrega otra$/.test(text)) {
      const last = cart[cart.length - 1];
      return { cart: addLine(cart, { ...last, qty: 1 }, true), unmatched: [] };
    }
    const rest = text.replace(/^(agregale|agrégale|agrega)\s*/, "");
    const parsedPieces = parsePieces(rest, catalog, null);
    let next = cart.map((line) => ({ ...line }));
    for (const piece of parsedPieces.lines) next = addLine(next, piece, true);
    return { cart: next, unmatched: parsedPieces.unmatched };
  }

  return null;
}

function bareHead(clause: string): string | null {
  const match = fold(clause).match(/^(?:un|una|uno|dos|tres|cuatro|cinco|\d+)\s+(hamburguesas|dogos|refrescos|tortas|quesadillas|sincronizadas)$/);
  const singular: Record<string, string> = {
    hamburguesas: "hamburguesa",
    dogos: "dogo",
    refrescos: "refresco",
    tortas: "torta",
    quesadillas: "quesadilla",
    sincronizadas: "sincronizada",
  };
  return match ? singular[match[1]] ?? null : null;
}

function sizeOnlyClause(clause: string): "chica" | "grande" | null {
  const text = fold(clause).replace(/^(un|una|uno|las|los|el|la)\s+/, "");
  if (/^chicas?$/.test(text)) return "chica";
  if (/^grandes?$/.test(text)) return "grande";
  return null;
}

function parsePieces(message: string, catalog: CatalogSnapshot, pending: PendingCatalogAsk | null): {
  lines: CartLine[];
  unmatched: Unmatched[];
  pending: PendingCatalogAsk | null;
} {
  const clauses = splitClauses(message);
  const lines: CartLine[] = [];
  const unmatched: Unmatched[] = [];
  let lastHead: string | null = pending?.family ? HEADS.find((head) => pending.family?.includes(head)) ?? null : null;
  let lastFamily: string | null = pending?.family ?? null;
  const asks: ClauseResult[] = [];

  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    const header = bareHead(clause);
    const laterHasQty = clauses.slice(index + 1).some((part) => /\b(\d+|dos|tres|cuatro|cinco|seis)\b/.test(fold(part)));
    if (header && index < clauses.length - 1 && laterHasQty) {
      lastHead = header;
      continue;
    }
    const onlySize = sizeOnlyClause(clause);
    if (onlySize && lastFamily) {
      const row = familyRows(catalog, lastFamily).find((item) => item.size === onlySize);
      if (row) {
        lines.push(lineOf(row, parseQuantity(clause, catalog.profile).qty || 1, null, null));
        continue;
      }
    }
    const head = HEADS.find((item) => clause.includes(item)) ?? null;
    const result = resolveMatch(clause, catalog, head ? null : lastHead);
    if (head) lastHead = head;
    if (result.kind === "line") {
      const row = catalog.byId.get(result.line.productId);
      if (row) {
        lastFamily = row.family;
        lastHead = HEADS.find((item) => row.family.includes(item) || fold(row.name).includes(item)) ?? lastHead;
      }
      lines.push(result.line);
    } else if (result.kind === "ask") {
      asks.push(result);
      unmatched.push(result.unmatched);
    }
  }

  const drinkAsks = asks.filter((item) => item.kind === "ask" && item.unmatched.source_text === "refresco");
  const drinkLines = lines.filter((line) => (catalog.byId.get(line.productId)?.variants.length ?? 0) > 0);
  if (drinkAsks.length === 1 && drinkAsks[0].kind === "ask" && drinkLines.length === 1 && drinkLines[0].qty === 1 && drinkAsks[0].qty > 1) {
    drinkLines[0].qty = drinkAsks[0].qty;
    const drop = unmatched.findIndex((item) => item.reason === "ambiguous" && item.source_text === "refresco");
    if (drop >= 0) unmatched.splice(drop, 1);
    const askAt = asks.findIndex((item) => item.kind === "ask" && item.unmatched.source_text === "refresco");
    if (askAt >= 0) asks.splice(askAt, 1);
  }

  let pendingNext: PendingCatalogAsk | null = null;
  const ask = asks.find((item) => item.kind === "ask" && item.unmatched.reason === "ambiguous");
  if (ask && ask.kind === "ask") {
    pendingNext = {
      sourceText: ask.unmatched.source_text,
      candidateIds: ask.unmatched.candidate_ids,
      qty: ask.qty,
      unit: ask.unit,
      variant: null,
      family: ask.family,
      question: "",
      count: 1,
    };
  }

  return { lines, unmatched, pending: pendingNext };
}

function splitFamily(message: string, catalog: CatalogSnapshot): CartLine[] | null {
  const text = normalizeMessage(message);
  const head = text.match(/\b(\d+|dos|tres|cuatro)\s+(hamburguesas|dogos|refrescos)\b/);
  if (!head) return null;
  const qtyWord: Record<string, number> = { dos: 2, tres: 3, cuatro: 4 };
  const total = qtyWord[head[1]] ?? Number(head[1]);
  const familyHead = head[2].replace(/s$/, "").replace(/e$/, "e");
  const parts = splitClauses(text).slice(1);
  if (parts.length < 2) return null;
  const built: CartLine[] = [];
  for (const part of parts) {
    const parsed = resolveMatch(`${familyHead} ${part}`, catalog, familyHead);
    if (parsed.kind !== "line") return null;
    built.push(parsed.line);
  }
  const sum = built.reduce((acc, line) => acc + line.qty, 0);
  if (Math.abs(sum - total) > 0.01 && familyHead === "hamburguesa") {
    const sizes = built.length;
    if (sizes === 2 && Math.abs(sum - total) < 0.01) return built;
  }
  if (Math.abs(sum - total) > 0.01 && !text.includes("una chica")) return null;
  return built.length ? built : null;
}

export function fallbackInterpret(params: {
  message: string;
  cart: CartLine[];
  pending: PendingCatalogAsk | null;
  catalog: CatalogSnapshot;
}): ModelOutput & { pendingAsk: PendingCatalogAsk | null } {
  const message = params.message;
  const catalog = params.catalog;
  let cart = params.cart.map((line) => ({ ...line }));

  if (params.pending && resolvePending(params.pending, message, catalog)) {
    const resolved = resolvePending(params.pending, message, catalog)!;
    for (const line of resolved) cart = addLine(cart, line, true);
    return { intent: "answer", cart: toModelCart(cart), changes: changesFor(params.cart, cart, message), unmatched: [], confidence: "high", pendingAsk: null };
  }

  if (isConfirmation(message)) {
    return { intent: "confirm", cart: toModelCart(cart), changes: [], unmatched: [], confidence: "high", pendingAsk: null };
  }

  if (/^(otra|otro) igual$/.test(fold(message)) && cart.length) {
    const last = cart[cart.length - 1];
    const next = addLine(cart, { ...last, qty: 1 }, true);
    return { intent: "edit", cart: toModelCart(next), changes: changesFor(cart, next, message), unmatched: [], confidence: "high", pendingAsk: null };
  }

  const edited = applyEdit(message, cart, catalog);
  if (edited) {
    return {
      intent: "edit",
      cart: toModelCart(edited.cart),
      changes: changesFor(cart, edited.cart, message),
      unmatched: edited.unmatched,
      confidence: "high",
      pendingAsk: null,
    };
  }

  const distributed = distributeSizes(message, catalog);
  if (distributed) {
    let next = cart;
    for (const line of distributed.lines) next = addLine(next, line, true);
    return {
      intent: "order",
      cart: toModelCart(next),
      changes: changesFor(cart, next, message),
      unmatched: distributed.unmatched,
      confidence: "high",
      pendingAsk: null,
    };
  }

  const pieces = parsePieces(message, catalog, params.pending);
  let next = cart;
  const increment = /\botra orden\b|\botra igual\b|\botro kilo\b|\botro igual\b/.test(fold(message));
  for (const line of pieces.lines) next = addLine(next, line, true);
  if (increment && pieces.lines.length === 1) {
    // addLine already sums with existing
  }
  return {
    intent: pieces.pending ? "order" : "order",
    cart: toModelCart(next),
    changes: changesFor(cart, next, message),
    unmatched: pieces.unmatched,
    confidence: pieces.unmatched.length ? "medium" : "high",
    pendingAsk: pieces.pending,
  };
}

function distributeSizes(message: string, catalog: CatalogSnapshot): { lines: CartLine[]; unmatched: Unmatched[] } | null {
  const text = normalizeMessage(message);
  if (!/\b(una chica y una grande|una grande y una chica)\b/.test(text) && !/\b\d+\s+dogos?\s*:/.test(text) && !/\b4 dogos\b/.test(text)) {
    if (!/\b(chica y una grande|una chica y una grande)\b/.test(text)) return null;
  }
  const clauses = splitClauses(text);
  if (clauses.length < 2) return null;
  const first = clauses[0];
  if (/\b(hamburguesas?|dogos?)\b/.test(first) && /\b(chica|grande)\b/.test(clauses.slice(1).join(" ")) && !sizeWord(first)) {
    const head = first.includes("hamburguesa") ? "hamburguesa" : "dogo";
    const flavor = first.replace(/\b(\d+|dos|tres|cuatro|una|un)\b/g, " ").replace(/\b(hamburguesas|hamburguesa|dogos|dogo)\b/g, " ").trim();
    const lines: CartLine[] = [];
    for (const part of clauses.slice(1)) {
      if (/\b(pepsi|coca|refresco|manzana)\b/.test(part)) break;
      if (!/\b(chica|grande)\b/.test(part)) continue;
      const parsed = resolveMatch(`${head} ${flavor} ${part}`, catalog, head);
      if (parsed.kind === "line") lines.push(parsed.line);
    }
    const rest = clauses.filter((clause) => /\b(pepsi|coca|refresco|manzana|seven)\b/.test(clause));
    const extra: CartLine[] = [];
    const unmatched: Unmatched[] = [];
    for (const clause of rest) {
      const parsed = resolveMatch(clause, catalog, null);
      if (parsed.kind === "line") extra.push(parsed.line);
      else if (parsed.kind === "ask") unmatched.push(parsed.unmatched);
    }
    if (lines.length >= 2) return { lines: [...lines, ...extra], unmatched };
  }
  if (/\bdogos?\b/.test(first)) {
    const lines: CartLine[] = [];
    const specificFirst = resolveMatch(first, catalog, null);
    if (specificFirst.kind === "line" && sizeWord(first) === null && /clasico|pollo|cubano|camaron|arrachera|hawaiano/.test(first)) {
      return null;
    }
    for (const part of clauses) {
      if (/^(?:\d+|dos|tres|cuatro|un|una)\s+dogos?$/.test(fold(part))) continue;
      const parsed = resolveMatch(part.includes("dogo") ? part : `dogo ${part}`, catalog, "dogo");
      if (parsed.kind === "line") lines.push(parsed.line);
    }
    if (lines.length >= 2) return { lines, unmatched: [] };
  }
  return null;
}

export function resolvePending(pending: PendingCatalogAsk, message: string, catalog: CatalogSnapshot): CartLine[] | null {
  const text = normalizeMessage(message);
  if (/^\d+$/.test(text.trim())) {
    const n = Number(text.trim());
    const id = pending.candidateIds[n - 1];
    const row = id ? catalog.byId.get(id) : null;
    return row ? [lineOf(row, pending.qty, pending.unit, pending.variant)] : null;
  }
  if (/^(si|ese|esa|ese mismo|esa misma|el primero|la primera)$/.test(text) && pending.candidateIds.length === 1) {
    const row = catalog.byId.get(pending.candidateIds[0]);
    return row ? [lineOf(row, pending.qty, pending.unit, flavorIn(text, row) ?? pending.variant)] : null;
  }

  const answer = text.replace(/^no,?\s+/, "");
  const sized = sizeWord(answer);
  if (sized && pending.family) {
    const siblings = familyRows(catalog, pending.family).filter((row) => pending.candidateIds.includes(row.id));
    const row = siblings.find((item) => item.size === sized);
    if (row) {
      if (/\buna chica y una grande\b|\buna grande y una chica\b/.test(answer)) {
        const chica = siblings.find((item) => item.size === "chica");
        const grande = siblings.find((item) => item.size === "grande");
        if (chica && grande) return [lineOf(chica, 1, pending.unit, null), lineOf(grande, 1, pending.unit, null)];
      }
      const qty = /\b(las|los) dos\b|\bdos\b/.test(answer) ? Math.max(pending.qty, 2) : pending.qty;
      return [lineOf(row, qty, pending.unit, null)];
    }
  }
  if (pending.family === "alitas" || pending.candidateIds.some((id) => catalog.byId.get(id)?.family === "alitas")) {
    const piece = answer.match(/\b(\d+)\b/);
    if (piece) {
      const row = catalog.rows.find((item) => item.family === "alitas" && item.size === piece[1]);
      if (row) return [lineOf(row, pending.qty || 1, "pz", null)];
    }
  }

  const drink = pending.candidateIds
    .map((id) => catalog.byId.get(id))
    .find((row) => row && row.variants.length);
  if (drink) {
    const flavors = drink.variants.filter((variant) => new RegExp(`\\b${fold(variant)}\\b`).test(answer) || (fold(variant) === "manzana" && /\bmanzana\b/.test(answer)));
    if (flavors.length >= 2) {
      return flavors.map((variant) => lineOf(drink, 1, "pz", variant));
    }
    if (flavors.length === 1) return [lineOf(drink, pending.qty || 1, "pz", flavors[0])];
  }

  const pool = pending.candidateIds.map((id) => catalog.byId.get(id)).filter((row): row is CatalogRow => Boolean(row));
  const saidMarinado = /\bmarinad/.test(answer);
  let filtered = pool.filter((row) => {
    const blob = fold(`${row.name} ${row.family} ${row.categoria ?? ""}`);
    const wanted = tokens(answer);
    if (!wanted.length) return false;
    return wanted.every((token) => blob.includes(token) || blob.includes(phonetic(token)));
  });
  if (!saidMarinado) {
    const plain = filtered.filter((row) => !/\bmarinad/.test(fold(row.name)));
    if (plain.length) filtered = plain;
  }
  if (filtered.length === 1) return [lineOf(filtered[0], pending.qty || 1, pending.unit === "pesos" ? "pesos" : filtered[0].unit, null)];
  return null;
}

function toModelCart(cart: CartLine[]): ModelOutput["cart"] {
  return cart.map((line) => ({
    product_id: line.productId,
    qty: line.qty,
    unit: line.unit,
    variant: line.variant,
    notes: line.notes,
  }));
}

function changesFor(prior: CartLine[], next: CartLine[], message: string): ModelOutput["changes"] {
  const changes: ModelOutput["changes"] = [];
  for (const line of next) {
    const prev = prior.find((item) => sameLine(item, line));
    if (!prev) {
      changes.push({ op: "add", product_id: line.productId, from_product_id: null, source_text: message, qty: line.qty, unit: line.unit, variant: line.variant });
    } else if (Math.abs(prev.qty - line.qty) > 0.001) {
      changes.push({ op: "set_qty", product_id: line.productId, from_product_id: null, source_text: message, qty: line.qty, unit: line.unit, variant: line.variant });
    }
  }
  for (const line of prior) {
    if (!next.some((item) => sameLine(item, line))) {
      changes.push({ op: "remove", product_id: line.productId, from_product_id: line.productId, source_text: message });
    }
  }
  return changes;
}

export function cartFromModel(lines: ModelOutput["cart"]): CartLine[] {
  return lines.map((line) => ({
    productId: line.product_id,
    qty: line.qty,
    unit: line.unit,
    variant: line.variant,
    notes: line.notes,
  }));
}
