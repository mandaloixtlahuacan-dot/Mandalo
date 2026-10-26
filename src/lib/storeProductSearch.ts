import type { ListaProducto } from "@/lib/storeProductList";

/** PostgREST devuelve como máximo 1000 filas si el select no trae filtro. */
export const LISTA_FULL_FETCH_MAX = 1000;
/** Candidatos que se le pasan a matchLista. Por debajo del tope de 1000. */
export const LISTA_SEARCH_LIMIT = 80;
export const LISTA_TOKEN_LIMIT = 16;

const SIMILARITY_MIN = 0.4;

/**
 * Umbral para ofrecer un producto. Una falta de una letra sobre la palabra
 * vale 2 (nombreSimilar). La subcadena y el fuzzy que cambia el significado
 * (sanitas dentro de sanitario) valen 0 y no pasan.
 */
export const LISTA_MIN_SCORE = 2;

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
  "algo", "alguna", "algun", "algunos", "algunas",
  "pedi", "pediste", "pedimos", "pedido",
  "hay", "tienes", "tiene", "kilo", "kilos", "kg", "gramo", "gramos", "litro",
  "litros", "ml", "lt", "lts", "mililitro", "mililitros", "pieza", "piezas",
  "pza", "pzas", "paquete", "paquetes", "caja", "cajas", "botella", "botellas",
  "bolsa", "bolsas", "lata", "latas", "rollo", "rollos", "garrafon", "garrafones",
  "docena", "docenas", "six",
  "cajita", "cajitas", "latita", "latitas", "bolsita", "bolsitas",
  "paquetito", "paquetitos", "botellita", "botellitas",
]);

/**
 * 1/4, 8 oz y 250 ml se escriben igual antes de quitar signos.
 * «cuarto» de jamón o de kilo no es un vaso de 250 ml.
 */
export function normalizeMeasureWords(value: string): string {
  return String(value ?? "")
    .replace(/¼/g, " cuarto ")
    .replace(/½/g, " medio ")
    .replace(/\b1\s*\/\s*4\b/gi, " cuarto ")
    .replace(/\b1\s*\/\s*2\b/gi, " medio ")
    .replace(/\b8\s*(?:onzas?|oz)\b/gi, " 8oz ")
    .replace(/\b250\s*ml\b/gi, " 250ml ")
    .replace(/\b500\s*ml\b/gi, " 500ml ");
}

/**
 * Empaque en diminutivo. Es la clase de la palabra (vaso, tapa, caja),
 * no un producto. «nito» no entra: tiene menos de 6 letras y es nombre.
 */
const PACKAGING_DIMINUTIVE: Record<string, string> = {
  vasito: "vaso",
  vasitos: "vaso",
  tapita: "tapa",
  tapitas: "tapa",
  cajita: "caja",
  cajitas: "caja",
  bolsita: "bolsa",
  bolsitas: "bolsa",
  latita: "lata",
  latitas: "lata",
  paquetito: "paquete",
  paquetitos: "paquete",
  botellita: "botella",
  botellitas: "botella",
  piecita: "pieza",
  piecitas: "pieza",
};

/** vasitos → vaso, galletita → galleta. El tronco corto no se recorta: «sanitas» no es «sana». */
function diminutiveFamily(token: string): string[] {
  const packed = PACKAGING_DIMINUTIVE[token];
  const bases: string[] = [];
  if (packed) bases.push(packed);
  else if (token.length >= 7) {
    let stem = "";
    let gender = "";
    if (token.endsWith("itos")) {
      stem = token.slice(0, -4);
      gender = "o";
    } else if (token.endsWith("itas")) {
      stem = token.slice(0, -4);
      gender = "a";
    } else if (token.endsWith("ito")) {
      stem = token.slice(0, -3);
      gender = "o";
    } else if (token.endsWith("ita")) {
      stem = token.slice(0, -3);
      gender = "a";
    }
    // Tronco de 4 («torrito» → «torro», «caeritos» → «caero»).
    // El parecido de una letra no usa ese tronco: solo la palabra exacta.
    if (stem.length >= 4) bases.push(`${stem}${gender}`);
  }
  const forms: string[] = [];
  for (const base of bases) {
    if (base.length < 3 || base === token || forms.includes(base)) continue;
    forms.push(base);
    if (!base.endsWith("s")) forms.push(`${base}s`);
  }
  return forms;
}

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

/** Lo que el cliente dictó mal y el catálogo escribe de otra forma. */
export function normalizeVoice(text: string): string {
  return String(text ?? "")
    .replace(/\bmeriendas?\b/gi, "mirinda")
    .replace(/\bmirandas?\b/gi, "mirinda");
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
  const prepared = normalizeVoice(normalizeMeasureWords(text)).replace(/\bsin\s+sabor\b/gi, " ");
  for (const raw of foldListaText(prepared).split(" ")) {
    if (raw.length < 3 || raw.length > 40) continue;
    if (STOP.has(raw) || isQuantity(raw)) continue;
    const token = canonicalToken(raw);
    if (token.length < 3 || token.length > 40) continue;
    push(token);
    // «condones» ya tiene sinónimo y familia. El tronco «condone» no es un producto.
    const grouped = synonymForms(token).some((form) => form !== token) || PRODUCT_FAMILY[token] != null;
    if (!grouped && token.endsWith("s") && token.length > 4) {
      const stem = token.slice(0, -1);
      if (stem.length >= 4 && !STOP.has(stem) && !isQuantity(stem)) push(stem);
    }
  }
  // «para», «caja», «bolsa» o «paquete» solas sí se buscan. «quiero» no.
  // Una frase más larga que solo deja esa palabra de paso («no es una caja») no.
  if (!tokens.length) {
    const filler = new Set([
      "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
      "quiero", "quisiera", "dame", "deme", "traeme", "porfa", "porfavor", "favor", "por",
      "me", "te", "se",
    ]);
    const rest = foldListaText(prepared).split(" ").filter((token) => token && !filler.has(token));
    if (rest.length === 1 && /^(?:cajas?|bolsas?|paquetes?|para)$/.test(rest[0])) push(rest[0]);
  }
  return familyFocusTokens(tokens) ?? tokens;
}

/** Palabras de presentación o categoría. No deben tapar la marca. */
const WEAK_TOKENS = new Set(["pan", "lata", "latas", "refresco", "jugo", "botella", "paquete", "bolsa", "caja"]);

/** Color o sabor genérico: desempata, no alcanza para elegir otro producto. */
const COLOR_TOKENS = new Set([
  "rojo", "roja", "rojos", "rojas", "azul", "azules", "verde", "verdes",
  "morado", "morada", "negro", "negra", "blanco", "blanca", "rosa",
  "amarillo", "amarilla", "menta", "naranja",
]);

const SYNONYM_GROUPS: string[][] = [
  ["fuse", "fuze", "fusi", "fuste", "fuzet", "fuzete", "fuzetea"],
  ["coca", "cocacola"],
  ["bonafont", "bonafon", "donado", "donafon", "donafont", "fonafont", "vonafont"],
  ["pepsi", "pepsis", "pepe", "pepesi"],
  ["powerade", "pawer", "pauer", "power"],
  ["halls", "hall"],
  ["higienico", "higienicos", "hig"],
  ["lata", "latas"],
  ["capuchino", "capuccino", "cappuccino", "cappuchino"],
  ["mirinda", "mirandas", "miranda", "merienda", "meriendas"],
  ["seven", "7up"],
  ["electrolit", "electrolight", "electrolitos"],
  ["sico", "xico", "siko", "cico", "zico"],
  ["condon", "condones", "preserv", "preservativo", "preservativos", "precerbativo", "precerbativos"],
];

/**
 * El tipo no está escrito en el nombre («Sico Safety» no dice condón).
 * Es de una sola vía: buscar «sico» no arrastra «Condones Premier».
 */
const PRODUCT_FAMILY: Record<string, string[]> = {
  condon: ["sico"],
  condones: ["sico"],
  preserv: ["sico"],
  preservativo: ["sico"],
  preservativos: ["sico"],
  precerbativo: ["sico"],
  precerbativos: ["sico"],
};

const KNOWN_TERMS = new Set<string>([
  ...SYNONYM_GROUPS.flat(),
  ...Object.keys(PRODUCT_FAMILY),
  ...Object.values(PRODUCT_FAMILY).flat(),
]);

const DRINK_HINTS = new Set([
  "fuse", "fuze", "fusi", "fuste", "fuzet", "fuzete", "fuzetea",
  "coca", "cocacola", "pepsi", "pepsis", "jugo", "refresco", "tea",
  "bonafont", "bonafon", "donado", "fonafont",
]);

export function synonymForms(token: string): string[] {
  const forms = new Set<string>([token]);
  for (const group of SYNONYM_GROUPS) {
    if (!group.includes(token)) continue;
    for (const alias of group) {
      if (alias.length >= 3) forms.add(alias);
    }
  }
  for (const extra of diminutiveFamily(token)) forms.add(extra);
  if (token === "ti" || token === "tea" || token === "te") forms.add("tea");
  return [...forms];
}

/** s/x/z/c y b/v se oyen igual. No cambia el largo de la palabra. */
function phoneticKey(token: string): string {
  return token
    .replace(/qu/g, "k")
    .replace(/x/g, "s")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/c(?=[ei])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k");
}

function phoneticClose(left: string, right: string): boolean {
  if (left === right) return true;
  return left + "s" === right || right + "s" === left || left + "es" === right || right + "es" === left;
}

/**
 * «xico» es Sico y «precerbativos» es preservativos.
 * Una palabra que ya está en el catálogo o en un sinónimo se queda igual.
 * Con dos cambios hace falta una palabra larga, para no juntar marcas cortas.
 */
export function canonicalToken(token: string): string {
  if (!token || token.length < 4 || KNOWN_TERMS.has(token)) return token;
  const key = phoneticKey(token);
  let best: { term: string; distance: number } | null = null;
  for (const term of KNOWN_TERMS) {
    if (Math.abs(term.length - token.length) > 2) continue;
    if (!phoneticClose(key, phoneticKey(term))) continue;
    const distance = editDistance(token, term);
    if (distance === 0) return term;
    if (distance > 2) continue;
    if (distance === 2 && token.length < 8) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && Math.abs(term.length - token.length) < Math.abs(best.term.length - token.length))
    ) {
      best = { term, distance };
    }
  }
  return best?.term ?? token;
}

/** Si el cliente dijo el tipo (condón, preservativo), la búsqueda usa la marca. Si también dijo la marca, el tipo no estorba. */
export function familyFocusTokens(tokens: string[]): string[] | null {
  const brands: string[] = [];
  const specific: string[] = [];
  let sawFamily = false;
  for (const token of tokens) {
    const canon = canonicalToken(token);
    const family = PRODUCT_FAMILY[canon] ?? PRODUCT_FAMILY[token];
    if (family) {
      sawFamily = true;
      for (const brand of family) {
        if (!brands.includes(brand)) brands.push(brand);
      }
      continue;
    }
    if (!specific.includes(canon)) specific.push(canon);
  }
  if (!sawFamily) return null;
  return specific.length ? specific : brands;
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
  // «fuste» y «donado» no comparten tres letras con la marca. El sinónimo
  // entra aquí para que el ranking de TypeScript y el de SQL vean lo mismo.
  for (const token of [...tokens]) {
    for (const form of synonymForms(token)) push(form);
  }
  return familyFocusTokens(tokens) ?? tokens;
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
    const forms = synonymForms(token);
    for (const form of forms) {
      // «hig» es abreviatura de higiénico en el catálogo. No se manda al SQL:
      // un LIKE de 3 letras se come productos que no son y puede sacar a Pétalo del tope.
      if (form.length < 4 && forms.some((other) => other.length > form.length && other.startsWith(form))) continue;
      push(form);
    }
  }
  // «algo de limpieza» no dice Fabuloso, pero el SQL tiene que traerlo:
  // si el token es solo «limpieza», Fabuloso se queda fuera del tope.
  for (const extra of vagueFamilyTokens(text)) push(extra);
  const folded = foldListaText(normalizeMeasureWords(text));
  if (!/\b(?:jamon|kilo|kilos|kg|gramo|gramos)\b/.test(folded) && /\b(?:cuartos?|8oz|250ml)\b/.test(folded)) {
    for (const extra of ["cuarto", "250ml", "8oz"]) push(extra);
  }
  if (/\bmedio\b/.test(folded) && /\blitros?\b/.test(folded)) push("500ml");
  if (/\blitros?\b/.test(folded)) push("litro");
  // «queso crema» también es Philadelphia. El SQL suma por token, no exige todos.
  if (/\bqueso\b/.test(folded) && /\bcrema\b/.test(folded)) push("philadelphia");
  return tokens;
}

function aliasCreamCheese(rows: ListaProducto[], text: string): ListaProducto[] {
  const folded = foldListaText(text);
  if (!/\bqueso\b/.test(folded) || !/\bcrema\b/.test(folded)) return rows;
  return rows.map((row) => {
    const name = foldListaText(row.nombre);
    if (!/\bphiladelphia\b/.test(name)) return row;
    if (/\bqueso\b/.test(name) && /\bcrema\b/.test(name)) return row;
    const alias = [...(row.alias ?? [])];
    if (alias.some((item) => foldListaText(item) === "queso crema")) return row;
    return { ...row, alias: [...alias, "queso crema"] };
  });
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

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function pluralEqual(word: string, token: string): boolean {
  if (!word || !token) return false;
  if (word === token) return true;
  if (word.length < 4 || token.length < 4) return false;
  return word === `${token}s` || token === `${word}s` || word === `${token}es` || token === `${word}es`;
}

/**
 * Recorte del mismo nombre: «chamber» es chamberete.
 * Hace falta un token largo. «sanita» no se come «sanitario», ni «ole» se come «oleo».
 */
function sameNamePrefix(word: string, token: string): boolean {
  if (token.length < 7 || word.length <= token.length || word.length - token.length > 4) return false;
  return word.startsWith(token);
}

/** «sanitas» no es «sanitario»: comparten el principio y el resto es otro producto. */
function meaningSplit(word: string, token: string): boolean {
  if (!word || !token || pluralEqual(word, token)) return false;
  if (word.startsWith(token) && word.length - token.length >= 2) return true;
  if (token.startsWith(word) && word.length >= 4 && token.length - word.length >= 2) return true;
  const prefix = commonPrefixLength(word, token);
  const gap = Math.abs(word.length - token.length);
  return prefix >= Math.min(word.length, token.length) - 1 && gap >= 2 && editDistance(word, token) > 2;
}

function isSimilar(field: string, token: string): boolean {
  // Igual que el RPC: el parecido solo entra en palabras de 6+, y solo si ya
  // comparten las primeras 3 letras. Así un typo ("sabritsa") sí entra y no
  // se compara cada fila del catálogo. La palabra tiene que medir casi lo
  // mismo: «sanitas» no se parece a «sanitario».
  if (!field || token.length < 6) return false;
  if (!field.includes(token.slice(0, 3))) return false;
  for (const word of field.split(" ")) {
    if (!word || meaningSplit(word, token)) continue;
    if (Math.abs(word.length - token.length) > 1) continue;
    if (wordSimilarity(token, word) >= SIMILARITY_MIN) return true;
  }
  return false;
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 2) return 3;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = saved;
    }
  }
  return row[right.length];
}

/** «pawer» entra en «powerade». No entra si el final ya es otra palabra («sanitas» / «sanitario»). */
function typoHit(field: string, token: string): boolean {
  if (token.length < 5) return false;
  for (const word of field.split(" ")) {
    if (sameNamePrefix(word, token)) return true;
    if (word.length < 4 || word[0] !== token[0] || meaningSplit(word, token)) continue;
    if (Math.abs(word.length - token.length) <= 1 && editDistance(word, token) <= 1) return true;
    if (word.length === token.length && token.length >= 6 && commonPrefixLength(word, token) >= 4 && editDistance(word, token) <= 2) return true;
    if (word.length > token.length && word.length - token.length <= 5) {
      const head = word.slice(0, token.length);
      const prefix = commonPrefixLength(head, token);
      if (head[0] === token[0] && editDistance(head, token) <= 1 && prefix < token.length - 1) return true;
    }
  }
  return false;
}

/** Abreviaturas de empaque y etapa. No son productos: ET/etapa, CJ/caja, PZ/pieza. */
const ABBREV_FORMS: Record<string, string[]> = {
  et: ["etapa"],
  etapa: ["et"],
  cj: ["caja", "cajas"],
  caja: ["cj"],
  cajas: ["cj"],
  pz: ["pieza", "piezas", "pza", "pzas"],
  pza: ["pieza", "piezas", "pz"],
  pzas: ["piezas", "pz"],
  pieza: ["pz", "pza"],
  piezas: ["pz", "pzas"],
  paq: ["paquete", "paquetes"],
  paquete: ["paq"],
  paquetes: ["paq"],
};

function abbrevEqual(word: string, token: string): boolean {
  if (!word || !token || word === token) return word === token && word.length > 0;
  return (ABBREV_FORMS[token] ?? []).includes(word) || (ABBREV_FORMS[word] ?? []).includes(token);
}

/** Palabra completa, plural, sinónimo o falta de ortografía. No subcadena. */
export function listaWordHit(word: string, token: string): boolean {
  if (!word || !token) return false;
  if (abbrevEqual(word, token)) return true;
  for (const form of synonymForms(token)) {
    if (pluralEqual(word, form)) return true;
    if (sameNamePrefix(word, form)) return true;
    if (meaningSplit(word, form)) continue;
    // El tronco de un diminutivo solo vale si es la palabra exacta.
    // «caero» no se come «carro» por una letra.
    if (form.length + 1 < token.length) continue;
    if (form.length >= 4 && word.length === form.length && word[0] === form[0] && editDistance(word, form) <= 1) return true;
    if (form.length >= 5 && Math.abs(word.length - form.length) <= 1 && word[0] === form[0] && editDistance(word, form) <= 1) return true;
    if (form.length >= 6 && word.length === form.length && commonPrefixLength(word, form) >= 4 && editDistance(word, form) <= 2) return true;
    if (
      form.length >= 4 &&
      word.length === form.length &&
      phoneticKey(word) === phoneticKey(form) &&
      editDistance(word, form) <= 1
    ) {
      return true;
    }
    if (
      form.length >= 8 &&
      word.length >= 8 &&
      word[0] === form[0] &&
      Math.abs(word.length - form.length) <= 1 &&
      editDistance(word, form) <= 2 &&
      !meaningSplit(word, form)
    ) {
      return true;
    }
  }
  return false;
}

function fieldHit(field: string, token: string, exactOnly = false): "includes" | "prefix" | "similar" | null {
  if (!field || !token) return null;
  const words = field.split(" ").filter(Boolean);
  let similar = false;
  for (const form of synonymForms(token)) {
    if (words.some((word) => pluralEqual(word, form) || sameNamePrefix(word, form))) return "includes";
  }
  if (exactOnly) return null;
  for (const word of words) {
    if (listaWordHit(word, token) || isSimilar(word, token) || typoHit(word, token)) similar = true;
  }
  return similar ? "similar" : null;
}

function bestHit(field: string, token: string, exactOnly = false): "includes" | "prefix" | "similar" | null {
  let best: "includes" | "prefix" | "similar" | null = null;
  const rank = { includes: 3, prefix: 2, similar: 1 };
  for (const form of synonymForms(token)) {
    const hit = fieldHit(field, form, exactOnly);
    if (hit && (!best || rank[hit] > rank[best])) best = hit;
  }
  return best;
}

function scoreToken(row: ListaProducto, token: string, exactOnly = false): number {
  const nombre = foldListaText(row.nombre);
  const marca = foldListaText(row.marca ?? "");
  const presentacion = foldListaText(row.presentacion ?? "");
  const aliases = (row.alias ?? []).map((alias) => foldListaText(alias)).filter(Boolean);
  const aliasText = aliases.join(" ");
  const weak = WEAK_TOKENS.has(token) ? 0.25 : 1;
  let score = 0;
  const nombreHit = bestHit(nombre, token, exactOnly);
  if (nombreHit === "includes" || nombreHit === "prefix") score += SCORE.nombreIncludes;
  else if (nombreHit === "similar") score += SCORE.nombreSimilar;
  const marcaHit = bestHit(marca, token, exactOnly);
  if (marcaHit === "includes" || marcaHit === "prefix") score += SCORE.marcaIncludes;
  else if (marcaHit === "similar") score += SCORE.marcaSimilar;
  const aliasHit = bestHit(aliasText, token, exactOnly);
  if (aliasHit === "includes" || aliasHit === "prefix") score += SCORE.aliasIncludes;
  else if (aliasHit === "similar") score += SCORE.aliasSimilar;
  if (bestHit(presentacion, token, exactOnly) === "includes" || bestHit(presentacion, token, exactOnly) === "prefix") score += SCORE.presentacionIncludes;
  // Una falta de una letra, o el diminutivo, gana al parecido suelto de trigramas.
  // Si no, «nepoli» se pierde entre docenas de palabras que solo se parecen.
  // El tronco corto («caero») solo cuenta si la palabra es esa, no «carro».
  const named = nombre.split(" ").some((word) => exactOnly
    ? synonymForms(token).some((form) => pluralEqual(word, form))
    : listaWordHit(word, token));
  if (token.length >= 4 && named) score += 14;
  // Palabra completa o el nombre que empieza con ella gana al pedazo
  // ("nito" dentro de cariñitos o gusanito).
  return score * weak + exactNameBonus(nombre, token, exactOnly);
}

/** El tronco de un diminutivo más largo de la misma frase. Solo vale la palabra exacta. */
function strictDiminutiveStem(token: string, tokens: string[]): boolean {
  return tokens.some((other) => other !== token && other.length > token.length && diminutiveFamily(other).includes(token));
}

function exactNameBonus(nombre: string, token: string, exactOnly = false): number {
  if (!nombre || !token) return 0;
  let best = 0;
  const words = nombre.split(" ").filter(Boolean);
  const first = words[0] ?? "";
  for (const form of synonymForms(token)) {
    if (!words.some((word) => pluralEqual(word, form))) continue;
    if (pluralEqual(first, form) || nombre === form) best = Math.max(best, 28);
    else best = Math.max(best, 20);
  }
  // «vove» es Vive, no Elvive: la primera palabra pesa más que una letra adentro.
  if (!exactOnly && best < 22 && first && listaWordHit(first, token)) best = Math.max(best, 22);
  return best;
}

/** Palabras del nombre que el cliente no dijo. La variante más corta y cercana sube. */
function unexplainedContent(nombre: string, tokens: string[]): number {
  const words = nombre.split(" ").filter((word) => word.length >= 4 && !STOP.has(word));
  if (!words.length || !tokens.length) return 0;
  let extra = 0;
  for (const word of words) {
    if (tokens.some((token) => listaWordHit(word, token))) continue;
    extra += 1;
  }
  return extra;
}

/**
 * Las mismas pesas que `buscar_lista_productos_tienda`: nombre, marca y alias
 * pesan; la presentación solo desempata para no perder el tamaño. Máximo 80.
 */
/** «coca de 600», «2 litros», «62 g». El número suelto de 3–4 cifras es mililitros, salvo que diga pesos. */
export function listaPackageKey(text: string): string | null {
  const folded = foldListaText(normalizeMeasureWords(text));
  const amount = (raw: string) => raw.replace(",", ".");
  if (!/\b(?:jamon|kilo|kilos|kg|gramo|gramos)\b/.test(folded) && /\b(?:cuartos?|8oz|250ml)\b/.test(folded)) {
    return "250ml";
  }
  if (/\bmedio\b/.test(folded) && /\blitros?\b/.test(folded)) return "500ml";
  if (/\b500ml\b/.test(folded)) return "500ml";
  const ml = folded.match(/\b(\d+(?:[.,]\d+)?)\s*ml\b/);
  if (ml) return `${amount(ml[1])}ml`;
  const liters = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:l|lt|lts|litros?)\b/);
  if (liters) return `${amount(liters[1])}l`;
  const grams = folded.match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos?)\b/);
  if (grams) return `${amount(grams[1])}g`;
  if (/\bpesos\b/.test(folded)) return null;
  const bare = folded.match(/\b(\d{3,4})\b/);
  if (bare && Number(bare[1]) >= 100) return `${bare[1]}ml`;
  return null;
}

function rowPackageKey(row: ListaProducto): string | null {
  return listaPackageKey(`${row.nombre} ${row.presentacion ?? ""}`);
}

function samePackage(wanted: string, got: string): boolean {
  if (wanted === got) return true;
  if ((wanted === "250ml" && (got === "8oz" || got === "cuarto")) || (got === "250ml" && (wanted === "8oz" || wanted === "cuarto"))) return true;
  if ((wanted === "500ml" && got === "0.5l") || (got === "500ml" && wanted === "0.5l")) return true;
  const litersOf = (key: string) => (key.endsWith("ml") ? null : key.endsWith("l") ? Number(key.slice(0, -1)) : null);
  const wantedLiters = litersOf(wanted);
  const gotLiters = litersOf(got);
  if (wantedLiters != null && got === `${wantedLiters * 1000}ml`) return true;
  if (gotLiters != null && wanted === `${gotLiters * 1000}ml`) return true;
  return false;
}

function isColorToken(token: string): boolean {
  return COLOR_TOKENS.has(token);
}

function rowText(row: ListaProducto): string {
  return foldListaText(`${row.nombre} ${row.marca ?? ""} ${row.presentacion ?? ""} ${(row.alias ?? []).join(" ")}`);
}

function rowExactToken(row: ListaProducto, token: string): boolean {
  const nombre = foldListaText(row.nombre);
  const marca = foldListaText(row.marca ?? "");
  const aliasText = (row.alias ?? []).map((alias) => foldListaText(alias)).filter(Boolean).join(" ");
  return [nombre, marca, aliasText].some((field) => fieldHit(field, token, true) != null);
}

export function rankListaByTokens(
  rows: ListaProducto[],
  tokens: string[],
  limit = LISTA_SEARCH_LIMIT,
  packageKey: string | null = null,
  must: string[] | null = null,
): ListaProducto[] {
  if (!tokens.length || !rows.length) return [];
  const cap = Math.max(1, Math.min(limit, LISTA_SEARCH_LIMIT));
  const required = (must ?? []).filter((token) => !isColorToken(token) && !WEAK_TOKENS.has(token));
  const colors = tokens.filter((token) => isColorToken(token));
  const scored: Array<{ row: ListaProducto; score: number; index: number; mustHits: number; extra: number }> = [];
  rows.forEach((row, index) => {
    let score = 0;
    let distinctive = 0;
    for (const token of tokens) {
      const part = scoreToken(row, token, strictDiminutiveStem(token, tokens));
      if (part <= 0) continue;
      score += part;
      if (!WEAK_TOKENS.has(token) && !isColorToken(token)) distinctive += 1;
    }
    const extra = unexplainedContent(foldListaText(row.nombre), tokens);
    let mustHits = 0;
    for (const token of required) {
      if (scoreToken(row, token) > 0) mustHits += 1;
    }
    if (required.length > 0 && mustHits === 0) return;
    if (distinctive > 1) score += distinctive * 3;
    if (required.length >= 2 && mustHits === required.length) score += 30;
    if (packageKey) {
      const got = rowPackageKey(row);
      if (got && samePackage(packageKey, got)) score += 50;
    }
    if (score >= LISTA_MIN_SCORE) scored.push({ row, score, index, mustHits, extra });
  });
  let chosen = scored;
  if (required.length >= 2) {
    const complete = scored.filter((entry) => entry.mustHits === required.length);
    if (complete.length) chosen = complete;
  }
  if (colors.length) {
    const painted = chosen.filter((entry) => colors.every((color) => rowText(entry.row).includes(color)));
    if (painted.length) chosen = painted;
  }
  // «sico» exacto se queda. «saco» solo se parece y sale. Quien no usa esa palabra, se queda.
  for (const token of tokens) {
    if (WEAK_TOKENS.has(token) || isColorToken(token)) continue;
    const exact = chosen.some((entry) => rowExactToken(entry.row, token));
    if (!exact) continue;
    chosen = chosen.filter((entry) => rowExactToken(entry.row, token) || scoreToken(entry.row, token) <= 0);
  }
  chosen.sort((a, b) => b.score - a.score || a.extra - b.extra || a.row.nombre.localeCompare(b.row.nombre) || a.index - b.index);
  return diversifyLooseToken(chosen, tokens, cap).map((entry) => entry.row);
}

/**
 * Una sola palabra en varias categorías no puede llenar la ventana de un solo tipo.
 * Entra primero el mejor de cada categoría (el tipo más común adelante) y después el resto.
 */
function diversifyLooseToken(
  chosen: Array<{ row: ListaProducto; score: number; index: number; mustHits: number; extra: number }>,
  tokens: string[],
  cap: number,
): Array<{ row: ListaProducto; score: number; index: number; mustHits: number; extra: number }> {
  const root = tokens[0] ?? "";
  if (root.length < 4 || !tokens.every((token) => token === root || synonymForms(root).includes(token))) {
    return chosen.slice(0, cap);
  }
  const exact = chosen.filter((entry) => foldListaText(entry.row.nombre).split(" ").some((word) => pluralEqual(word, root)));
  const groups = new Map<string, typeof chosen>();
  for (const entry of exact) {
    const key = foldListaText(entry.row.categoria ?? "") || "otros";
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  if (groups.size < 2) return chosen.slice(0, cap);
  const ordered = [...groups.values()].sort((left, right) => right.length - left.length);
  const picked: typeof chosen = [];
  const seen = new Set<number>();
  const take = (entry: (typeof chosen)[number]) => {
    const id = (entry.row as ListaProducto & { id?: number }).id;
    if (id != null && seen.has(id)) return;
    if (id != null) seen.add(id);
    picked.push(entry);
  };
  for (const group of ordered) {
    if (picked.length >= cap) break;
    take(group[0]);
  }
  for (const entry of chosen) {
    if (picked.length >= cap) break;
    take(entry);
  }
  return picked;
}

const VAGUE_WORDS = new Set([
  "limpieza", "limpiar", "limpiador", "limpiadores",
  "refresco", "refrescos", "soda", "sodas",
]);

function contentWords(text: string): string[] {
  return foldListaText(text).split(" ").filter((word) => word.length >= 3 && !STOP.has(word));
}

function isCondomQuery(text: string): boolean {
  const words = contentWords(text);
  if (!words.length) return false;
  return words.every((word) => {
    const canon = canonicalToken(word);
    return PRODUCT_FAMILY[canon] != null || PRODUCT_FAMILY[word] != null;
  });
}

/** «algo de limpieza», «refresco» o «condones»: no nombran un producto, nombran el tipo. */
export function isVagueListaQuery(text: string): boolean {
  const words = contentWords(text);
  if (words.length > 0 && words.every((word) => VAGUE_WORDS.has(word))) return true;
  return isCondomQuery(text);
}

const VAGUE_FAMILY: Record<string, string[]> = {
  limpieza: ["fabuloso", "pinol", "cloro", "limpiador"],
  limpiar: ["fabuloso", "pinol", "cloro", "limpiador"],
  limpiador: ["fabuloso", "pinol", "cloro"],
  limpiadores: ["fabuloso", "pinol", "cloro"],
  refresco: ["coca", "sprite", "pepsi", "mirinda"],
  refrescos: ["coca", "sprite", "pepsi", "mirinda"],
  soda: ["coca", "sprite", "pepsi", "mirinda"],
  sodas: ["coca", "sprite", "pepsi", "mirinda"],
};

/** Marcas que el SQL debe alcanzar cuando el cliente solo dijo el tipo. */
function vagueFamilyTokens(text: string): string[] {
  if (!isVagueListaQuery(text)) return [];
  const words = foldListaText(text).split(" ").filter((word) => VAGUE_WORDS.has(word));
  const out: string[] = [];
  for (const word of words) {
    for (const token of VAGUE_FAMILY[word] ?? []) {
      if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}

function vagueFamily(name: string): string {
  const words = foldListaText(name).split(" ").filter(Boolean);
  const known = ["coca", "sprite", "pepsi", "mirinda", "seven", "sidral", "manzanita", "fabuloso", "pinol", "cloro", "limpiador", "limpiadora", "sico"];
  return words.find((word) => known.includes(word)) ?? words[0] ?? name;
}

function vagueRows(rows: ListaProducto[], text: string): ListaProducto[] {
  if (!isVagueListaQuery(text)) return [];
  const folded = foldListaText(text);
  const cleaning = /\blimpieza|\blimpiar|\blimpiador/.test(folded);
  const soda = /\brefresco|\bsoda/.test(folded);
  return rows.filter((row) => {
    const name = foldListaText(row.nombre);
    // La categoría «limpiadores de piso» junta trapeadores y Cloralex.
    // El pedido vago se queda en las marcas de limpieza, no en todo el pasillo.
    if (cleaning) return /\b(?:fabuloso|pinol|cloro|limpiadores?|limpiadoras?)\b/.test(name);
    if (soda) return /\b(coca|sprite|pepsi|mirinda|seven|sidral|manzanita)\b/.test(name);
    if (isCondomQuery(text)) return /\bsico\b/.test(name);
    return false;
  });
}

function pickVague(rows: ListaProducto[], limit: number): ListaProducto[] {
  const groups = new Map<string, ListaProducto[]>();
  for (const row of rows) {
    const key = vagueFamily(row.nombre);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const cap = Math.max(1, Math.min(limit, 8));
  const lists = [...groups.keys()].sort().map((key) => groups.get(key) ?? []);
  if (lists.length >= 2) {
    const picked: ListaProducto[] = [];
    for (const list of lists) {
      list.sort((a, b) => a.nombre.length - b.nombre.length || a.nombre.localeCompare(b.nombre));
      const piece = list.find((row) => !/\b(cj|caja|cajas|paquete|paquetes|paq)\b/.test(foldListaText(row.nombre)));
      picked.push(piece ?? list[0]);
      if (picked.length >= cap) break;
    }
    return picked;
  }
  const only = lists[0] ?? [];
  return only.slice(0, Math.min(cap, 5));
}

export function rankListaCandidates(rows: ListaProducto[], text: string, limit = LISTA_SEARCH_LIMIT): ListaProducto[] {
  const aliased = aliasCreamCheese(rows, text);
  // «refresco» también es el nombre de 7up. La familia (Coca, Pepsi) va primero.
  if (isVagueListaQuery(text)) {
    const vague = pickVague(vagueRows(aliased, text), limit);
    if (vague.length) return vague;
  }
  const must = listaSearchTokens(text);
  const ranked = rankListaByTokens(aliased, listaRankTokens(text), limit, listaPackageKey(text), must);
  if (ranked.length) return preferPhiladelphia(ranked, aliased, text, limit);
  return pickVague(vagueRows(aliased, text), limit);
}

function preferPhiladelphia(ranked: ListaProducto[], rows: ListaProducto[], text: string, limit: number): ListaProducto[] {
  const folded = foldListaText(text);
  if (!/\bqueso\b/.test(folded) || !/\bcrema\b/.test(folded)) return ranked;
  const cream = rows.filter((row) => /\bphiladelphia\b/.test(foldListaText(row.nombre)));
  if (!cream.length) return ranked;
  const seen = new Set(ranked.map((row) => row.nombre));
  const extra = cream.filter((row) => !seen.has(row.nombre));
  const head = [...cream.filter((row) => seen.has(row.nombre)), ...extra].slice(0, 3);
  const rest = ranked.filter((row) => !head.some((item) => item.nombre === row.nombre));
  return [...head, ...rest].slice(0, Math.max(limit, head.length));
}
