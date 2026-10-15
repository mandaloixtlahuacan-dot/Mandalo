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

function scoreToken(row: ListaProducto, token: string): number {
  const nombre = foldListaText(row.nombre);
  const marca = foldListaText(row.marca ?? "");
  const presentacion = foldListaText(row.presentacion ?? "");
  const aliases = (row.alias ?? []).map((alias) => foldListaText(alias)).filter(Boolean);
  let score = 0;
  if (nombre.includes(token)) score += SCORE.nombreIncludes;
  else if (isSimilar(nombre, token)) score += SCORE.nombreSimilar;
  if (marca.includes(token)) score += SCORE.marcaIncludes;
  else if (isSimilar(marca, token)) score += SCORE.marcaSimilar;
  if (aliases.some((alias) => alias.includes(token))) score += SCORE.aliasIncludes;
  else if (aliases.some((alias) => isSimilar(alias, token))) score += SCORE.aliasSimilar;
  if (presentacion.includes(token)) score += SCORE.presentacionIncludes;
  return score;
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
    for (const token of tokens) score += scoreToken(row, token);
    if (score > 0) scored.push({ row, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.row.nombre.localeCompare(b.row.nombre) || a.index - b.index);
  return scored.slice(0, cap).map((entry) => entry.row);
}

export function rankListaCandidates(rows: ListaProducto[], text: string, limit = LISTA_SEARCH_LIMIT): ListaProducto[] {
  return rankListaByTokens(rows, listaSearchTokens(text), limit);
}
