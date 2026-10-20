import { foldAgent } from "@/lib/orderAgent/catalog";
import { listaWordHit, normalizeMeasureWords, normalizeVoice, synonymForms } from "@/lib/storeProductSearch";
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
  "cajita", "cajitas", "latita", "latitas", "bolsita", "bolsitas",
  "paquetito", "paquetitos", "botellita", "botellitas",
  "perdon", "disculpa", "agrega", "agregame", "anota", "anotame", "porfa", "porfavor", "favor",
  "entonces", "recia", "reciona", "solo", "esta", "mala", "mal", "mas", "muy", "bien", "the",
  "otro", "otra", "otros", "otras", "debes", "dejaste", "falta", "faltan", "refiero",
  "pedir", "pedido", "caro", "cara", "peso", "pesos",
]);

function wordsOf(value: string): string[] {
  return foldAgent(value).split(" ").filter(Boolean);
}

const SIZE_TOKEN = new Set(["cuarto", "cuartos", "8oz", "250ml", "500ml", "litro", "litros"]);

/** Cómo viene el producto. No es otro producto: «Lala entera» sigue siendo Lala. */
const VARIANT_WORD = new Set([
  "entera", "enteras", "entero", "enteros", "deslactosada", "deslactosado",
  "light", "diet", "semidescremada", "descremada", "natural", "original",
  "clasica", "clasico", "adobada", "adobado",
]);

/** El sustantivo del producto. Empaque, cantidad y «con tapa» no cuentan. */
export function productTypeTokens(clause: string): string[] {
  const folded = foldAgent(normalizeMeasureWords(clause))
    .replace(/\bsin sabor\b/g, " ")
    .replace(/\bcon\s+(?:tapitas?|tapas?|popotes?)\b/g, " ");
  const tokens = contentTokens(folded).filter((token) => !SIZE_TOKEN.has(token));
  const withoutVariant = tokens.filter((token) => !VARIANT_WORD.has(token));
  const base = withoutVariant.length ? withoutVariant : tokens;
  const specific = base.filter((token) => !CATEGORY_WORD.has(token));
  return specific.length ? specific : base;
}

export function contentTokens(value: string): string[] {
  const head = String(value ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bsin\s+(?!el\b|la\b|los\b|las\b|eso\b|ese\b|esa\b|ello\b)[a-záéíóúüñ]+/gi, " ");
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
  // «caja» o «para» solas sí nombran producto. «quiero» no. En «caja de nito» siguen siendo empaque.
  // «no es una caja, solo una pieza» no: ahí caja es la corrección, no el pedido.
  if (!tokens.length) {
    const filler = new Set([
      "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
      "quiero", "quisiera", "dame", "deme", "traeme", "porfa", "porfavor", "favor", "por",
      "me", "te", "se",
    ]);
    const rest = wordsOf(head).filter((token) => !filler.has(token));
    if (rest.length === 1 && /^(?:cajas?|bolsas?|paquetes?|para)$/.test(rest[0])) tokens.push(rest[0]);
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
  // «2.5 Lt» se pliega a «2 5 lt». Es 2.5 litros, no 5.
  const decimalLiters = text.match(/\b([1-9])\s+(\d)\s*(?:l|lt|lts|litros?)\b/);
  if (decimalLiters) return { key: `${decimalLiters[1]}.${decimalLiters[2]}l`, pack: false, duo };
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

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) grid[i][0] = i;
  for (let j = 0; j < cols; j += 1) grid[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      grid[i][j] = Math.min(grid[i - 1][j] + 1, grid[i][j - 1] + 1, grid[i - 1][j - 1] + cost);
    }
  }
  return grid[left.length][right.length];
}

/** Una letra de más, de menos o cambiada. «mary» llega a «mar»; «tiera» a «tierra». */
function tokenSlip(word: string, token: string): boolean {
  if (!word || !token || word[0] !== token[0]) return false;
  if (word.length < 3 || token.length < 3) return false;
  if (word.startsWith(token) && word.length - token.length === 1) return true;
  if (token.startsWith(word) && token.length - word.length === 1) return true;
  // Una letra cambiada solo en palabras de 5 o más. «coca»/«cola» no se confunden.
  if (Math.min(word.length, token.length) < 5) return false;
  if (Math.abs(word.length - token.length) > 1) return false;
  return editDistance(word, token) <= 1;
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
  // «lecheras» no está cubierto por «leche»: el pedazo corto no cuenta.
  // Sí cuenta el diminutivo (vasitos / vaso), un plural corto o un dedo (mary / mar).
  return text.split(" ").some((word) => {
    if (tokenSlip(word, token) || tokenSlip(word, stem)) return true;
    if (word.length < 4 || token.length < 4) return false;
    if (word.startsWith(token) && word.length - token.length <= 3) return true;
    if (!token.startsWith(word)) return false;
    const rest = token.slice(word.length);
    return rest.length > 0 && rest.length <= 4 && /^(?:s|es|ito|ita|itos|itas)$/.test(rest);
  });
}

/** Para el resto del pedido: la palabra del cliente cabe en el nombre, con un dedo de margen. */
export function tokenMatches(text: string, token: string): boolean {
  return tokenIn(foldAgent(text), foldAgent(token));
}

const OPTIONAL_PRODUCT_WORD = /^(?:rayad|rallad|chic[ao]s?|grandes?|enter[ao]s?|lights?|naturals?|integrals?|deslactosad|descremad|semidescremad)/;

function requiredTokens(name: string, message: string): string[] {
  const text = foldAgent(message);
  return contentTokens(name).filter((token) => {
    if (/^marinad/.test(token) && !/\bmarinad/.test(text)) return false;
    // «rayado», «chica» o «grande» eligen entre opciones. No hacen falta para reconocer el producto.
    if (OPTIONAL_PRODUCT_WORD.test(token) && !tokenIn(text, token)) return false;
    return true;
  });
}

/** Lo que va después de «de», una vez que ya hubo un sustantivo: «tortillas de maíz». */
export function trailingQualifiers(clause: string): Set<string> {
  const words = foldAgent(clause).split(" ").filter(Boolean);
  const qual = new Set<string>();
  const measure = new Set(["kg", "kilo", "kilos", "litro", "litros", "lt", "lts", "gramo", "gramos", "gr", "ml", "pieza", "piezas"]);
  let seenNoun = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.length >= 4 && !measure.has(word)) seenNoun = true;
    if (!seenNoun || (word !== "de" && word !== "del")) continue;
    const next = words[index + 1] ?? "";
    if (next.length < 3) continue;
    qual.add(next);
    if (next.endsWith("s") && next.length > 4) qual.add(next.slice(0, -1));
  }
  return qual;
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
  if (foldCatalogName(product.name) === catalogAsk(message) || foldCatalogName(product.name) === foldCatalogName(message)) return true;
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

function sharesMessageToken(product: { name: string; brand?: string | null }, message: string, loose = false): boolean {
  const text = foldAgent(message);
  if (contentTokens(product.name).some((token) => tokenIn(text, token))) return true;
  // «naranja» también está en «naranjada». Si no, la familia se queda en un solo nombre.
  const said = contentTokens(text).filter((token) => token.length >= 6);
  const words = foldAgent(product.name).split(" ").filter(Boolean);
  if (loose && said.some((token) => words.some((word) => word.startsWith(token) && word.length - token.length <= 3))) return true;
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
  const onlyMine = mine.filter((token) => {
    const stem = token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
    return !family.some((other) => {
      if (other.id === product.id) return false;
      const words = contentTokens(other.name);
    return words.includes(token) || words.includes(stem) || words.some((word) => word.startsWith(token) && word.length - token.length <= 3 && token.length >= 6);
  });
  });
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

/** Tamaño de empaque dicho por el cliente: «2 litros», «2 l», «62 g», «cuarto». El kilo suelto es cantidad. */
export function spokenPackageSize(text: string): string | null {
  const folded = foldAgent(normalizeMeasureWords(text));
  const household = !/\b(?:jamon|kilo|kilos|kg|gramo|gramos)\b/.test(folded);
  if (household && /\b(?:cuartos?|8oz|250ml)\b/.test(folded)) return "250ml";
  const halfMore = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litros?)\s+y\s+medio\b/);
  if (halfMore) {
    const base = Number(halfMore[1].replace(",", "."));
    if (base > 0) return `${base + 0.5}l`;
  }
  if (/\bmedio\b/.test(folded) && /\blitros?\b/.test(folded)) return "500ml";
  if (/\b500ml\b/.test(folded)) return "500ml";
  // «1.5 lt» se pliega a «1 5 lt». No es 5 litros.
  const decimalLiters = folded.match(/\b([1-9])\s+(\d)\s*(?:l|lt|lts|litros?)\b/);
  if (decimalLiters) return `${decimalLiters[1]}.${decimalLiters[2]}l`;
  const ml = folded.match(/\b(\d+(?:[.,]\d+)?)\s*ml\b/);
  if (ml) return `${ml[1].replace(",", ".")}ml`;
  const liters = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litros?)\b/);
  if (liters) return `${liters[1].replace(",", ".")}l`;
  const grams = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos?)\b/);
  if (grams) return `${grams[1].replace(",", ".")}g`;
  // «coca 600» es 600 ml. «100 toallas» no: el número es la presentación, no mililitros.
  const bare = folded.match(/\b(?:de\s+)?(\d{3,4})\b(?!\s*(?:toallas?|servilletas?|hojas?|rollos?|pz|pzas?|piezas?|paq|paquetes?))/);
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
export function messageSelectsProduct(product: AgentProduct, siblings: AgentProduct[], message: string, loose = false): boolean {
  const wholeName = foldCatalogName(message);
  const whole = foldCatalogName(product.name) === wholeName ? wholeName : catalogAsk(message);
  if (whole && foldCatalogName(product.name) === whole) {
    const same = siblings.filter((row) => foldCatalogName(row.name) === whole);
    const longer = siblings.some((row) => row.id !== product.id && foldCatalogName(row.name).startsWith(`${whole} `));
    if (longer || same.length !== 1) return false;
    // «aguacate» es el nombre exacto y también está en cremas y aceites. Se pregunta.
    if (!whole.includes(" ")) {
      const cousins = siblings.filter((row) => row.id !== product.id && foldAgent(row.name).split(" ").includes(whole));
      if (cousins.length >= 2) return false;
    }
    return same[0].id === product.id;
  }
  const said = catalogAsk(productClause(message, product.name));
  if (said && foldCatalogName(product.name) === said) {
    const same = siblings.filter((row) => foldCatalogName(row.name) === said);
    const longer = siblings.some((row) => row.id !== product.id && foldCatalogName(row.name).startsWith(`${said} `));
    if (!longer && same.length === 1) return same[0].id === product.id;
  }
  const clause = productClause(message, product.name);
  const text = foldAgent(clause);
  const piece = isPieceCorrection(message);
  const saidPack = !piece && /\b(cajas?|paquetes?)\b/.test(text);
  const family = siblings.filter((row) => sharesMessageToken(row, message, loose) || row.id === product.id);
  if (genericDogoMessage(message) && isClasicoDogo(product)) return true;
  if (saidPack) {
    // «un paquete de aguas» no elige la única caja de la ventana: faltan marca y tamaño.
    const asked = productTypeTokens(clause);
    const generic = asked.length > 0 && asked.every((token) => CATEGORY_WORD.has(token));
    if (generic) return false;
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
  // «sanitas» no se queda en Sanitas si también existe «Sanitas 100 Toallas».
  // Nito 62g sí: lo que sobra es el tamaño, no otra presentación.
  if (hits.length === 1 && longerRealName(hits[0], family)) return false;
  // «menta» no se queda en «Mentas Menta» solo porque el plural cabe en la frase.
  if (hits.length === 1) {
    const asked = contentTokens(clause).filter((token) => token.length >= 4);
    const words = contentTokens(hits[0].name);
    const pluralOnly = words.filter((token) => asked.some((word) => token === `${word}s` && token !== word));
    const extras = words.filter((token) => !asked.some((word) => token === word || token === `${word}s` || word === `${token}s`));
    const crowd = family.filter((row) => asked.length > 0 && asked.every((token) => tokenIn(foldAgent(row.name), token)));
    if (pluralOnly.length > 0 && extras.length === 0 && crowd.length > 1) return false;
  }
  // «marlboro» no se queda en Marlboro 100 porque los demás traen un sabor de más.
  // «coca 600» ya se resolvió arriba, con el tamaño.
  if (loose && hits.length === 1) {
    const asked = contentTokens(clause).filter((token) => token.length >= 4);
    const crowd = family.filter((row) => asked.length === 1 && asked.every((token) => tokenIn(foldAgent(row.name), token)));
    if (crowd.length > 1) return false;
  }
  return hits.length === 1 && hits[0].id === product.id;
}

/** El nombre es el principio de otro producto real («Sanitas» → «Sanitas 100 Toallas»). */
function longerRealName(product: AgentProduct, family: AgentProduct[]): boolean {
  const name = foldAgent(product.name);
  if (!name) return false;
  return family.some((other) => {
    if (other.id === product.id) return false;
    const extra = foldAgent(other.name);
    if (!extra.startsWith(`${name} `)) return false;
    const rest = extra.slice(name.length).trim().split(/\s+/).filter(Boolean);
    return rest.some((word) => word.length >= 3 && !SIZE_OR_MODIFIER.test(word));
  });
}

const SIZE_OR_MODIFIER = /^(?:\d+(?:[.,]\d+)?(?:ml|l|lt|lts|g|gr|kg|pz|paq)?|funk|duo|hotkis|cherry|zero|light|diet|retornable|retornble|malteada|marinad[oa]s?)$/;

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
  const raw = foldAgent(message);
  const text = foldAgent(normalizeVoice(message));
  const forms = new Set<string>();
  for (const token of text.split(" ")) {
    forms.add(token);
    for (const form of synonymForms(token)) forms.add(form);
  }
  for (const variant of variants) {
    const key = foldAgent(variant);
    if (!key) continue;
    if (key === "manzana" && /\b(?:manzanitas?|sidral(?:\s+mundet)?)\b/.test(raw)) return variant;
    if (key === "seven" && /\b7\s*ups?\b/.test(raw)) return variant;
    if (key === "mirinda" && /\b(?:mirandas?|meriendas?)\b/.test(raw)) return variant;
    if (new RegExp(`\\b${key}s?\\b`).test(text)) return variant;
    if (forms.has(key)) return variant;
  }
  for (const variant of variants) {
    const key = foldAgent(variant);
    if (key.length < 4) continue;
    if (text.split(" ").some((word) => word.length >= 4 && listaWordHit(word, key))) return variant;
  }
  return null;
}

const WORD_QTY: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  medio: 0.5, media: 0.5,
};

export function spokenMeasure(message: string, productName: string): { qty: number; unit: AgentUnit } | null {
  const clauses = orderClauses(message);
  let clause = "";
  if (productName.trim()) {
    const best = productClause(message, productName);
    if (clauses.length > 1 && (best === message || !clauses.includes(best))) return null;
    clause = best;
  } else {
    const measured = clauses.filter((part) => /\b(kilos?|kg|litros?|lts?|pesos)\b|\$\s*\d/.test(foldAgent(part)));
    if (measured.length !== 1) return null;
    clause = measured[0];
  }
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
    // «2 l y medio» es 2.5, no otro producto.
    "\\s*(?:,|;|\\btambi[eé]n\\b|\\bdespu[eé]s\\b|\\bluego\\b|\\by\\b(?!\\s+medio\\b(?!\\s+kilos?\\b))|\\be\\b)\\s*",
    // «4 caja» y «24 pzas» son presentación, no otro producto.
    "\\s+(?=\\d+(?:[.,]\\d+)?\\s+(?:(?:kg|kilos?|l|lt|lts|litros?|g|gr|gramos?)\\s+de\\s+[a-zñ]|(?!(?:ml|l|lt|lts|litros?|g|gr|gramos?|kg|kilos?|cajas?|pzas?|piezas?|paquetes?|paq|packs?|cj|rollos?|latas?|bolsas?|botellas?|sobres?)\\b)[a-zñ]{3,}))",
    "(?<!\\bde)\\s+(?=(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\b|(?<!\\by\\s)(?:medio|media)\\b)",
  ].join("|"),
  "i",
);

const QTY_ONLY = /^(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|medio|media|\d+)\.?$/;

/**
 * Marcas de varias palabras. Una coma o un apóstrofe no las parte:
 * «member, Mark» y «Member's Mark» son la misma marca.
 */
const MULTI_WORD_BRANDS: string[][] = [
  ["members", "mark"],
  ["costa", "brava"],
  ["tres", "regiones"],
  ["great", "value"],
  ["sello", "rojo"],
  ["santa", "clara"],
  ["la", "costena"],
  ["del", "monte"],
];

function normalizeBrandText(message: string): string {
  return String(message ?? "")
    .replace(/\bmember['’´`]s\b/gi, "Members")
    .replace(/\bmembers\s+marck\b/gi, "Members Mark")
    .replace(/\bmemberrs\b/gi, "Members");
}

function brandWords(part: string): string[] {
  return foldAgent(normalizeBrandText(part))
    .replace(/\bmember\b/g, "members")
    .split(" ")
    .filter(Boolean);
}

function glueBrandParts(parts: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < parts.length) {
    const left = brandWords(parts[index]);
    const right = index + 1 < parts.length ? brandWords(parts[index + 1]) : [];
    const pair = left.length === 1 && right.length >= 1 ? [left[0], right[0]] : [];
    const brand = MULTI_WORD_BRANDS.find((row) => row[0] === pair[0] && row[1] === pair[1]);
    if (brand && right.length === 1) {
      out.push(`${parts[index]} ${parts[index + 1]}`);
      index += 2;
      continue;
    }
    out.push(parts[index]);
    index += 1;
  }
  return out;
}

function isPureBrand(part: string): boolean {
  const words = brandWords(part);
  return MULTI_WORD_BRANDS.some((brand) => brand.length === words.length && brand.every((word, index) => word === words[index]));
}

/** «aguas, Members Mark» es el agua de esa marca, no un segundo producto. */
function attachBrandToPrevious(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1] ?? "";
    const category = /\b(aguas?|leches?|refrescos?|jugos?|galletas?|papeles?|jabones?|tortillas?)\b/.test(foldAgent(previous));
    if (isPureBrand(part) && category) {
      out[out.length - 1] = `${previous} ${part}`;
      continue;
    }
    out.push(part);
  }
  return out;
}

function finishClauses(parts: string[]): string[] {
  return attachBrandToPrevious(glueBrandParts(parts));
}

const QTY_PART = /^(?:(?:agrega|agregame|anade|anademe|pon|ponme|suma|tambien)\s+)*(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|medio|media|\d+)$/;

function attachLooseQty(parts: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const folded = foldAgent(parts[index] ?? "");
    if (QTY_PART.test(folded) && index + 1 < parts.length) {
      const qty = folded.replace(/^(?:(?:agrega|agregame|anade|anademe|pon|ponme|suma|tambien)\s+)+/, "");
      parts[index + 1] = `${qty} ${parts[index + 1]}`;
      continue;
    }
    out.push(parts[index] ?? "");
  }
  return out;
}

function rewriteMenuPhrases(message: string): string {
  return String(message ?? "")
    .replace(/\b(?:una\s+)?orden\s+de\s+dos\s+de\s+queso\b/gi, "dedos de queso")
    .replace(/\bdos\s+de\s+queso\b(?!\s+(?:oaxaca|panela|cottage|crema|manchego|amarillo|gouda|parmesano|fresco|asadero|chedar|cheddar))/gi, "dedos de queso");
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** «mar y tierra» del catálogo no se parte en dos productos. */
export function conjunctionPhrases(names: string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const folded = foldAgent(name);
    const re = /\b([a-zñ]{3,})\s+y\s+([a-zñ]{3,})\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(folded))) found.add(`${match[1]} y ${match[2]}`);
  }
  return [...found];
}

function shieldConjunctions(message: string, phrases?: string[]): string {
  if (!phrases?.length) return message;
  let text = message;
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    const parts = phrase.split(" y ");
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const re = new RegExp(`\\b${escapeReg(parts[0])}\\s+y\\s+${escapeReg(parts[1])}\\b`, "gi");
    text = text.replace(re, `${parts[0]} & ${parts[1]}`);
  }
  return text;
}

function restoreConjunctions(clause: string): string {
  return clause.replace(/\s+&\s+/g, " y ");
}

/** «sin verdura» es una nota del producto, no otro producto. */
export function asideNote(text: string): string | null {
  const match = foldAgent(text).match(/\bsin\s+(?!el\b|la\b|los\b|las\b|eso\b|ese\b|esa\b|ello\b)([a-zñ]{3,})/);
  if (!match) return null;
  return `sin ${match[1]}`;
}

/** La opción más específica del pedido. «jalapeños» no ofrece Chile Icee. */
export function filterAskedType(query: string, products: AgentProduct[]): AgentProduct[] {
  if (products.length < 2) return products;
  const token = productTypeTokens(query)
    .filter((item) => item.length >= 6)
    .sort((a, b) => b.length - a.length)[0];
  if (!token) return products;
  const forms = new Set<string>([token]);
  if (token.length > 6 && token.endsWith("es")) forms.add(token.slice(0, -2));
  else if (token.length > 6 && token.endsWith("s")) forms.add(token.slice(0, -1));
  if (token.length >= 7 && token.endsWith("ita")) forms.add(`${token.slice(0, -3)}a`);
  else if (token.length >= 7 && token.endsWith("ito")) forms.add(`${token.slice(0, -3)}o`);
  const filtered = products.filter((product) => {
    const words = foldAgent(product.name).split(" ").filter(Boolean);
    return [...forms].some((form) => form.length >= 4 && words.some((word) => word === form || word.startsWith(form)));
  });
  return filtered.length ? filtered : products;
}

/** La frase del mensaje que más se parece a la pregunta o al producto. */
export function clauseNaming(message: string, hints: string[]): string | null {
  let best = "";
  let bestScore = 0;
  for (const part of orderClauses(message)) {
    const text = foldAgent(part);
    let score = 0;
    for (const hint of hints) {
      for (const token of contentTokens(hint)) {
        if (token.length >= 4 && tokenIn(text, token)) score += token.length;
      }
    }
    if (score > bestScore) {
      best = part;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function splitOneLine(message: string): string[] {
  const raw = String(message ?? "")
    .split(CLAUSE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = attachLooseQty(raw).filter((part) => contentTokens(part).length > 0);
  const merged: string[] = [];
  for (const part of parts) {
    const text = foldAgent(part);
    // «Sanitas 100 Toallas» es una presentación, no un segundo producto.
    const continues = /^(?:de\b|recia\b|reciona\b|grande\b|chica\b|chico\b|marinad|una recia|un recio|una grande|una chica|\d+\s+(?:toallas?|servilletas?|hojas?|rollos?)\b)/.test(text);
    if (merged.length && continues) merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`;
    else merged.push(part);
  }
  return merged;
}

/** Un renglón es un producto. «Dos.» suelto se pega al siguiente o se ignora. */
export function orderClauses(message: string, phrases?: string[]): string[] {
  const lines = normalizeBrandText(shieldConjunctions(rewriteMenuPhrases(normalizeVoice(message)), phrases)).split(/\n+/);
  const clauses: string[] = [];
  let carry = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (QTY_ONLY.test(foldAgent(line))) {
      carry = line.replace(/\.+$/g, "").trim();
      continue;
    }
    const text = carry ? `${carry} ${line}` : line;
    carry = "";
    clauses.push(...splitOneLine(text));
  }
  return finishClauses(clauses).map(restoreConjunctions);
}

/**
 * Cada renglón. Si el renglón completo es un nombre del catálogo, no se parte:
 * «Lirio Coco Y Almendras» es un producto, no coco y almendras.
 */
export function listClauses(message: string, isExactLine: (line: string) => boolean, phrases?: string[]): string[] {
  const lines = normalizeBrandText(shieldConjunctions(rewriteMenuPhrases(normalizeVoice(message)), phrases)).split(/\n+/);
  const clauses: string[] = [];
  let carry = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (QTY_ONLY.test(foldAgent(line))) {
      carry = line.replace(/\.+$/g, "").trim();
      continue;
    }
    const text = carry ? `${carry} ${line}` : line;
    carry = "";
    if (isExactLine(text)) clauses.push(text);
    else clauses.push(...splitOneLine(text));
  }
  return finishClauses(clauses).map(restoreConjunctions);
}

/** Lo que el cliente dijo, sin la cantidad del principio. Sirve para el nombre exacto. */
export function normalizedAsk(clause: string): string {
  return foldAgent(normalizeMeasureWords(clause))
    .replace(/^(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Nombre de catálogo comparable.
 * «Et-4» no es «ET 4»: el guión entre letra y número no abre otra palabra.
 * Caja, pieza y etapa se escriben igual que CJ, PZ y ET.
 */
export function foldCatalogName(value: string): string {
  const glued = String(value ?? "")
    .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ])-(?=\d)/g, "$1")
    .replace(/(\d)-(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g, "$1");
  return foldAgent(glued)
    .replace(/\betapas?\b/g, "et")
    .replace(/\bcajas?\b/g, "cj")
    .replace(/\b(?:piezas?|pzas?)\b/g, "pz")
    .replace(/\bpaquetes?\b/g, "paq");
}

/** El nombre que dijo, sin la cantidad del principio, con abreviaturas juntas. */
export function catalogAsk(clause: string): string {
  return foldCatalogName(clause).replace(/^(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+/, "").replace(/\s+/g, " ").trim();
}

/** Una palabra de 4+ letras que el cliente no escribió completa: falta o diminutivo. */
export function clauseMisspelled(clause: string, products: Array<Pick<AgentProduct, "name" | "brand" | "presentation">>): boolean {
  const tokens = productTypeTokens(clause).filter((token) => token.length >= 4);
  if (!tokens.length || !products.length) return false;
  const written = (token: string) => {
    const forms = [token];
    for (const form of synonymForms(token)) {
      if (form === token) continue;
      const diminutive = /it[oa]s?$/.test(token) && form.length < token.length;
      if (!diminutive) forms.push(form);
    }
    return products.some((product) => {
      const words = foldAgent([product.name, product.brand ?? "", product.presentation ?? ""].join(" ")).split(" ").filter(Boolean);
      return words.some((word) => forms.some((form) => word === form || word === `${form}s` || form === `${word}s` || form === `${word}es` || word === `${form}es`));
    });
  };
  return tokens.some((token) => !written(token));
}

const SAUCE_WORD = new Set(["chile", "chiles", "salsa", "salsas"]);
const CLARIFICATION_FILLER = new Set([
  "marca", "mira", "refiero", "refieres", "ok", "bueno", "entonces", "dice", "digo",
]);

/** «agua marca Members Mark» conserva el tipo y la marca. «marca» no es un producto. */
function stripBrandCue(focus: string): string {
  const text = foldAgent(focus);
  const at = text.lastIndexOf(" marca");
  if (at < 0) return text;
  const before = text.slice(0, at).split(" ").filter(Boolean);
  const after = text.slice(at + " marca".length).trim();
  const type = [...before].reverse().find((word) => CATEGORY_WORD.has(word) || (word.length >= 4 && !CLARIFICATION_FILLER.has(word))) ?? "";
  return `${type} ${after}`.replace(/\s+/g, " ").trim();
}

/** «me refiero a la agua marca X» se compara con esa aclaración, no con todo el mensaje. */
export function clarificationFocus(message: string): string | null {
  const text = foldAgent(message);
  const marker = text.match(/\b(?:me refiero a|quiero decir|o sea)\b/);
  let focus = "";
  if (marker && marker.index != null) {
    focus = text.slice(marker.index + marker[0].length).replace(/^(?:a|la|el|de|del)\s+/, "").trim();
  } else if (/\bmarca\b/.test(text)) {
    focus = text;
  }
  if (!focus) return null;
  const cleaned = stripBrandCue(focus);
  return cleaned || null;
}

function askedPieces(message: string): string[] {
  const focus = clarificationFocus(message);
  const source = focus ?? message;
  const clauses = orderClauses(source);
  return clauses.length ? clauses : [source];
}

/**
 * Chile y salsa son el mismo tipo cuando el cliente también nombró la salsa
 * (Costa Brava, Valentina). Un «chile» o una «salsa» sueltos no se cambian.
 */
export function sauceTypeAlias(blob: string, token: string, clause: string): boolean {
  if (!SAUCE_WORD.has(token)) return false;
  const others = contentTokens(clause).filter((word) => !SAUCE_WORD.has(word) && word.length >= 4 && !CLARIFICATION_FILLER.has(word));
  if (!others.length) return false;
  if (!others.every((word) => tokenInLoose(blob, word))) return false;
  return [...SAUCE_WORD].some((form) => tokenInLoose(blob, form));
}

function typeTokenHits(blob: string, token: string, clause: string): boolean {
  if (CLARIFICATION_FILLER.has(token)) return true;
  if (tokenInLoose(blob, token)) return true;
  if ((token === "member" || token === "members") && tokenInLoose(blob, "members")) return true;
  if (token === "mark" && /\bmarks?\b/.test(blob)) return true;
  return sauceTypeAlias(blob, token, clause);
}

export function sharesProductType(
  message: string,
  product: { name: string; brand?: string | null; presentation?: string | null; alias?: string[] | null },
): boolean {
  const pieces = askedPieces(message);
  const blob = foldAgent([product.name, product.brand ?? "", product.presentation ?? "", ...(product.alias ?? [])].join(" "));
  return pieces.some((clause) => {
    const tokens = productTypeTokens(clause).filter((token) => !CLARIFICATION_FILLER.has(token));
    if (!tokens.length) return false;
    const qual = trailingQualifiers(clause);
    const head = tokens[0];
    if (!typeTokenHits(blob, head, clause)) return false;
    // El sustantivo basta. «de maíz» o «rayado» ordenan; no rechazan Tortillas ni Chelita.
    const required = tokens.filter((token) => !qual.has(token));
    if (!required.every((token) => typeTokenHits(blob, token, clause))) return false;
    const category = contentTokens(clause).filter((token) => CATEGORY_WORD.has(token));
    if (!category.length) return true;
    return category.every((token) => typeTokenHits(blob, token, clause) || tokenInLoose(blob, token));
  });
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
  const words = text.split(" ").filter(Boolean);
  for (const form of synonymForms(token)) {
    if (form !== token && tokenIn(text, form)) return true;
    if (words.some((word) => listaWordHit(word, form))) return true;
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
export function uncoveredClauses(message: string, cart: AgentLine[], coveredText: string, clauses?: string[], phrases?: string[]): string[] {
  const blob = foldAgent([
    coveredText,
    ...cart.map((line) => `${line.name} ${line.variant ?? ""} ${line.brand ?? ""} ${line.freeText ?? ""}`),
  ].join(" "));
  return (clauses ?? orderClauses(message, phrases)).filter((clause) => !clauseCovered(clause, blob));
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
