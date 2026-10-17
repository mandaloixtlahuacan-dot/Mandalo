import { foldAgent } from "@/lib/orderAgent/catalog";
import { synonymForms } from "@/lib/storeProductSearch";
import type { AgentLine, AgentProduct, AgentUnit } from "@/lib/orderAgent/types";

/**
 * El tamaño vive en el nombre (marca y presentación vienen vacías).
 * Sirve para ver si dos filas de verdad son distintas.
 */
export type NamePresentation = {
  key: string;
  pack: boolean;
  duo: boolean;
};

const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "y", "e", "o", "con", "sin", "para", "por", "al", "en", "lo", "su", "que",
  "se", "me", "te", "es", "son", "orden", "kilo", "kilos", "litro", "litros",
  "gramo", "gramos", "pieza", "piezas", "caja", "cajas", "paquete", "paquetes",
  "paq", "botella", "botellas", "lata", "latas", "bolsa", "bolsas", "medio",
  "media", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "quiero", "quisiera", "dame", "das", "deme", "traeme", "tambien", "despues", "luego",
  "perdon", "disculpa", "agrega", "agregame", "anota", "anotame", "porfa", "porfavor", "favor",
  "entonces", "recia", "reciona", "solo", "esta", "mala", "mal", "mas", "muy", "bien", "the",
]);

function wordsOf(value: string): string[] {
  return foldAgent(value).split(" ").filter(Boolean);
}

export function contentTokens(value: string): string[] {
  const head = String(value ?? "").replace(/\([^)]*\)/g, " ");
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of wordsOf(head)) {
    if (token.length < 3 || token.length > 40) continue;
    if (STOP.has(token) || /^\d+$/.test(token)) continue;
    if (/^(?:lts|lt|ltr|ltrs|gr|grs|mls|kgs)$/.test(token)) continue;
    if (/^\d+(?:[.,]\d+)?(?:ml|l|lt|lts|g|gr|kg|pz|paq)$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function presentationFromName(name: string): NamePresentation | null {
  const text = foldAgent(name);
  if (!text) return null;
  const duo = /\bduo\b/.test(text);
  const caja = /\b(cajas?|paquetes?|multipack|cj)\b/.test(text);
  const paq = text.match(/\b(\d+)\s*paq\b/);
  const slash = text.match(/\/\s*(\d+)\b/);
  const pieces = text.match(/\b(\d+)\s*pz\b/);
  const multiPieces = Boolean(pieces && Number(pieces[1]) > 1);
  const pack = caja || Boolean(paq) || Boolean(slash) || multiPieces;
  const ml = text.match(/(\d+(?:[.,]\d+)?)\s*ml\b/);
  const liters = text.match(/(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litros?)\b/);
  const kilos = text.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\b/);
  const grams = text.match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos?)\b/);
  const amount = (raw: string) => raw.replace(",", ".");
  if (pack) {
    if (paq) return { key: `${paq[1]}paq`, pack: true, duo };
    if (slash) return { key: `/${slash[1]}`, pack: true, duo };
    if (multiPieces && pieces) return { key: `${pieces[1]}pz`, pack: true, duo };
    return { key: caja ? "caja" : "paquete", pack: true, duo };
  }
  if (ml) return { key: `${amount(ml[1])}ml`, pack: false, duo };
  if (liters) return { key: `${amount(liters[1])}l`, pack: false, duo };
  if (kilos) return { key: `${amount(kilos[1])}kg`, pack: false, duo };
  if (grams) return { key: `${amount(grams[1])}g`, pack: false, duo };
  if (duo) return { key: "duo", pack: false, duo: true };
  return null;
}

export function differKey(product: Pick<AgentProduct, "name" | "presentation">): string {
  const column = foldAgent(product.presentation ?? "");
  if (column && column !== "pz" && column !== "pieza" && column !== "pza") return column;
  return presentationFromName(product.name)?.key ?? "";
}

export function isPackProduct(product: Pick<AgentProduct, "name" | "presentation">): boolean {
  const column = foldAgent(product.presentation ?? "");
  if (/\b(cajas?|paquetes?)\b/.test(column)) return true;
  return packInName(product);
}

/** «Caja Nito» o «15paq» en el nombre. La columna presentación no cuenta: ahí «paquete» es la unidad. */
export function packInName(product: Pick<AgentProduct, "name">): boolean {
  return presentationFromName(product.name)?.pack === true || /\b(cajas?|paquetes?|cj|paq)\b/.test(foldAgent(product.name));
}

export function isPieceCorrection(message: string): boolean {
  const text = foldAgent(message);
  return (/\bno es\b/.test(text) && /\bcaja\b/.test(text))
    || /\bsolo una pieza\b/.test(text)
    || /\bquiero una pieza\b/.test(text);
}

export function genericDogoMessage(message: string): boolean {
  const text = foldAgent(message);
  if (!/\b(dogos?|hotdogs?|jochos?|hot\s+dogs?)\b/.test(text)) return false;
  return !/\b(pollo|cuban\w*|hawaian\w*|camaron\w*|arrachera|clasic\w*|pizza|dori|burg(?:er|uer)\w*)\b/.test(text);
}

export function isClasicoDogo(product: Pick<AgentProduct, "name">): boolean {
  return /\bdogo clasico\b/.test(foldAgent(product.name));
}

function tokenIn(text: string, token: string): boolean {
  if (!token) return false;
  if (token === "dogo" || token === "dogos") {
    return /\b(dogos?|hotdogs?|jochos?|hot\s+dogs?)\b/.test(text);
  }
  if (token === "refresco" || token === "refrescos") {
    return /\b(refrescos?|pepsis?|cocas?|seven|mirinda|manzanitas?|manzanas?)\b/.test(text);
  }
  if (token === "cola" && /\bcocas?\b/.test(text)) return true;
  if (token === "coca" && /\bcolas?\b/.test(text)) return true;
  const stem = token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
  if (new RegExp(`\\b${stem}s?\\b`).test(text)) return true;
  return text.split(" ").some((word) => word.length >= 4 && (token.startsWith(word) || word.startsWith(token)));
}

function requiredTokens(name: string, message: string): string[] {
  const text = foldAgent(message);
  return contentTokens(name).filter((token) => {
    if (/^marinad/.test(token) && !/\bmarinad/.test(text)) return false;
    return true;
  });
}

function allTokensIn(name: string, message: string): boolean {
  const tokens = requiredTokens(name, message);
  if (!tokens.length) return false;
  const text = foldAgent(message);
  return tokens.every((token) => tokenIn(text, token));
}

function messageHasExtraType(message: string, product: Pick<AgentProduct, "name">): boolean {
  const text = foldAgent(message);
  const name = foldAgent(product.name);
  const extras = ["pollo", "gajo", "francesa", "cuban", "hawaian", "camaron", "arrachera", "duo", "funk", "malteada"];
  return extras.some((token) => new RegExp(`\\b${token}`).test(text) && !name.includes(token));
}

/** La única fila de la búsqueda comparte una palabra con el cliente («una botana» → Botana Completa). */
export function uniqueHitMentioned(product: AgentProduct, message: string): boolean {
  const text = foldAgent(productClause(message, product.name));
  return contentTokens(product.name).some((token) => tokenIn(text, token));
}

/** Todas las palabras que distinguen el producto, o un sinónimo. No basta una. */
export function productMentionedStrict(message: string, product: AgentProduct): boolean {
  if (!message.trim()) return false;
  const clause = productClause(message, product.name);
  if (genericDogoMessage(clause) && isClasicoDogo(product)) return true;
  if (allTokensIn(product.name, clause) && !messageHasExtraType(clause, product)) return true;
  const labels = [product.brand ?? "", ...(product.alias ?? [])];
  for (const label of labels) {
    const tokens = contentTokens(label);
    if (!tokens.length) continue;
    if (!tokens.every((token) => tokenIn(foldAgent(clause), token))) continue;
    if (messageHasExtraType(clause, product)) continue;
    return true;
  }
  return false;
}

function cutKey(name: string): string {
  return foldAgent(name).replace(/\bmarinad[oa]s?\b/g, " ").replace(/\s+/g, " ").trim();
}

export function marinadeUnresolved(product: Pick<AgentProduct, "name">, pool: Array<Pick<AgentProduct, "name">>, message: string): boolean {
  const text = foldAgent(message);
  if (/\bmarinad/.test(text) || /\b(normal|natural|sin marinar)\b/.test(text)) return false;
  const key = cutKey(product.name);
  if (!key) return false;
  const family = pool.filter((row) => cutKey(row.name) === key);
  const seasoned = family.some((row) => /\bmarinad/.test(foldAgent(row.name)));
  const plain = family.some((row) => !/\bmarinad/.test(foldAgent(row.name)));
  return seasoned && plain;
}

function sharesMessageToken(product: { name: string; brand?: string | null }, message: string): boolean {
  const text = foldAgent(message);
  if (contentTokens(product.name).some((token) => tokenIn(text, token))) return true;
  const brand = foldAgent(product.brand ?? "");
  return Boolean(brand) && (text.includes(brand) || contentTokens(brand).some((token) => tokenIn(text, token)));
}

/** El pedazo del mensaje que mejor nombra este producto, no el pedido completo. */
export function productClause(message: string, productName: string): string {
  let best = "";
  let bestScore = 0;
  for (const part of orderClauses(message)) {
    const text = foldAgent(part);
    const tokens = contentTokens(productName);
    const matched = tokens.filter((token) => tokenIn(text, token));
    let score = matched.length;
    if (tokens[0] && matched.includes(tokens[0])) score += 2;
    if (score > bestScore) {
      best = part;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : message;
}

function distinctiveHit(product: AgentProduct, family: AgentProduct[], message: string): boolean {
  const text = foldAgent(message);
  const mine = contentTokens(product.name);
  const onlyMine = mine.filter((token) => family.some((other) => other.id !== product.id && !contentTokens(other.name).includes(token)));
  if (onlyMine.some((token) => tokenIn(text, token))) return true;
  const parsed = presentationFromName(product.name);
  if (!parsed) return false;
  const number = parsed.key.match(/^(\d+(?:\.\d+)?)(ml|l|g|kg|paq)/);
  if (!number) return text.includes(parsed.key);
  const n = number[1];
  const unit = number[2];
  if (unit === "ml") return new RegExp(`\\b${n}\\s*ml\\b`).test(text);
  if (unit === "l") return new RegExp(`\\b${n}\\s*(l|lt|lts|litros?)\\b`).test(text);
  if (unit === "kg") return new RegExp(`\\b${n}\\s*(kg|kilos?)\\b`).test(text);
  if (unit === "g") return new RegExp(`\\b${n}\\s*(g|gr|gramos?)\\b`).test(text);
  return text.includes(n);
}

function spokenKilo(text: string): boolean {
  return /\b(kilo|kilos|kg)\b/.test(text);
}

const SIZE_WORD = new Set(["lts", "lt", "ltr", "ltrs", "gr", "grs", "mls", "kgs"]);

/** Tamaño de empaque dicho por el cliente: «2 litros», «2 l», «62 g». El kilo suelto es cantidad. */
export function spokenPackageSize(text: string): string | null {
  const folded = foldAgent(text);
  const ml = folded.match(/\b(\d+(?:[.,]\d+)?)\s*ml\b/);
  if (ml) return `${ml[1].replace(",", ".")}ml`;
  const liters = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litros?)\b/);
  if (liters) return `${liters[1].replace(",", ".")}l`;
  const grams = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos?)\b/);
  if (grams) return `${grams[1].replace(",", ".")}g`;
  const bare = folded.match(/\b(?:de\s+)?(\d{3,4})\b/);
  if (bare && Number(bare[1]) >= 100) return `${bare[1]}ml`;
  return null;
}

function hasKilo(product: Pick<AgentProduct, "name" | "presentation">): boolean {
  return /\b(kg|kilos?)\b/.test(foldAgent(`${product.presentation ?? ""} ${product.name}`));
}

function brandOk(product: AgentProduct, text: string): boolean {
  const brand = foldAgent(product.brand ?? "");
  if (!brand) return true;
  return text.includes(brand);
}

function mostSpecific(hits: AgentProduct[], message: string): AgentProduct[] {
  return hits.filter((row) => {
    const mine = requiredTokens(row.name, message);
    return !hits.some((other) => {
      if (other.id === row.id) return false;
      const theirs = requiredTokens(other.name, message);
      return mine.length < theirs.length && mine.every((token) => theirs.includes(token));
    });
  });
}

/**
 * Una sola fila del resultado. Caja contra pieza siempre pregunta,
 * salvo que el cliente haya dicho caja o paquete.
 */
export function messageSelectsProduct(product: AgentProduct, siblings: AgentProduct[], message: string): boolean {
  const clause = productClause(message, product.name);
  const text = foldAgent(clause);
  const piece = isPieceCorrection(message);
  const saidPack = !piece && /\b(cajas?|paquetes?)\b/.test(text);
  const family = siblings.filter((row) => sharesMessageToken(row, message) || row.id === product.id);
  if (genericDogoMessage(message) && isClasicoDogo(product)) return true;
  if (saidPack) {
    const packs = family.filter((row) => isPackProduct(row));
    return packs.length === 1 && packs[0].id === product.id;
  }
  if (piece) {
    const singles = family.filter((row) => !isPackProduct(row) && !presentationFromName(row.name)?.duo);
    const measured = singles.filter((row) => Boolean(presentationFromName(row.name)?.key));
    const pick = measured.length ? measured : singles;
    return pick.length === 1 && pick[0].id === product.id;
  }
  // Caja o paquete solo si el cliente lo dijo. Si la pieza no vino en esta
  // ventana (el SQL de prod ordena Caja Nito antes que Nito 62g), no se elige.
  if (packInName(product)) return false;
  const wanted = spokenPackageSize(text);
  if (wanted) {
    const sized = family.filter((row) => {
      if (isPackProduct(row)) return false;
      if (presentationFromName(row.name)?.key !== wanted) return false;
      const extras = contentTokens(row.name).filter((token) => !SIZE_WORD.has(token) && !tokenIn(text, token));
      return extras.length === 0;
    });
    if (sized.length === 1) return sized[0].id === product.id;
    if (sized.length > 1) return false;
  }
  if (spokenKilo(text)) {
    const kilos = family.filter((row) => hasKilo(row));
    if (kilos.length === 1) return kilos[0].id === product.id;
  }
  const keys = new Set(family.map((row) => differKey(row)).filter(Boolean));
  const named = family.filter((row) => distinctiveHit(row, family, clause));
  if (named.length === 1) return named[0].id === product.id && brandOk(named[0], text);
  const brandHits = family.filter((row) => {
    const brand = foldAgent(row.brand ?? "");
    return Boolean(brand) && text.includes(brand);
  });
  if ((keys.size > 1 || (family.some((row) => isPackProduct(row)) && family.some((row) => !isPackProduct(row)))) && named.length !== 1) {
    if (brandHits.length === 1) return brandHits[0].id === product.id;
    return false;
  }
  let hits = family.filter((row) => {
    if (!saidPack && isPackProduct(row) && family.some((other) => !isPackProduct(other))) return false;
    const namedOk = allTokensIn(row.name, clause) && !messageHasExtraType(clause, row);
    const brand = foldAgent(row.brand ?? "");
    const brandHit = Boolean(brand) && text.includes(brand);
    if (!namedOk && !brandHit) return false;
    if (!brandOk(row, text)) return false;
    return true;
  });
  hits = mostSpecific(hits, clause);
  return hits.length === 1 && hits[0].id === product.id;
}

export function optionsLookDifferent(products: AgentProduct[]): boolean {
  if (products.length <= 1) return false;
  const brands = new Set(products.map((product) => foldAgent(product.brand ?? "")).filter(Boolean));
  const keys = new Set(products.map((product) => differKey(product)).filter(Boolean));
  if (brands.size > 1 || keys.size > 1) return true;
  if (products.some((product) => isPackProduct(product)) && products.some((product) => !isPackProduct(product))) return true;
  const seasoned = products.some((product) => /\bmarinad/.test(foldAgent(product.name)));
  const plain = products.some((product) => !/\bmarinad/.test(foldAgent(product.name)));
  if (seasoned && plain && new Set(products.map((product) => cutKey(product.name))).size < products.length) return true;
  const names = new Set(products.map((product) => foldAgent(product.name.replace(/\([^)]*\)/g, " "))));
  return names.size > 1;
}

export function variantFromMessage(variants: string[], message: string): string | null {
  const text = foldAgent(message);
  const forms = new Set<string>();
  for (const token of text.split(" ")) {
    forms.add(token);
    for (const form of synonymForms(token)) forms.add(form);
  }
  for (const variant of variants) {
    const key = foldAgent(variant);
    if (!key) continue;
    if (key === "manzana" && /\bmanzanitas?\b/.test(text)) return variant;
    if (new RegExp(`\\b${key}s?\\b`).test(text)) return variant;
    if (forms.has(key)) return variant;
  }
  return null;
}

const WORD_QTY: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  medio: 0.5, media: 0.5,
};

export function spokenMeasure(message: string, productName: string): { qty: number; unit: AgentUnit } | null {
  const clause = productClause(message, productName);
  const folded = foldAgent(clause);
  const money = clause.match(/\$\s*(\d+(?:[.,]\d+)?)/) ?? folded.match(/\b(\d+(?:[.,]\d+)?)\s*pesos\b/);
  if (money && sharesMessageToken({ name: productName }, clause)) {
    const raw = (money[1] || "").replace(",", ".");
    const qty = Number(raw);
    if (qty > 0) return { qty, unit: "pesos" };
  }
  const tokens = folded.split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const unitWord = tokens[index] ?? "";
    const prev = tokens[index - 1] ?? "";
    const qty = WORD_QTY[prev] ?? (Number(prev) > 0 ? Number(prev) : 1);
    if (/\b(kilos?|kg)\b/.test(unitWord)) return { qty, unit: "kg" };
    if (/\b(litros?|lts?)\b/.test(unitWord)) return { qty, unit: "l" };
  }
  return null;
}

export function replacementLineId(cart: AgentLine[], product: AgentProduct, message: string): string | null {
  if (!isPieceCorrection(message)) return null;
  const mine = new Set(contentTokens(product.name));
  const line = cart.find((item) => {
    if (item.productId === product.id) return false;
    return contentTokens(item.name).some((token) => mine.has(token));
  });
  return line?.lineId ?? null;
}

const CLAUSE_SPLIT = new RegExp(
  [
    "\\s*(?:,|;|\\btambi[eé]n\\b|\\bdespu[eé]s\\b|\\bluego\\b|\\by\\b|\\be\\b)\\s*",
    "\\s+(?=\\d+(?:[.,]\\d+)?\\s+(?:(?:kg|kilos?|l|lt|lts|litros?|g|gr|gramos?)\\s+de\\s+[a-zñ]|(?!(?:ml|l|lt|lts|litros?|g|gr|gramos?|kg|kilos?)\\b)[a-zñ]{3,}))",
    "\\s+(?=(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|medio|media)\\b)",
  ].join("|"),
  "i",
);

export function orderClauses(message: string): string[] {
  const parts = String(message ?? "")
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => contentTokens(part).length > 0);
  const merged: string[] = [];
  for (const part of parts) {
    const text = foldAgent(part);
    const continues = /^(?:de\b|recia\b|reciona\b|grande\b|chica\b|chico\b|marinad|una recia|un recio|una grande|una chica)/.test(text);
    if (merged.length && continues) merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
    else merged.push(part);
  }
  return merged;
}

/** Palabras de categoría. «galletas marías» ya está cubierto si el carrito trae marías. */
const CATEGORY_WORD = new Set([
  "galleta", "galletas", "pan", "panes", "agua", "aguas", "leche", "leches",
  "jabon", "jabones", "refresco", "refrescos", "jugo", "jugos", "papel",
  "carne", "huevo", "huevos", "arroz", "botella", "bolsa", "menta", "mentas",
  "dulce", "dulces", "botana", "botanas",
]);

function subjectTokens(clause: string): string[] {
  const tokens = contentTokens(clause);
  const specific = tokens.filter((token) => !CATEGORY_WORD.has(token));
  return specific.length ? specific : tokens;
}

function tokensCovered(tokens: string[], blob: string): boolean {
  if (!tokens.length) return true;
  const short = tokens.every((token) => token.length < 4);
  if (short) {
    return tokens.every((token) => blob.split(" ").some((word) => word.endsWith(token) || word.startsWith(token)));
  }
  return tokens.filter((token) => token.length >= 4).every((token) => tokenInLoose(blob, token));
}

function tokenInLoose(text: string, token: string): boolean {
  if (tokenIn(text, token)) return true;
  for (const form of synonymForms(token)) {
    if (form !== token && tokenIn(text, form)) return true;
  }
  return false;
}

/** La línea responde a esta búsqueda. Un Fuzetea no se borra por una pregunta de frijol. */
export function lineMatchesQuery(name: string, query: string): boolean {
  const tokens = subjectTokens(query);
  if (!tokens.length) return true;
  return tokensCovered(tokens, foldAgent(name));
}

function clauseCovered(clause: string, blob: string): boolean {
  const text = foldAgent(clause);
  if (/\b(dogos?|hotdogs?|jochos?|hot\s+dogs?)\b/.test(text) && /\bdogo\b/.test(blob)) {
    const type = text.match(/\b(pollo|cuban\w*|hawaian\w*|camaron\w*|arrachera|clasic\w*|pizza|dori|burg(?:er|uer)\w*)\b/);
    if (!type) return true;
    const stem = type[1].replace(/s$/, "").replace(/es$/, "");
    return blob.includes(stem);
  }
  const flavor = text.match(/\b(pepesi|pepe|pepsis?|cocas?|seven|mirinda|manzanitas?|manzanas?)\b/);
  if (flavor && /\b(refresco|pepsi|coca|seven|mirinda|manzana)\b/.test(blob)) {
    const stem = flavor[1].replace(/itas?$/, "a").replace(/s$/, "");
    const key = stem.startsWith("manzan") ? "manzana" : stem;
    return blob.includes(key);
  }
  return tokensCovered(subjectTokens(clause), blob);
}

/** Lo que el cliente pidió y no está en el carrito ni en la pregunta. */
export function uncoveredClauses(message: string, cart: AgentLine[], coveredText: string): string[] {
  const blob = foldAgent([
    coveredText,
    ...cart.map((line) => `${line.name} ${line.variant ?? ""} ${line.brand ?? ""} ${line.freeText ?? ""}`),
  ].join(" "));
  return orderClauses(message).filter((clause) => !clauseCovered(clause, blob));
}

export function answerMatchesPresentation(message: string, product: Pick<AgentProduct, "name" | "presentation">): boolean {
  const text = foldAgent(message);
  if (/\b(cajas?|paquetes?)\b/.test(text) && isPackProduct(product)) return true;
  if (/\bpieza\b/.test(text) && !isPackProduct(product) && !presentationFromName(product.name)?.duo) return true;
  if (/\bduo\b/.test(text) && /\bduo\b/.test(foldAgent(product.name))) return true;
  const parsed = presentationFromName(product.name);
  if (!parsed) return false;
  return distinctiveHit(
    { ...product, id: 0, price: null, available: true, unit: "pz", variants: [], brand: null, alias: [], category: null },
    [],
    message,
  ) || text.includes(parsed.key);
}
