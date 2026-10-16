import type { ListaProducto } from "@/lib/storeProductList";

/** PostgREST devuelve como máximo 1000 filas si el select no trae filtro. */
export const LISTA_FULL_FETCH_MAX = 1000;
/** Candidatos que se le pasan a matchLista. Por debajo del tope de 1000. */
export const LISTA_SEARCH_LIMIT = 80;
export const LISTA_TOKEN_LIMIT = 16;

const SIMILARITY_MIN = 0.4;

const SCORE = {
  nombreIncludes: 4,
  nombreSimilar: 2,
  marcaIncludes: 3,
  marcaSimilar: 1,
  aliasIncludes: 4,
  aliasSimilar: 2,
  presentacionIncludes: 1,
} as const;

// Palabras de la frase y unidades. No van nombres de producto (leche, agua,
// atún): eso es lo que hay que buscar. "media"/"medio" sí salen porque en
// el pedido son cantidad ("medio kilo"), y "crema" sigue alcanzando para
// encontrar la media crema.
const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "veinte", "treinta", "cuarenta", "cincuenta", "medio", "media",
  "y", "o", "e", "con", "sin", "por", "para", "que", "se", "al", "lo", "les",
  "su", "sus", "mi", "mis", "tu", "tus", "en", "es", "son", "me", "te", "le",
  "quiero", "quisiera", "dame", "denme", "traeme", "manda", "mande", "mandado",
  "anota", "anotame", "anotala", "anotalo", "anotar", "agrega", "agregame",
  "agregar", "tambien", "ademas", "porfa", "favor", "porfavor", "porfis", "xfa",
  "gracias", "serian", "seria", "seran", "hola", "buenas", "bueno", "entonces",
  "nomas", "solo", "pura", "puro", "ejemplo", "esta", "este", "eso", "esa",
  "mas", "muy", "bien", "ok", "va", "dale", "sale", "necesito", "ocupo", "ocupa",
  "pedi", "pediste", "pedimos", "pedido",
  "hay", "tienes", "tiene", "kilo", "kilos", "kg", "gramo", "gramos", "litro",
  "litros", "ml", "lt", "lts", "mililitro", "mililitros", "pieza", "piezas",
  "pza", "pzas", "paquete", "paquetes", "caja", "cajas", "botella", "botellas",
  "bolsa", "bolsas", "lata", "latas", "rollo", "rollos", "garrafon", "garrafones",
  "docena", "docenas", "six",
]);

export function foldListaText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isQuantity(token: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(token) || /^\d+(?:ml|l|lt|lts|kg|g|gr|grs|mg|pza|pzas|pz)$/.test(token);
}

/** Tokens con los que se busca en nombre, marca y alias. Sin acentos, sin cantidades. */
export function listaSearchTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  const push = (token: string) => {
    if (seen.has(token) || tokens.length >= LISTA_TOKEN_LIMIT) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const token of foldListaText(text).split(" ")) {
    if (token.length < 3 || token.length > 40) continue;
    if (STOP.has(token) || isQuantity(token)) continue;
    push(token);
    if (token.endsWith("s") && token.length > 4) {
      const stem = token.slice(0, -1);
      if (stem.length >= 4 && !STOP.has(stem) && !isQuantity(stem)) push(stem);
    }
  }
  return tokens;
}

/** Palabras de presentación o categoría. No deben tapar la marca. */
const WEAK_TOKENS = new Set(["pan", "lata", "latas", "refresco", "jugo", "botella", "paquete", "bolsa", "caja"]);

const SYNONYM_GROUPS: string[][] = [
  ["fuse", "fuze", "fusi", "fuzetea", "fuzete"],
  ["coca", "cocacola"],
  ["lata", "latas"],
];

const DRINK_HINTS = new Set(["fuse", "fuze", "fusi", "fuzetea", "fuzete", "coca", "cocacola", "pepsi", "jugo", "refresco", "tea"]);

function synonymForms(token: string): string[] {
  const forms = new Set<string>([token]);
  for (const group of SYNONYM_GROUPS) {
    if (!group.includes(token)) continue;
    for (const alias of group) {
      if (alias.length >= 3) forms.add(alias);
    }
  }
  if (token === "ti" || token === "tea" || token === "te") forms.add("tea");
  return [...forms];
}

/**
 * Tokens para ordenar en TypeScript. Incluye «lata» y «pan» aunque el buscador
 * de SQL los trate como pista débil, y el té escrito «ti».
 */
export function listaRankTokens(text: string): string[] {
  const tokens = listaSearchTokens(text);
  const words = foldListaText(text).split(" ").filter(Boolean);
  const seen = new Set(tokens);
  const push = (token: string) => {
    if (token.length < 3 || seen.has(token) || tokens.length >= 24) return;
    seen.add(token);
    tokens.push(token);
  };
  const drink = words.some((word) => DRINK_HINTS.has(word));
  for (const word of words) {
    if (WEAK_TOKENS.has(word)) push(word);
    if ((word === "ti" || word === "tea" || (word === "te" && drink)) && drink) push("tea");
    if (word === "ti" || word === "tea") push("tea");
  }
  return tokens;
}

/** Lo que se manda al SQL: sin la palabra genérica si ya hay una marca. Con sinónimos. */
export function listaSqlTokens(text: string): string[] {
  const rank = listaRankTokens(text);
  const distinctive = rank.filter((token) => !WEAK_TOKENS.has(token));
  const source = distinctive.length ? distinctive : rank;
  const seen = new Set<string>();
  const tokens: string[] = [];
  const push = (token: string) => {
    if (token.length < 3 || seen.has(token) || tokens.length >= LISTA_TOKEN_LIMIT) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const token of source) {
    for (const form of synonymForms(token)) push(form);
  }
  return tokens;
}

export function listaQueryText(
  message: string | null | undefined,
  items?: Array<{
    nombre_producto?: string | null;
    marca?: string | null;
    presentacion?: string | null;
  }> | null,
): string {
  const parts = [message ?? ""];
  for (const item of items ?? []) {
    parts.push(item.nombre_producto ?? "", item.marca ?? "", item.presentacion ?? "");
  }
  return parts.join(" ");
}

export function listaFetchMode(productCount: number, tokens: string[]): "full" | "search" | "empty" {
  if (productCount <= LISTA_FULL_FETCH_MAX) return "full";
  if (tokens.length === 0) return "empty";
  return "search";
}

function trigrams(value: string): string[] {
  const padded = `  ${value} `;
  const grams: string[] = [];
  for (let i = 0; i < padded.length - 2; i += 1) grams.push(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard de trigramas, el mismo criterio que pg_trgm.similarity. */
function trigramSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = trigrams(left);
  const b = new Set(trigrams(right));
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  const union = a.length + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function wordSimilarity(token: string, field: string): number {
  if (!token || !field) return 0;
  let best = trigramSimilarity(token, field);
  for (const word of field.split(" ")) {
    if (!word) continue;
    const score = trigramSimilarity(token, word);
    if (score > best) best = score;
  }
  return best;
}

function isSimilar(field: string, token: string): boolean {
  // Igual que el RPC: el parecido solo entra en palabras de 6+, y solo si ya
  // comparten las primeras 3 letras. Así un typo ("sabritsa") sí entra y no
  // se compara cada fila del catálogo.
  if (!field || token.length < 6 || field.includes(token)) return false;
  if (!field.includes(token.slice(0, 3))) return false;
  return wordSimilarity(token, field) >= SIMILARITY_MIN;
}

function fieldHit(field: string, token: string): "includes" | "prefix" | "similar" | null {
  if (!field || !token) return null;
  if (field.includes(token)) return "includes";
  if (token.length >= 3) {
    const words = field.split(" ");
    if (words.some((word) => word.startsWith(token) || (token.startsWith(word) && word.length >= 4))) return "prefix";
  }
  if (isSimilar(field, token)) return "similar";
  return null;
}

function bestHit(field: string, token: string): "includes" | "prefix" | "similar" | null {
  let best: "includes" | "prefix" | "similar" | null = null;
  const rank = { includes: 3, prefix: 2, similar: 1 };
  for (const form of synonymForms(token)) {
    const hit = fieldHit(field, form);
    if (hit && (!best || rank[hit] > rank[best])) best = hit;
  }
  return best;
}

function scoreToken(row: ListaProducto, token: string): number {
  const nombre = foldListaText(row.nombre);
  const marca = foldListaText(row.marca ?? "");
  const presentacion = foldListaText(row.presentacion ?? "");
  const aliases = (row.alias ?? []).map((alias) => foldListaText(alias)).filter(Boolean);
  const aliasText = aliases.join(" ");
  const weak = WEAK_TOKENS.has(token) ? 0.25 : 1;
  let score = 0;
  const nombreHit = bestHit(nombre, token);
  if (nombreHit === "includes" || nombreHit === "prefix") score += SCORE.nombreIncludes;
  else if (nombreHit === "similar") score += SCORE.nombreSimilar;
  const marcaHit = bestHit(marca, token);
  if (marcaHit === "includes" || marcaHit === "prefix") score += SCORE.marcaIncludes;
  else if (marcaHit === "similar") score += SCORE.marcaSimilar;
  const aliasHit = bestHit(aliasText, token);
  if (aliasHit === "includes" || aliasHit === "prefix") score += SCORE.aliasIncludes;
  else if (aliasHit === "similar") score += SCORE.aliasSimilar;
  if (bestHit(presentacion, token) === "includes" || bestHit(presentacion, token) === "prefix") score += SCORE.presentacionIncludes;
  return score * weak;
}

/**
 * Las mismas pesas que `buscar_lista_productos_tienda`: nombre, marca y alias
 * pesan; la presentación solo desempata para no perder el tamaño. Máximo 80.
 */
export function rankListaByTokens(rows: ListaProducto[], tokens: string[], limit = LISTA_SEARCH_LIMIT): ListaProducto[] {
  if (!tokens.length || !rows.length) return [];
  const cap = Math.max(1, Math.min(limit, LISTA_SEARCH_LIMIT));
  const scored: Array<{ row: ListaProducto; score: number; index: number }> = [];
  rows.forEach((row, index) => {
    let score = 0;
    let distinctive = 0;
    for (const token of tokens) {
      const part = scoreToken(row, token);
      if (part <= 0) continue;
      score += part;
      if (!WEAK_TOKENS.has(token)) distinctive += 1;
    }
    if (distinctive > 1) score += distinctive * 3;
    if (score > 0) scored.push({ row, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.row.nombre.localeCompare(b.row.nombre) || a.index - b.index);
  return scored.slice(0, cap).map((entry) => entry.row);
}

export function rankListaCandidates(rows: ListaProducto[], text: string, limit = LISTA_SEARCH_LIMIT): ListaProducto[] {
  return rankListaByTokens(rows, listaRankTokens(text), limit);
}
