/**
 * Bebidas alcohólicas fuera de la app.
 * El bot de WhatsApp no usa este módulo: solo el catálogo, la búsqueda
 * y el pedido de /app. No borra filas de productos_tienda.
 *
 * La coincidencia es por palabra completa. "vinagre" no es "vino",
 * "chicharrón" no es "ron", y "Alka-Seltzer" no es un seltzer.
 */

const ALCOHOL_CATEGORIES = new Set(["cerveza", "vinos y licores"]);

/** Palabras que por sí solas nombran una bebida alcohólica. */
const ALCOHOL_WORDS = new Set([
  "cerveza",
  "chela",
  "chelas",
  "caguama",
  "caguamon",
  "vino",
  "vinos",
  "tequila",
  "mezcal",
  "ron",
  "vodka",
  "whisky",
  "whiskey",
  "brandy",
  "ginebra",
  "licor",
  "sotol",
  "pulque",
  "cooler",
  "tecate",
  "boones",
  "boone",
  "bacardi",
  "smirnoff",
  "jimador",
  "cuervo",
  "malibu",
  "kahlua",
  "strongbow",
  "buzzballz",
  "buzzball",
]);

/** Frases. "corona light" no bloquea el chorizo Corona ni el paletón. */
const ALCOHOL_PHRASES = [
  "corona light",
  "corona extra",
  "dos equis",
  "carta blanca",
  "bud light",
  "budlight",
  "jack daniel",
  "red label",
  "caribe cooler",
  "clamato preparado",
  "clamato preparada",
  "jose cuervo",
  "torres 10",
  "don pedro",
  "azteca de oro",
  "viva villa",
  "sol clamato",
  "sol mezclas",
  "buzz ball",
  "stella rosa",
  "high life",
];

/**
 * Marcas que también venden comida u otra cosa.
 * Solo cuentan si el nombre es la marca (y el tamaño) o viene con una seña de cerveza.
 */
const AMBIGUOUS_BRANDS = ["corona", "victoria", "modelo", "sol", "mega", "six", "barril", "presidente", "indio", "pacifico", "xx"];

const SIZE_WORDS = new Set([
  "light",
  "extra",
  "lata",
  "laton",
  "lager",
  "mega",
  "six",
  "caguama",
  "caguamon",
  "chela",
  "chelas",
  "bote",
  "botella",
  "nr",
  "retornable",
  "vidrio",
  "pack",
  "sixpack",
]);

const BEER_CUES = new Set(["cerveza", "chela", "chelas", "caguama", "caguamon", "laton", "michelada", "chelada", "clamato"]);

export function foldAlcoholText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(folded: string): string[] {
  return folded.split(" ").filter(Boolean);
}

function isSizeToken(token: string): boolean {
  if (SIZE_WORDS.has(token)) return true;
  return /^\d+(\.\d+)?(ml|l|lt|g|kg|oz|pz|pzas)?$/.test(token);
}

function isBareBrand(tokens: string[], brand: string): boolean {
  if (!tokens.includes(brand)) return false;
  return tokens.every((token) => token === brand || isSizeToken(token));
}

function isNonAlcoholic(folded: string, tokens: Set<string>): boolean {
  if (folded.includes("cerveza de raiz")) return true;
  if (
    folded.includes("sin alcohol")
    || folded.includes("sin alchol")
    || folded.includes("0 alcohol")
    || folded.includes("0 alchol")
    || folded.includes("alcohol free")
  ) {
    return true;
  }
  if (tokens.has("alka") && tokens.has("seltzer")) return true;
  if (tokens.has("sangrita")) return true;
  return false;
}

export function isBebidaAlcoholica(nombre: string, categoria?: string | null): boolean {
  const folded = foldAlcoholText(nombre);
  if (!folded) return false;
  const tokens = tokensOf(folded);
  const tokenSet = new Set(tokens);
  if (isNonAlcoholic(folded, tokenSet)) return false;

  const cat = foldAlcoholText(categoria ?? "");
  if (ALCOHOL_CATEGORIES.has(cat)) return true;

  if (tokens.some((token) => ALCOHOL_WORDS.has(token))) return true;
  if (ALCOHOL_PHRASES.some((phrase) => folded.includes(phrase))) return true;

  if (tokenSet.has("seltzer")) return true;
  if ((tokenSet.has("michelada") || tokenSet.has("chelada")) && !isMicheladaDeAdorno(folded, tokenSet, cat)) return true;
  if (tokenSet.has("rompope") && !isRompopeDeDulce(folded, tokenSet, cat)) return true;
  if (tokenSet.has("licores") && !isLicorDeDulce(folded, tokenSet, cat)) return true;
  if (tokenSet.has("clamato") && tokens.some((token) => AMBIGUOUS_BRANDS.includes(token) || token === "preparado" || token === "preparada" || token === "chelada" || token === "michelada")) {
    return true;
  }

  for (const brand of AMBIGUOUS_BRANDS) {
    if (!tokenSet.has(brand)) continue;
    if (isBareBrand(tokens, brand)) return true;
    if (tokens.some((token) => BEER_CUES.has(token) && token !== brand)) return true;
  }
  return false;
}

function isMicheladaDeAdorno(folded: string, tokens: Set<string>, cat: string): boolean {
  if (tokens.has("veladora") || tokens.has("vela") || tokens.has("veladora")) return true;
  if (folded.includes("veladora") || folded.includes("aromatizante")) return true;
  return cat.includes("vela") || cat.includes("aroma") || cat.includes("sazon") || cat.includes("especie");
}

function isRompopeDeDulce(folded: string, tokens: Set<string>, cat: string): boolean {
  if (cat === "dulceria" || cat.includes("flan") || cat.includes("galleta")) return true;
  return tokens.has("dgari") || tokens.has("cocada") || tokens.has("gelatina") || tokens.has("flan") || folded.includes("bon o bon");
}

function isLicorDeDulce(folded: string, tokens: Set<string>, cat: string): boolean {
  if (cat === "dulceria") return true;
  return tokens.has("chocolate") || folded.includes("bon o bon");
}

/**
 * Pasillo de cerveza y licores, con las excepciones que sí se venden:
 * Heineken 0, sangrita y lo que diga "sin alcohol".
 * PostgREST une estos OR y después niega el patrón de nombres.
 */
export const ALCOHOL_AISLE_OR = [
  "categoria.is.null",
  'and(categoria.not.eq.cerveza,categoria.not.eq."vinos y licores")',
  "nombre_producto.ilike.*sangrita*",
  'nombre_producto.ilike."*0 alchol*"',
  'nombre_producto.ilike."*0 alcohol*"',
  'nombre_producto.ilike."*sin alcohol*"',
  'nombre_producto.ilike."*sin alchol*"',
  'nombre_producto.ilike."*cerveza de raiz*"',
].join(",");

export const ALCOHOL_NAME_IMATCH = [
  "\\y(",
  [
    "vino",
    "vinos",
    "tequila",
    "mezcal",
    "ron",
    "vodka",
    "whisky",
    "whiskey",
    "brandy",
    "ginebra",
    "sotol",
    "pulque",
    "licor",
    "cooler",
    "chela",
    "chelas",
    "caguama",
    "caguamon",
    "tecate",
    "boone",
    "boones",
    "bacardi",
    "smirnoff",
    "jimador",
    "cuervo",
    "malibu",
    "kahlua",
    "strongbow",
    "buzzballz",
    "buzzball",
  ].join("|"),
  ")\\y|",
  ALCOHOL_PHRASES.join("|"),
].join("");
