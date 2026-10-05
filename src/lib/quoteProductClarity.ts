import type { PedidoItemInput } from "@/lib/services/captureEngine";

/**
 * Precisión de productos en tiendas que cotizan (sin menú fijo).
 * No es un catálogo: la marca que diga el cliente vale, aunque no esté
 * en los ejemplos. Aquí solo vive qué hay que preguntar (marca, presentación
 * que cambia lo que se baja del anaquel, y cantidad) y el texto corto.
 * Verdura y granel suelto no inventan marca: piden kilos y, si cambia el
 * producto, el tipo (cebolla blanca vs morada). Jitomate es solo kilos.
 */

type SlotId = "marca" | "tipo" | "tamano" | "cantidad";

type Category = {
  id: string;
  nombre: string;
  match: RegExp;
  exclude?: RegExp;
  /** Verdura a granel: no se inventa marca. Empaquetado: marca, presentación y cantidad van aparte. */
  kind?: "produce" | "packaged";
  /** El número de litros/ml/gramos es el tamaño del empaque, no cuántos llevar. */
  countSeparate?: boolean;
  skip?: (blob: string) => boolean;
  slots: SlotId[];
  filled: (slot: SlotId, blob: string, item: PedidoItemInput) => boolean;
  ask: (missing: SlotId[], item: PedidoItemInput, blob: string) => string;
  typePhrase?: (blob: string) => string | null;
  sizePhrase?: (blob: string) => string | null;
  label?: (blob: string) => string;
};

const FOLLOW_LA = "Con eso ya la anoto y seguimos el mandado.";
const FOLLOW_LO = "Con eso ya lo anoto y seguimos el mandado.";
const FOLLOW_LOS = "Con eso ya los anoto y seguimos el mandado.";

const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "veinte", "treinta",
  "y", "o", "e", "con", "sin", "por", "para", "que", "se", "al", "lo", "les",
  "su", "sus", "mi", "mis", "tu", "tus", "en", "es", "son", "me", "te", "le",
  "quiero", "dame", "denme", "traeme", "manda", "mande", "mandado", "anota",
  "seria",
  "anotala", "anotalo", "anotar", "porfa", "favor", "porfavor", "gracias",
  "hola", "buenas", "bueno", "entonces", "nomas", "solo", "pura", "puro",
  "tambien", "ademas", "ejemplo", "esta", "este", "eso", "esa", "mas", "muy",
  "bien", "ok", "va", "dale", "sale", "ocupa", "necesito", "pide", "pedir",
  "cotiza", "cotizar", "tienda", "abarrotes", "marca", "presentacion",
  "tamano", "tipo", "cual", "como", "cuando", "donde", "producto", "productos",
  "antoja", "antojo", "hacer", "trae", "traes", "tienes", "hay", "ocupo",
  "xfa", "porfis", "tambien", "otro", "otra", "otros", "otras",
  "leche", "agua", "papel", "higienico", "higienicos", "refresco", "refrescos",
  "refa", "huevo", "huevos", "pan", "tortilla", "tortillas", "aceite", "arroz",
  "frijol", "frijoles", "detergente", "jabon", "cerveza", "cigarro", "cigarros",
  "litro", "litros", "ml", "kilo", "kilos", "kg", "gramo", "gramos", "paquete",
  "paquetes", "pieza", "piezas", "bolsa", "bolsas", "caja", "cajas", "rollo",
  "rollos", "garrafon", "garrafones", "bidon", "lata", "latas", "botella",
  "botellas", "caguama", "caguamas", "six", "media", "medio", "docena",
  "docenas", "carton", "cartones", "cajetilla", "cajetillas", "barra", "barras",
  "entera", "deslactosada", "light", "descremada", "semidescremada", "lactosa",
  "organica", "chocolate", "chocolatada", "fresa", "natural", "mineral",
  "blanco", "blanca", "rojo", "roja", "negro", "negra", "bayo", "peruano",
  "peruanos", "maiz", "harina", "bolillo", "bolillos", "telera", "teleras",
  "birote", "birotes", "vegetal", "oliva", "liquido", "liquida", "polvo",
  "familiar", "vidrio", "dulce", "gas", "barata", "barato", "economica",
  "economico", "cualquiera", "haya", "tengas", "igual", "sea",
  "generica", "genericas", "generico", "genericos",
  "chico", "chica", "chicos", "chicas", "mediano", "mediana", "medianos", "medianas", "grande", "grandes", "bolsaza", "jumbo",
  "individual", "frasco", "frascos", "sobre", "sobres", "tubo",
  "mayonesa", "mayonesas", "mayo", "crema", "gomita", "gomitas",
  "papa", "papas", "galleta", "galletas", "queso", "quesos",
  "cloro", "limpiador", "limpiadores",
  "jitomate", "jitomates", "tomate", "tomates", "cebolla", "cebollas",
  "cilantro", "perejil", "limon", "limones", "chile", "chiles",
  "zanahoria", "zanahorias", "pepino", "pepinos", "lechuga", "lechugas",
  "aguacate", "aguacates", "platano", "platanos", "manzana", "manzanas",
  "naranja", "naranjas", "ajo", "ajos", "calabaza", "calabazas",
  "elote", "elotes", "repollo", "col", "brocoli", "chayote", "chayotes",
  "ejote", "ejotes",   "nopal", "nopales", "sandia", "melon", "pina",
  "azucar", "horchata", "jamaica", "tamarindo", "tank", "tanks", "tanque", "tanques",
  "quieres",
  "mango", "mangos", "papaya", "papayas", "cebollin", "rabano",
  "betabel", "camote", "camotes", "jicama", "apio", "espinaca",
  "verduraga", "verdolaga", "epazote", "hierbabuena", "guayaba",
  "mandarina", "pera", "uvas", "uva", "lima", "saladet", "saladette",
]);

const ROLL_COUNTS = "(?:4|6|8|12|16|18|24|32|40)";

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

export function waiverNote(value: string): string | null {
  const text = norm(value);
  if (!text) return null;
  if (/\b(mas barat\w*|mas economic\w*)\b/.test(text)) return "la más barata";
  if (
    /\b(del que sea|de la que sea|de lo que sea|la que sea|el que sea|lo que sea|cualquiera|lo que haya|la que haya|el que haya|me da igual|da igual|como sea|la que tengas|el que tengas|lo que tengas)\b/.test(
      text,
    )
  ) {
    return "la que sea";
  }
  return null;
}

function blobOf(item: PedidoItemInput, extra = ""): string {
  return norm(
    [
      item.nombre_producto,
      item.marca,
      item.presentacion,
      item.unidad,
      item.notas,
      item.cantidad != null ? String(item.cantidad) : "",
      extra,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function hasAmount(blob: string, item: PedidoItemInput): boolean {
  if (typeof item.cantidad === "number" && Number.isFinite(item.cantidad) && item.cantidad > 0) return true;
  return /\b(\d+|kilo|kilos|kg|docena|docenas)\b/.test(blob);
}

function hasBrand(blob: string, ignore: Set<string>): boolean {
  if (/\bgeneric\w*\b/.test(blob)) return true;
  if (/\b1\s*2\s*3\b|\b123\b/.test(blob)) return true;
  return blob.split(" ").some((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP.has(token) && !ignore.has(token));
}

function spokenBrand(item: PedidoItemInput): string | null {
  const marca = clean(item.marca);
  if (!marca) return null;
  const token = norm(marca);
  if (/\bgeneric\w*\b/.test(token) || waiverNote(token)) return null;
  return marca;
}

function brandTokens(blob: string, ignore: Set<string>): string[] {
  const tokens = blob.split(" ").filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP.has(token) && !ignore.has(token));
  if (/\b1\s*2\s*3\b|\b123\b/.test(blob)) tokens.unshift("1-2-3");
  return tokens;
}

function niceWord(word: string): string {
  if (word === "1-2-3") return word;
  if (/[A-ZÁÉÍÓÚÑ]/.test(word.slice(1))) return word;
  return word.charAt(0).toLocaleUpperCase("es-MX") + word.slice(1);
}

function displayBrand(original: string, tokens: string[]): string {
  const words = original.split(/\s+/);
  const used = new Set<number>();
  return tokens
    .map((token) => {
      if (token === "1-2-3") return token;
      const idx = words.findIndex((word, index) => {
        if (used.has(index)) return false;
        const cleanWord = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        const normalized = norm(cleanWord);
        // "Sam's" se normaliza a "sam s": el token de marca es "sam".
        return normalized === token || normalized.split(" ")[0] === token;
      });
      if (idx >= 0) {
        used.add(idx);
        return niceWord(words[idx].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
      }
      return niceWord(token);
    })
    .join(" ");
}

const QTY_WORDS: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  unos: 1,
  unas: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  media: 0.5,
  medio: 0.5,
};

function wordToQty(token: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return QTY_WORDS[token] ?? null;
}

function parseQty(blob: string): number | null {
  let bestAt = Number.POSITIVE_INFINITY;
  let best: number | null = null;
  const tokens = blob.split(" ");
  tokens.forEach((token, index) => {
    const qty = wordToQty(token);
    if (qty == null || index >= bestAt) return;
    bestAt = index;
    best = qty;
  });
  return best;
}

function qtyBeforeUnit(blob: string, unit: RegExp): number | null {
  const match = blob.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|media|medio)\\s+${unit.source}`));
  if (!match) return null;
  return wordToQty(match[1]);
}

function mergeText(current: string | null | undefined, addition: string | null): string | null {
  if (!addition) return clean(current);
  const prev = clean(current);
  if (!prev) return addition;
  if (norm(prev).includes(norm(addition))) return prev;
  return `${prev} ${addition}`.trim();
}

function lecheTipo(blob: string): string | null {
  if (/\b(deslactosada|sin lactosa)\b/.test(blob)) return "deslactosada";
  if (/\b(light|descremada|semidescremada)\b/.test(blob)) return "light";
  if (/\borganica\b/.test(blob)) return "orgánica";
  if (/\b(chocolate|chocolatada)\b/.test(blob)) return "chocolate";
  if (/\bfresa\b/.test(blob)) return "fresa";
  if (/\bentera\b/.test(blob)) return "entera";
  return null;
}

const LITER_QTY = "\\d+(?:\\.\\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|media|medio";
const LITER_UNIT = "lts|lt|litros?|l";

function literPhraseFromQty(qty: number | null): string {
  if (qty == null || qty === 1) return "1 litro";
  return `${qty} litros`;
}

// "1 l", "de 1 l", "un litro" y "l" suelto cuentan como tamaño. La abreviatura
// guardada en unidad ("l") no cierra sola: vive dentro del producto y no trae
// la palabra "litro", así que la pregunta seguiría. Esa unidad se reemplaza
// cuando el cliente contesta el tamaño (ver applyDetail).
function litrosPhrase(blob: string): string | null {
  const ml = blob.match(/\b(\d+)\s*ml\b/);
  if (ml) return `${ml[1]} ml`;
  const withQty = blob.match(new RegExp(`\\b(${LITER_QTY})\\s*(?:${LITER_UNIT})\\b`));
  if (withQty) return literPhraseFromQty(wordToQty(withQty[1]));
  if (/\blitros?\b/.test(blob)) return "1 litro";
  if (/^(?:de\s+)?(?:l|lt|lts)$/.test(blob)) return "1 litro";
  return null;
}

function bareLiterQuantity(extra: string): number | null {
  const match = extra.match(/^(?:de\s+)?(\d+(?:\.\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|media|medio)$/);
  if (!match) return null;
  return wordToQty(match[1]);
}

function isLiterAbbrev(value: string | null | undefined): boolean {
  const unit = norm(String(value ?? ""));
  return unit === "l" || unit === "lt" || unit === "lts" || unit === "litro" || unit === "litros";
}

function rollPhrase(blob: string): string | null {
  const match = blob.match(new RegExp(`\\b(${ROLL_COUNTS})\\b`));
  return match ? `${match[1]} rollos` : null;
}

const SIZE_UNITS = new Set([
  "litro", "litros", "l", "lt", "lts", "ml", "g", "gr", "gramo", "gramos", "kg", "kilo", "kilos", "rollo", "rollos",
]);

function parsePackageCount(blob: string): number | null {
  const tokens = blob.split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const qty = wordToQty(tokens[index]);
    if (qty == null) continue;
    const next = tokens[index + 1] ?? "";
    if (SIZE_UNITS.has(next)) continue;
    if (/^\d{2,4}$/.test(tokens[index]) && !/^(paquete|paquetes|pieza|piezas|lata|latas|botella|botellas|frasco|frascos|caja|cajas|bolsa|bolsas)$/.test(next)) {
      continue;
    }
    return qty;
  }
  return null;
}

function sizeNumber(blob: string): number | null {
  const sized = blob.match(/\b(\d+(?:\.\d+)?)\s*(?:ml|g|gr|gramos|kg|kilos?|litros?)\b/);
  if (sized) return Number(sized[1]);
  const bare = blob.match(/\bde\s+(\d{2,4})\b/);
  if (bare) return Number(bare[1]);
  return null;
}

function hasPackageCount(blob: string, item: PedidoItemInput): boolean {
  if (parsePackageCount(blob) != null) return true;
  if (typeof item.cantidad === "number" && Number.isFinite(item.cantidad) && item.cantidad > 0) {
    const sized = sizeNumber(blob);
    if (sized != null && item.cantidad === sized) return false;
    return true;
  }
  return false;
}

function foldSizeWords(blob: string): string {
  return blob
    .replace(/\bgrandes\b/g, "grande")
    .replace(/\bchicos\b/g, "chico")
    .replace(/\bchicas\b/g, "chica")
    .replace(/\bmedianos\b/g, "mediano")
    .replace(/\bmedianas\b/g, "mediana");
}

function hasShelfPresentation(blob: string): boolean {
  const text = foldSizeWords(blob);
  if (/\b(chico|chica|mediano|mediana|grande|familiar|jumbo|bolsaza|individual)\b/.test(text)) return true;
  if (/\b\d+(?:\.\d+)?\s*(g|gr|gramos|ml|kg|kilos?|litros?)\b/.test(text)) return true;
  if (/\b(litro|litros|ml|gramos|garrafon|bolsaza)\b/.test(text)) return true;
  if (/\bde\s+\d{2,4}\b/.test(text)) return true;
  if (/\b(frasco|sobre|lata|botella|caja|bolsa|tubo)\b/.test(text) && /\b(chico|chica|mediano|mediana|grande|familiar|kilo|litros?|\d+)\b/.test(text)) {
    return true;
  }
  return false;
}

function shelfPhrase(blob: string): string | null {
  const text = foldSizeWords(blob);
  const grams = text.match(/\b(\d+(?:\.\d+)?)\s*(?:g|gr|gramos)\b/);
  if (grams) return `${grams[1]} g`;
  const ml = text.match(/\b(\d+)\s*ml\b/);
  if (ml) return `${ml[1]} ml`;
  if (/\bbolsaza\b/.test(text)) return "bolsaza";
  if (/\bjumbo\b/.test(text)) return "jumbo";
  if (/\bfamiliar\b/.test(text)) return "familiar";
  const litros = litrosPhrase(text);
  if (litros) return litros;
  if (/\b(kilo|kilos|kg)\b/.test(text)) return "1 kilo";
  if (/\bgarrafon(?:es)?\b/.test(text)) return "garrafón";
  const sizeWord = text.match(/\b(chica|chico|mediana|mediano|grande|individual)\b/);
  const container = text.match(/\b(frasco|sobre|lata|botella|caja|bolsa|tubo)\b/);
  if (container && sizeWord) return `${container[1]} ${sizeWord[1]}`;
  if (sizeWord) return sizeWord[1];
  if (container && /\b\d+\b/.test(text)) return container[1];
  const bare = text.match(/\bde\s+(\d{2,4})\b/);
  if (bare) return `${bare[1]} g`;
  return null;
}

function joinSpanish(bits: string[]): string {
  const cleanBits = bits.filter(Boolean);
  if (cleanBits.length <= 1) return cleanBits[0] ?? "";
  if (cleanBits.length === 2) return `${cleanBits[0]} y ${cleanBits[1]}`;
  return `${cleanBits.slice(0, -1).join(", ")} y ${cleanBits[cleanBits.length - 1]}`;
}

function countUnit(blob: string): string | null {
  // "dos Tanks/tanques de horchata": el tanque es el paquete del preparado.
  if (/\b(tanks?|tanques?)\b/.test(blob)) return "paquete";
  const unit = blob.match(/\b(paquetes|paquete|piezas|pieza|frascos|frasco|latas|lata|botellas|botella|cajas|caja|bolsas|bolsa)\b/);
  if (!unit) return null;
  const mapped: Record<string, string> = {
    paquetes: "paquete",
    piezas: "pieza",
    frascos: "frasco",
    latas: "lata",
    botellas: "botella",
    cajas: "caja",
    bolsas: "bolsa",
  };
  return mapped[unit[1]] ?? unit[1];
}

const PRODUCE_LABELS: Array<[RegExp, string, "el" | "la"]> = [
  [/\bjitomates?\b/, "Jitomate", "el"],
  [/\btomates?\b/, "Tomate", "el"],
  [/\bcebollas?\b/, "Cebolla", "la"],
  [/\bcilantro\b/, "Cilantro", "el"],
  [/\bperejil\b/, "Perejil", "el"],
  [/\blimones?\b/, "Limón", "el"],
  [/\bchiles?\b/, "Chile", "el"],
  [/\bzanahorias?\b/, "Zanahoria", "la"],
  [/\bpepinos?\b/, "Pepino", "el"],
  [/\blechugas?\b/, "Lechuga", "la"],
  [/\baguacates?\b/, "Aguacate", "el"],
  [/\bplatanos?\b/, "Plátano", "el"],
  [/\bmanzanas?\b/, "Manzana", "la"],
  [/\bnaranjas?\b/, "Naranja", "la"],
  [/\bajos?\b/, "Ajo", "el"],
  [/\bcalabazas?\b/, "Calabaza", "la"],
  [/\belotes?\b/, "Elote", "el"],
  [/\brepollo\b|\bcoles?\b/, "Repollo", "el"],
  [/\bbrocoli\b/, "Brócoli", "el"],
  [/\bchayotes?\b/, "Chayote", "el"],
  [/\bejotes?\b/, "Ejote", "el"],
  [/\bnopales?\b/, "Nopal", "el"],
  [/\bsandia\b/, "Sandía", "la"],
  [/\bmelon\b/, "Melón", "el"],
  [/\bpina\b/, "Piña", "la"],
  [/\bmangos?\b/, "Mango", "el"],
  [/\bpapayas?\b/, "Papaya", "la"],
  [/\bcebollin\b/, "Cebollín", "el"],
  [/\brabanos?\b/, "Rábano", "el"],
  [/\bbetabel\b/, "Betabel", "el"],
  [/\bcamotes?\b/, "Camote", "el"],
  [/\bjicama\b/, "Jícama", "la"],
  [/\bapio\b/, "Apio", "el"],
  [/\bespinaca\b/, "Espinaca", "la"],
  [/\bverdolaga\b/, "Verdolaga", "la"],
  [/\bepazote\b/, "Epazote", "el"],
  [/\bhierbabuena\b/, "Hierbabuena", "la"],
  [/\bguayaba\b/, "Guayaba", "la"],
  [/\bmandarina\b/, "Mandarina", "la"],
  [/\bperas?\b/, "Pera", "la"],
  [/\buvas?\b/, "Uva", "la"],
  [/\blimas?\b/, "Lima", "la"],
];

function produceHit(blob: string): { nombre: string; article: "el" | "la" } | null {
  for (const [re, nombre, article] of PRODUCE_LABELS) {
    if (re.test(blob)) return { nombre, article };
  }
  return null;
}

function onionType(blob: string): string | null {
  if (/\bcambray\b/.test(blob)) return "cambray";
  if (/\bmorad[ao]\b/.test(blob)) return "morada";
  if (/\bblanc[ao]\b/.test(blob)) return "blanca";
  return null;
}

function chileType(blob: string): string | null {
  if (/\bjalapeno\b/.test(blob)) return "jalapeño";
  if (/\bserrano\b/.test(blob)) return "serrano";
  if (/\bhabanero\b/.test(blob)) return "habanero";
  if (/\bpoblano\b/.test(blob)) return "poblano";
  if (/\bguero\b/.test(blob)) return "güero";
  if (/\barbol\b/.test(blob)) return "de árbol";
  if (/\bchipotle\b/.test(blob)) return "chipotle";
  if (/\bmorron\b/.test(blob)) return "morrón";
  return null;
}

// El color o la variedad solo cierran si el blob dice qué verdura es.
// Una respuesta corta («blanca», «jalapeño») no trae el nombre: applyDetail
// lo antepone desde la línea que ya estaba abierta.
function produceType(blob: string): string | null {
  const onion = /\bcebollas?\b/.test(blob);
  const chile = /\bchiles?\b/.test(blob);
  if (onion && !chile) return onionType(blob);
  if (chile && !onion) return chileType(blob);
  return null;
}

function produceNeedsType(blob: string): boolean {
  return /\bcebollas?\b/.test(blob) || /\bchiles?\b/.test(blob);
}

const PRODUCE_WORDS =
  /\b(jitomates?|tomates?|cebollas?|cilantro|perejil|limones?|chiles?|zanahorias?|pepinos?|lechugas?|aguacates?|platanos?|manzanas?|naranjas?|ajos?|calabazas?|elotes?|repollo|coles?|brocoli|chayotes?|ejotes?|nopales?|sandia|melon|pina|mangos?|papayas?|cebollin|rabanos?|betabel|camotes?|jicama|apio|espinaca|verdolaga|epazote|hierbabuena|guayaba|mandarina|peras?|uvas?|limas?)\b/;

function packagedFamily(opts: {
  id: string;
  nombre: string;
  match: RegExp;
  exclude?: RegExp;
  skip?: (blob: string) => boolean;
  article: string;
  example: string;
  shelfAsk: string;
  follow: string;
  emoji: string;
}): Category {
  return {
    id: opts.id,
    nombre: opts.nombre,
    match: opts.match,
    exclude: opts.exclude,
    skip: opts.skip,
    kind: "packaged",
    countSeparate: true,
    slots: ["marca", "tamano", "cantidad"],
    sizePhrase: shelfPhrase,
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      if (slot === "tamano") return hasShelfPresentation(blob);
      if (slot === "cantidad") return hasPackageCount(blob, item);
      return true;
    },
    ask: (missing, item, blob) => {
      const brand = spokenBrand(item);
      const brandArticle = brand && /\b(emperador|principe|oreo|red bull)\b/.test(norm(brand)) ? "El" : opts.article;
      const who = brand ? `${brandArticle} ${brand}` : `${opts.article} ${opts.nombre.toLocaleLowerCase("es-MX")}`;
      const bits: string[] = [];
      if (missing.includes("marca")) bits.push("de qué marca");
      if (missing.includes("tamano")) bits.push(opts.shelfAsk);
      if (missing.includes("cantidad")) bits.push("cuántos");
      const example = missing.includes("marca") ? `Por ejemplo ${opts.example}.` : "";
      return `Va. ${who}, ¿${joinSpanish(bits)}? ${example} ${opts.follow} ${opts.emoji}`.replace(/\s+/g, " ").trim();
    },
  };
}

const CATEGORIES: Category[] = [
  {
    id: "leche",
    nombre: "Leche",
    match: /\bleches?\b/,
    slots: ["marca", "tipo", "tamano"],
    typePhrase: lecheTipo,
    sizePhrase: litrosPhrase,
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      if (slot === "tipo") return lecheTipo(blob) != null;
      return litrosPhrase(blob) != null || (hasAmount(blob, item) && /\b(litro|litros|ml)\b/.test(blob));
    },
    ask: (missing) => {
      const size = missing.includes("tamano");
      const brand = missing.includes("marca");
      const type = missing.includes("tipo");
      if (brand && type && size) {
        return `Va. La leche, ¿de qué marca, de cuál (entera, deslactosada o light) y de cuántos litros? Por ejemplo Lala, Alpura o Santa Clara. ${FOLLOW_LA} 🥛`;
      }
      if (brand && type) {
        return `Va. La leche, ¿de qué marca y de cuál (entera, deslactosada o light)? Por ejemplo Lala, Alpura o Santa Clara. ${FOLLOW_LA} 🥛`;
      }
      if (brand && size) {
        return `Va. La leche, ¿de qué marca y de cuántos litros? Por ejemplo Lala, Alpura o Santa Clara. ${FOLLOW_LA} 🥛`;
      }
      if (type && size) {
        return `Va. La leche, ¿entera, deslactosada o light, y de cuántos litros? ${FOLLOW_LA} 🥛`;
      }
      if (brand) return `Va. ¿La leche de qué marca? Por ejemplo Lala, Alpura o Santa Clara. ${FOLLOW_LA} 🥛`;
      if (type) return `Va. ¿La leche entera, deslactosada o light? ${FOLLOW_LA} 🥛`;
      return `Va. ¿La leche de cuántos litros? ${FOLLOW_LA} 🥛`;
    },
  },
  {
    id: "papel",
    nombre: "Papel higiénico",
    match: /\bpapel higienico\b|\bhigienicos?\b|\bpapel\b/,
    exclude: /\b(aluminio|bond|estraza|encerado|mantequilla|seda)\b/,
    slots: ["marca", "tamano"],
    sizePhrase: rollPhrase,
    filled: (slot, blob) =>
      slot === "marca" ? hasBrand(blob, new Set()) : rollPhrase(blob) != null || /\b(caja|cajas|paquete|paquetes)\b/.test(blob),
    ask: (missing, item) => {
      const brandName = spokenBrand(item);
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El papel higiénico, ¿de qué marca, y es caja, paquete o de cuántos rollos (4, 12, 18 o 32)? Por ejemplo Pétalo, Regio o Suavel. ${FOLLOW_LO} 🧻`;
      }
      if (missing.includes("marca")) {
        return `Va. El papel, ¿de qué marca? Por ejemplo Pétalo, Regio o Suavel. ${FOLLOW_LO} 🧻`;
      }
      const who = brandName ? `El ${brandName}` : "El papel";
      return `Va. ${who}, ¿es caja, paquete o de cuántos rollos: 4, 12, 18 o 32? ${FOLLOW_LO} 🧻`;
    },
  },
  {
    id: "agua",
    nombre: "Agua",
    match: /\bagua\b|\baguas\b|\bgarrafon(?:es)?\b|\bbidon\b/,
    exclude: /\b(horchata|jamaica|tamarindo|limon|sandia|melon|guayaba|pina|fresca|de sabor)\b/,
    slots: ["marca", "tamano"],
    typePhrase: (blob) => (/\bmineral\b|\bcon gas\b/.test(blob) ? "mineral" : /\bnatural\b/.test(blob) ? "natural" : null),
    sizePhrase: (blob) => {
      if (/\bgarrafon(?:es)?\b|\bbidon\b/.test(blob)) return "garrafón";
      if (/\b(\d+)\s*ml\b/.test(blob)) {
        const ml = blob.match(/\b(\d+)\s*ml\b/);
        return ml ? `${ml[1]} ml` : null;
      }
      return litrosPhrase(blob);
    },
    filled: (slot, blob) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      return /\b(garrafon|bidon|litro|litros|ml|medio)\b/.test(blob);
    },
    ask: (missing, _item, blob) => {
      const hint = /\bgarrafon|bidon/.test(blob) ? "de garrafón" : /\blitro/.test(blob) ? "de litro" : "";
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El agua, ¿de qué marca y de qué tamaño (medio, litro o garrafón)? Por ejemplo Ciel, Bonafont o Epura. ${FOLLOW_LA} 💧`;
      }
      if (missing.includes("tamano")) {
        return `Va. El agua, ¿de qué tamaño: medio, litro o garrafón? ${FOLLOW_LA} 💧`;
      }
      const cual = hint ? `El agua ${hint}` : "El agua";
      return `Va. ${cual}, ¿de qué marca? Por ejemplo Ciel, Bonafont o Epura. ${FOLLOW_LA} 💧`;
    },
  },
  {
    id: "refresco",
    nombre: "Refresco",
    match: /\b(refrescos?|refa|coca|pepsi|sprite|fanta|sidral|manzanita|squirt|seven|mirinda|redbull|red bull|monster)\b/,
    countSeparate: true,
    slots: ["marca", "tamano", "cantidad"],
    sizePhrase: (blob) => {
      if (/\blata\b/.test(blob)) return "lata";
      const ml = blob.match(/\b(\d{2,4})\s*ml\b/);
      if (ml) return `${ml[1]} ml`;
      const bare = blob.match(/\b(\d{3})\b/);
      if (bare && !/\b(litro|litros|kilo|rollos)\b/.test(blob)) return `${bare[1]} ml`;
      if (/\bfamiliar\b/.test(blob)) return "familiar";
      if (/\bvidrio\b/.test(blob)) return "vidrio";
      return litrosPhrase(blob);
    },
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      if (slot === "cantidad") return hasPackageCount(blob, item);
      return /\b(lata|latas|ml|litro|litros|familiar|vidrio|medio)\b/.test(blob);
    },
    ask: (missing, item, blob) => {
      const brand = spokenBrand(item) || (/\bcoca\b/.test(blob) ? "Coca" : /\bred bull\b|\bredbull\b/.test(blob) ? "Red Bull" : null);
      const sizeLabel = clean(item.presentacion);
      const who = !brand ? "El refresco" : /^coca/i.test(brand) ? `La ${brand}` : brand;
      const whoSized = sizeLabel && !missing.includes("tamano") ? `${who} ${sizeLabel}` : who;
      const qty = missing.includes("cantidad");
      if (missing.includes("marca") && missing.includes("tamano") && qty) {
        return `Va. El refresco, ¿de qué marca, de qué tamaño (lata, 600 ml o de 2 litros) y cuántos? Por ejemplo Coca, Pepsi o Sprite. ${FOLLOW_LO} 🥤`;
      }
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El refresco, ¿de qué marca y de qué tamaño? Por ejemplo Coca, Pepsi o Sprite, lata, 600 ml o de 2 litros. ${FOLLOW_LO} 🥤`;
      }
      if (missing.includes("marca") && qty) {
        return `Va. ¿El refresco de qué marca y cuántos? Por ejemplo Coca, Pepsi o Sprite. ${FOLLOW_LO} 🥤`;
      }
      if (missing.includes("marca")) {
        return `Va. ¿El refresco de qué marca? Por ejemplo Coca, Pepsi o Sprite. ${FOLLOW_LO} 🥤`;
      }
      if (missing.includes("tamano") && qty) {
        return `Va. ${who}, ¿de qué tamaño (lata, 600 ml o de 2 litros) y cuántas? ${FOLLOW_LA} 🥤`;
      }
      if (qty) return `Va. ${whoSized}, ¿cuántas? ${FOLLOW_LA} 🥤`;
      return `Va. ${who}, ¿de qué tamaño: lata, 600 ml, de 2 litros o de 3? ${FOLLOW_LA} 🥤`;
    },
  },
  {
    id: "huevo",
    nombre: "Huevo",
    match: /\bhuevos?\b/,
    slots: ["tipo", "tamano"],
    typePhrase: (blob) => (/\brojo\b/.test(blob) ? "rojo" : /\bblanco\b/.test(blob) ? "blanco" : null),
    sizePhrase: (blob) => (/\bdocena\b/.test(blob) ? "docena" : /\b(kilo|kilos|kg)\b/.test(blob) ? "kilo" : null),
    filled: (slot, blob, item) => {
      if (slot === "tipo") return /\b(rojo|blanco)\b/.test(blob);
      return hasAmount(blob, item) || /\b(docena|kilo|kilos|kg|pieza|carton)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("tipo") && missing.includes("tamano")) {
        return `Va. El huevo, ¿blanco o rojo, y de cuánto (docena o kilo)? ${FOLLOW_LO} 🥚`;
      }
      if (missing.includes("tipo")) return `Va. El huevo, ¿blanco o rojo? ${FOLLOW_LO} 🥚`;
      return `Va. El huevo, ¿docena o por kilo? ${FOLLOW_LO} 🥚`;
    },
  },
  {
    id: "pan",
    nombre: "Pan",
    match: /\bpan\b|\bbolillos?\b|\bteleras?\b|\bbirotes?\b/,
    slots: ["tipo", "marca", "tamano"],
    typePhrase: (blob) => {
      if (/\b(bimbo|wonder|marinela|oroweat)\b|\bcaja\b/.test(blob)) return "de caja";
      if (/\bbolillos?\b/.test(blob)) return "bolillo";
      if (/\bteleras?\b/.test(blob)) return "telera";
      if (/\bbirotes?\b/.test(blob)) return "birote";
      if (/\bdulce\b/.test(blob)) return "dulce";
      return null;
    },
    filled: (slot, blob, item) => {
      const tipo = /\b(bimbo|wonder|marinela|oroweat|caja|bolillos?|teleras?|birotes?|dulce)\b/.test(blob);
      if (slot === "tipo") return tipo;
      if (slot === "marca") {
        const deCaja = /\b(caja|bimbo|wonder|marinela|oroweat)\b/.test(blob);
        if (!deCaja) return true;
        return hasBrand(blob, new Set());
      }
      return hasAmount(blob, item) || /\b(kilo|kilos|kg|pieza|piezas|bolsa|paquete)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("tipo")) {
        return `Va. El pan, ¿de cuál: bolillo, telera o de caja? Si es de caja, también la marca (Bimbo, Wonder). ${FOLLOW_LO} 🍞`;
      }
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El pan de caja, ¿de qué marca y de qué tamaño? Por ejemplo Bimbo o Wonder. ${FOLLOW_LO} 🍞`;
      }
      if (missing.includes("marca")) return `Va. El pan de caja, ¿de qué marca? Por ejemplo Bimbo o Wonder. ${FOLLOW_LO} 🍞`;
      return `Va. ¿Cuántas piezas, o de a kilo el pan? ${FOLLOW_LO} 🍞`;
    },
  },
  {
    id: "tortilla",
    nombre: "Tortilla",
    match: /\btortillas?\b/,
    slots: ["tipo", "tamano"],
    typePhrase: (blob) => (/\bharina\b/.test(blob) ? "de harina" : /\bmaiz\b/.test(blob) ? "de maíz" : null),
    sizePhrase: (blob) => (/\b(kilo|kilos|kg)\b/.test(blob) ? "kilo" : null),
    filled: (slot, blob, item) => {
      if (slot === "tipo") return /\b(harina|maiz)\b/.test(blob);
      return hasAmount(blob, item) || /\b(kilo|kilos|kg)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("tipo") && missing.includes("tamano")) {
        return `Va. Las tortillas, ¿de maíz o de harina, y de cuántos kilos? ${FOLLOW_LAS()} 🌮`;
      }
      if (missing.includes("tipo")) return `Va. Las tortillas, ¿de maíz o de harina? ${FOLLOW_LAS()} 🌮`;
      return `Va. Las tortillas, ¿de cuántos kilos? ${FOLLOW_LAS()} 🌮`;
    },
  },
  {
    id: "aceite",
    nombre: "Aceite",
    match: /\baceite\b/,
    slots: ["marca", "tamano"],
    sizePhrase: (blob) => litrosPhrase(blob) || (/\b(\d+)\s*ml\b/.test(blob) ? null : null),
    filled: (slot, blob) => (slot === "marca" ? hasBrand(blob, new Set()) : /\b(litro|litros|ml)\b/.test(blob)),
    ask: (missing) => {
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El aceite, ¿de qué marca y de qué tamaño? Por ejemplo Nutrioli, 1-2-3 o Capullo, de 1 litro o de 5. ${FOLLOW_LO} 🫙`;
      }
      if (missing.includes("marca")) {
        return `Va. ¿El aceite de qué marca? Por ejemplo Nutrioli, 1-2-3 o Capullo. ${FOLLOW_LO} 🫙`;
      }
      return `Va. ¿El aceite de qué tamaño, de 1 litro o de 5? ${FOLLOW_LO} 🫙`;
    },
  },
  {
    id: "arroz",
    nombre: "Arroz",
    match: /\barroz\b/,
    slots: ["marca", "tamano"],
    sizePhrase: (blob) => (/\b(kilo|kilos|kg)\b/.test(blob) ? "kilo" : /\b(\d+)\s*g\b/.test(blob) ? blob.match(/\b(\d+)\s*g\b/)?.[0] ?? null : null),
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      return hasAmount(blob, item) || /\b(kilo|kilos|kg|g|gramos|bolsa)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El arroz, ¿de qué marca y de cuánto? Por ejemplo SOS, Verde Valle o Morelos, de kilo o de 900 g. ${FOLLOW_LO} 🍚`;
      }
      if (missing.includes("marca")) return `Va. ¿El arroz de qué marca? Por ejemplo SOS, Verde Valle o Morelos. ${FOLLOW_LO} 🍚`;
      return `Va. ¿El arroz de cuánto, de kilo o de 900 g? ${FOLLOW_LO} 🍚`;
    },
  },
  {
    id: "frijol",
    nombre: "Frijol",
    match: /\bfrijol(?:es)?\b/,
    slots: ["tipo", "tamano"],
    typePhrase: (blob) => {
      if (/\bnegr[ao]\b/.test(blob)) return "negro";
      if (/\bbayo\b/.test(blob)) return "bayo";
      if (/\bperuan[ao]\b/.test(blob)) return "peruano";
      if (/\bpinto\b/.test(blob)) return "pinto";
      if (/\bflor\b/.test(blob)) return "flor de mayo";
      return null;
    },
    sizePhrase: (blob) => (/\b(kilo|kilos|kg)\b/.test(blob) ? "kilo" : null),
    filled: (slot, blob, item) => {
      if (slot === "tipo") return /\b(negro|bayo|peruano|pinto|flor)\b/.test(blob);
      return hasAmount(blob, item) || /\b(kilo|kilos|kg|bolsa|g)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("tipo") && missing.includes("tamano")) {
        return `Va. El frijol, ¿de cuál y de cuánto? Negro, bayo o peruano, por kilo. Si traes marca (La Sierra, Verde Valle), también. ${FOLLOW_LO} 🫘`;
      }
      if (missing.includes("tipo")) return `Va. El frijol, ¿negro, bayo o peruano? ${FOLLOW_LO} 🫘`;
      return `Va. ¿El frijol de cuánto, por kilo? ${FOLLOW_LO} 🫘`;
    },
  },
  {
    id: "lentejas",
    nombre: "Lentejas",
    match: /\blentejas?\b/,
    slots: ["tamano"],
    sizePhrase: (blob) => (/\b(kilo|kilos|kg)\b/.test(blob) ? "kilo" : null),
    filled: (slot, blob, item) => slot === "tamano" && (hasAmount(blob, item) || /\b(kilo|kilos|kg|bolsa)\b/.test(blob)),
    ask: () => `Va. Las lentejas, ¿de cuántos kilos? ${FOLLOW_LAS()} 🫘`,
  },
  {
    id: "detergente",
    nombre: "Detergente",
    match: /\bdetergente\b|\bjabon en polvo\b|\bjabon para ropa\b/,
    slots: ["marca", "tamano"],
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      return hasAmount(blob, item) || /\b(kilo|kilos|kg|g|gramos|litro|litros|ml|bolsa|polvo|liquido)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El detergente, ¿de qué marca y de qué presentación (kilo o líquido)? Por ejemplo Roma, Ace o Ariel. ${FOLLOW_LO} 🧼`;
      }
      if (missing.includes("marca")) return `Va. ¿El detergente de qué marca? Por ejemplo Roma, Ace o Ariel. ${FOLLOW_LO} 🧼`;
      return `Va. ¿El detergente de kilo o líquido, y de cuánto? ${FOLLOW_LO} 🧼`;
    },
  },
  {
    id: "jabon",
    nombre: "Jabón",
    match: /\bjabon\b/,
    exclude: /\b(detergente|en polvo|para ropa|para trastes)\b/,
    slots: ["marca", "tipo"],
    typePhrase: (blob) => (/\b(liquido|liquida)\b/.test(blob) ? "líquido" : /\b(barra|tocador)\b/.test(blob) ? "de barra" : null),
    filled: (slot, blob) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      return /\b(barra|tocador|liquido|liquida|ml|litro)\b/.test(blob);
    },
    ask: (missing) => {
      if (missing.includes("marca") && missing.includes("tipo")) {
        return `Va. El jabón, ¿de qué marca y de barra o líquido? Por ejemplo Zote, Palmolive o Escudo. ${FOLLOW_LO} 🧼`;
      }
      if (missing.includes("marca")) return `Va. ¿El jabón de qué marca? Por ejemplo Zote, Palmolive o Escudo. ${FOLLOW_LO} 🧼`;
      return `Va. ¿El jabón es de barra o líquido? ${FOLLOW_LO} 🧼`;
    },
  },
  {
    id: "cerveza",
    nombre: "Cerveza",
    match: /\bcervezas?\b|\bcaguamas?\b|\bsix\b|\b(?:corona|modelo|victoria|pacifico|tecate|indio)\b/,
    countSeparate: true,
    slots: ["marca", "tamano", "cantidad"],
    sizePhrase: (blob) => {
      if (/\bsix\b/.test(blob)) return "six";
      if (/\bcaguama\b/.test(blob)) return "caguama";
      if (/\bmedia\b/.test(blob)) return "media";
      if (/\blata\b/.test(blob)) return "lata";
      if (/\bfamiliar\b/.test(blob)) return "familiar";
      if (/\bbotella\b/.test(blob)) return "botella";
      return null;
    },
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      if (slot === "cantidad") return hasPackageCount(blob, item);
      return /\b(six|caguama|media|lata|familiar|botella|cuarto|ml)\b/.test(blob);
    },
    ask: (missing, item) => {
      const brand = spokenBrand(item);
      const who = brand ? `La ${brand}` : "La cerveza";
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. La cerveza, ¿de qué marca y de cuál presentación (lata, media, caguama o six)? Por ejemplo Corona, Victoria o Modelo. ${FOLLOW_LA} 🍺`;
      }
      if (missing.includes("marca") && missing.includes("cantidad")) {
        return `Va. ¿La cerveza de qué marca y cuántas? Por ejemplo Corona, Victoria o Modelo. ${FOLLOW_LA} 🍺`;
      }
      if (missing.includes("marca")) {
        return `Va. ¿La cerveza de qué marca? Por ejemplo Corona, Victoria o Modelo. ${FOLLOW_LA} 🍺`;
      }
      if (missing.includes("tamano") && missing.includes("cantidad")) {
        return `Va. ${who}, ¿lata, media, caguama o six, y cuántas? ${FOLLOW_LA} 🍺`;
      }
      if (missing.includes("cantidad")) return `Va. ${who}, ¿cuántas? ${FOLLOW_LA} 🍺`;
      return `Va. ${who}, ¿lata, media, caguama o six? ${FOLLOW_LA} 🍺`;
    },
  },
  {
    id: "cigarros",
    nombre: "Cigarros",
    match: /\bcigarros?\b|\bcajetilla\b|\b(?:marlboro|camel|delicados|pall)\b/,
    slots: ["marca", "tamano"],
    sizePhrase: (blob) => (/\bcarton(?:es)?\b/.test(blob) ? "cartón" : /\bcajetilla\b/.test(blob) ? "cajetilla" : null),
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      return /\b(cajetilla|carton|cartones)\b/.test(blob) || (hasBrand(blob, new Set()) && hasAmount(blob, item));
    },
    ask: (missing) => {
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. Los cigarros, ¿de qué marca y cajetilla o cartón? Por ejemplo Marlboro, Camel o Delicados. ${FOLLOW_LOS} 🚬`;
      }
      if (missing.includes("marca")) {
        return `Va. ¿Los cigarros de qué marca? Por ejemplo Marlboro, Camel o Delicados. ${FOLLOW_LOS} 🚬`;
      }
      return `Va. ¿Cajetilla o cartón? ${FOLLOW_LOS} 🚬`;
    },
  },
  packagedFamily({
    id: "mayonesa",
    nombre: "Mayonesa",
    match: /\b(mayonesas?|mayo)\b/,
    article: "La",
    example: "McCormick, Hellmann's o Heinz",
    shelfAsk: "de qué frasco (chico, de 190 g o de kilo)",
    follow: FOLLOW_LA,
    emoji: "🫙",
  }),
  packagedFamily({
    id: "crema",
    nombre: "Crema",
    match: /\bcrema\b/,
    exclude: /\b(dental|corporal|batir|nivea|para el cafe|para cafe)\b/,
    article: "La",
    example: "Lala, Alpura o Santa Clara",
    shelfAsk: "de qué presentación (chica, grande o de litro)",
    follow: FOLLOW_LA,
    emoji: "🥛",
  }),
  packagedFamily({
    id: "gomitas",
    nombre: "Gomitas",
    match: /\bgomitas?\b/,
    article: "Las",
    example: "Panditas, Gomilocas o Winis",
    shelfAsk: "de qué bolsa (chica, grande o bolsaza)",
    follow: FOLLOW_LAS(),
    emoji: "🍬",
  }),
  packagedFamily({
    id: "papas",
    nombre: "Papas",
    match: /\bpapas?\b/,
    skip: (blob) => /\b(kilo|kilos|kg)\b/.test(blob) && !/\b(sabritas|barcel|rufles|pringles|doritos|chips)\b/.test(blob),
    article: "Las",
    example: "Sabritas, Barcel o Pringles",
    shelfAsk: "de qué bolsa (chica, grande o bolsaza)",
    follow: FOLLOW_LAS(),
    emoji: "🍟",
  }),
  packagedFamily({
    id: "galletas",
    nombre: "Galletas",
    match: /\b(galletas?|emperador|marias|habaneras|principe|canelitas|oreo|chokis|saladitas)\b/,
    article: "Las",
    example: "Emperador, Marías o Príncipe",
    shelfAsk: "de qué paquete (chico, grande o de cuántos gramos)",
    follow: FOLLOW_LAS(),
    emoji: "🍪",
  }),
  packagedFamily({
    id: "queso",
    nombre: "Queso",
    match: /\bquesos?\b/,
    article: "El",
    example: "Lala, Alpura o Caperucita",
    shelfAsk: "de a cómo (pieza, rebanadas o de kilo)",
    follow: FOLLOW_LO,
    emoji: "🧀",
  }),
  {
    id: "limpiador",
    nombre: "Limpiador",
    match: /\b(limpiadores?|pinol|fabuloso|maestro limpio)\b/,
    slots: ["marca", "tamano"],
    sizePhrase: litrosPhrase,
    filled: (slot, blob) => (slot === "marca" ? hasBrand(blob, new Set()) : litrosPhrase(blob) != null),
    ask: (missing, item) => {
      const brand = spokenBrand(item);
      const who = brand ? `El ${brand}` : "El limpiador";
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El limpiador, ¿de qué marca y de cuántos litros? Por ejemplo Pinol o Fabuloso. ${FOLLOW_LO} 🧴`;
      }
      if (missing.includes("marca")) {
        return `Va. ¿El limpiador de qué marca? Por ejemplo Pinol o Fabuloso. ${FOLLOW_LO} 🧴`;
      }
      return `Va. ${who}, ¿de cuántos litros? ${FOLLOW_LO} 🧴`;
    },
  },
  {
    id: "cloro",
    nombre: "Cloro",
    match: /\b(cloro|cloralex|blancatel|clorox)\b/,
    countSeparate: true,
    slots: ["marca", "tamano", "cantidad"],
    sizePhrase: shelfPhrase,
    filled: (slot, blob, item) => {
      if (slot === "marca") return hasBrand(blob, new Set());
      if (slot === "tamano") return hasShelfPresentation(blob);
      return hasPackageCount(blob, item) || containerAlreadyCounted(blob, item);
    },
    ask: (missing, item) => {
      const brand = spokenBrand(item);
      const who = brand ? `El ${brand}` : "El cloro";
      const bits: string[] = [];
      if (missing.includes("marca")) bits.push("de qué marca");
      if (missing.includes("tamano")) bits.push("de qué presentación (chico, grande o de litros)");
      if (missing.includes("cantidad")) bits.push("cuántos");
      const example = missing.includes("marca") ? "Por ejemplo Cloralex, Blancatel o Clorox." : "";
      return `Va. ${who}, ¿${joinSpanish(bits)}? ${example} ${FOLLOW_LO} 🧴`.replace(/\s+/g, " ").trim();
    },
  },
  {
    id: "verdura",
    nombre: "Verdura",
    match: PRODUCE_WORDS,
    kind: "produce",
    slots: ["tipo", "tamano"],
    label: (blob) => produceHit(blob)?.nombre ?? "Verdura",
    typePhrase: produceType,
    filled: (slot, blob, item) => {
      if (slot === "tipo") return !produceNeedsType(blob) || produceType(blob) != null;
      return /\b(kilo|kilos|kg)\b/.test(blob) || (typeof item.cantidad === "number" && item.cantidad > 0 && /\b(kilo|kilos|kg)\b/.test(`${blob} ${item.unidad ?? ""}`));
    },
    ask: (missing, _item, blob) => {
      const hit = produceHit(blob);
      const nombre = (hit?.nombre ?? "eso").toLocaleLowerCase("es-MX");
      const article = hit?.article === "la" ? "La" : "El";
      if (/\bcebollas?\b/.test(blob) && missing.includes("tipo") && missing.includes("tamano")) {
        return `Va. La cebolla, ¿blanca o morada, y de cuántos kilos? ${FOLLOW_LA} 🧅`;
      }
      if (/\bcebollas?\b/.test(blob) && missing.includes("tipo")) {
        return `Va. La cebolla, ¿blanca o morada? ${FOLLOW_LA} 🧅`;
      }
      if (/\bchiles?\b/.test(blob) && missing.includes("tipo") && missing.includes("tamano")) {
        return `Va. El chile, ¿de cuál (jalapeño, serrano o habanero) y de cuántos kilos? ${FOLLOW_LO} 🌶️`;
      }
      if (/\bchiles?\b/.test(blob) && missing.includes("tipo")) {
        return `Va. El chile, ¿jalapeño, serrano o habanero? ${FOLLOW_LO} 🌶️`;
      }
      const emoji = /\bjitomates?\b|\btomates?\b/.test(blob) ? "🍅" : "🥬";
      const follow = article === "La" ? FOLLOW_LA : FOLLOW_LO;
      return `Va. ${article} ${nombre}, ¿de cuántos kilos? ${follow} ${emoji}`;
    },
  },
  {
    id: "azucar",
    nombre: "Azúcar",
    match: /\bazucar\b/,
    kind: "produce",
    slots: ["tamano"],
    filled: (slot, blob, item) =>
      slot === "tamano" && (/\b(kilo|kilos|kg)\b/.test(blob) || (typeof item.cantidad === "number" && item.cantidad > 0)),
    ask: () => `Va. El azúcar, ¿de cuántos kilos? ${FOLLOW_LO}`,
  },
  {
    id: "preparado",
    nombre: "Preparado",
    match: /\b(tanks?|tanques?)\b/,
    countSeparate: true,
    slots: ["cantidad"],
    label: (blob) => {
      const text = norm(blob);
      const flavor = text.match(/\b(horchata|jamaica|tamarindo|limon|mango|fresa|pina|guayaba|melon|sandia)\b/);
      const wroteTanks = /\btanks?\b/i.test(blob) && !/\btanques?\b/i.test(blob);
      const unit = wroteTanks ? "Tanks" : "Tanques";
      return flavor ? `${unit} de ${flavor[1]}` : unit;
    },
    filled: (slot, blob, item) => slot === "cantidad" && hasPackageCount(blob, item),
    ask: () => `Va. Los tanques, ¿cuántos? ${FOLLOW_LOS}`,
  },
  {
    id: "papa",
    nombre: "Papa",
    match: /\bpapas?\b/,
    kind: "produce",
    skip: (blob) => !/\b(kilo|kilos|kg)\b/.test(blob) || /\b(sabritas|barcel|rufles|pringles|doritos|chips)\b/.test(blob),
    slots: ["tamano"],
    filled: (slot, blob, item) => slot === "tamano" && (/\b(kilo|kilos|kg)\b/.test(blob) || (typeof item.cantidad === "number" && item.cantidad > 0)),
    ask: () => `Va. La papa, ¿de cuántos kilos? ${FOLLOW_LA} 🥔`,
  },
];

function FOLLOW_LAS(): string {
  return "Con eso ya las anoto y seguimos el mandado.";
}

function categoryRejected(category: Category, blob: string): boolean {
  if (category.exclude?.test(blob)) return true;
  if (category.skip?.(blob)) return true;
  return false;
}

// "arroz higiénico" junto, en la misma frase, es papel higiénico mal dicho.
// "un kilo de arroz y un paquete de papel" no entra: ahí hay dos productos.
function rewriteGrocerySlips(message: string): string {
  return message.replace(/\barroz\s+higi[eé]nicos?\b/gi, "papel higiénico");
}

const BRAND_HINTS: Array<{ re: RegExp; id: string }> = [
  { re: /\bsanitas\b|\bpetalos?\b|\bregio\b|\bsuavel\b/, id: "papel" },
  { re: /\bpinol\b|\bfabuloso\b|\bmaestro limpio\b/, id: "limpiador" },
  { re: /\bcloralex\b|\bblancatel\b|\bclorox\b/, id: "cloro" },
  { re: /\bzotes?\b|\bpalmolive\b|\bescudos?\b/, id: "jabon" },
  { re: /\bnutrioli\b|\bcapullos?\b/, id: "aceite" },
  { re: /\blalas?\b|\balpura\b|\bsanta clara\b/, id: "leche" },
  { re: /\bgamesa\b|\bmarianela\b/, id: "galletas" },
];

function categoryFromBrand(haystack: string): Category | null {
  for (const hint of BRAND_HINTS) {
    if (!hint.re.test(haystack)) continue;
    return CATEGORIES.find((category) => category.id === hint.id) ?? null;
  }
  return null;
}

function categoryFor(text: string): Category | null {
  const haystack = norm(rewriteGrocerySlips(text));
  if (!haystack) return null;
  for (const category of CATEGORIES) {
    if (!category.match.test(haystack)) continue;
    if (categoryRejected(category, haystack)) continue;
    return category;
  }
  return categoryFromBrand(haystack);
}

function ignoreSet(ignoreText?: string | null): Set<string> {
  return new Set(norm(ignoreText ?? "").split(" ").filter((token) => token.length >= 3));
}

function dropAddressTail(message: string): string {
  const words = message.split(/\s+/).filter(Boolean);
  const cut = words.findIndex((word, index) => {
    const one = norm(word);
    const two = norm(`${word} ${words[index + 1] ?? ""}`);
    return (
      /^(calle|colonia|esquina|ubicacion|gps|direccion)$/.test(one) ||
      two.startsWith("frente a") ||
      two.startsWith("vivo en") ||
      two.startsWith("mi direccion")
    );
  });
  if (cut <= 0) return message;
  return words.slice(0, cut).join(" ");
}

function looksLikeAddress(message: string): boolean {
  const text = norm(message);
  return /\b(calle|colonia|frente a|esquina|ubicacion|gps|vivo en|mi direccion)\b/.test(text);
}

type Hit = { wordIndex: number; category: Category };

function hitsIn(message: string): Hit[] {
  const words = norm(rewriteGrocerySlips(dropAddressTail(message))).split(" ").filter(Boolean);
  const haystack = words.join(" ");
  const hits: Hit[] = [];
  for (const category of CATEGORIES) {
    const re = new RegExp(category.match.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(haystack))) {
      const wordIndex = haystack.slice(0, match.index).split(" ").filter(Boolean).length;
      const local = words.slice(Math.max(0, wordIndex - 3), wordIndex + 5).join(" ");
      const tail = haystack.slice(match.index, match.index + 40);
      if (categoryRejected(category, local) || (category.exclude?.test(tail) ?? false)) {
        if (match.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      if (papelHigienicoIsModifier(category, words, wordIndex)) {
        if (match.index === re.lastIndex) re.lastIndex += 1;
        continue;
      }
      hits.push({ wordIndex, category });
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  hits.sort((a, b) => a.wordIndex - b.wordIndex);
  const unique: Hit[] = [];
  for (const hit of hits) {
    if (unique.some((item) => item.wordIndex === hit.wordIndex)) continue;
    unique.push(hit);
  }
  // Sin palabra de producto, la marca conocida abre la línea (Sanitas = papel).
  // Si ya hay un producto ("crema Lala"), la marca no abre otra categoría.
  if (unique.length) return unique;
  return brandHintHits(haystack);
}

function brandHintHits(haystack: string): Hit[] {
  if (!haystack) return [];
  for (const hint of BRAND_HINTS) {
    const match = new RegExp(hint.re.source).exec(haystack);
    if (!match) continue;
    const category = CATEGORIES.find((item) => item.id === hint.id);
    if (!category) continue;
    const wordIndex = haystack.slice(0, match.index).split(" ").filter(Boolean).length;
    return [{ wordIndex, category }];
  }
  return [];
}

function alignedWords(message: string): string[] {
  const rawWords = dropAddressTail(message).split(/\s+/).filter(Boolean);
  const aligned: string[] = [];
  for (const raw of rawWords) {
    const pieces = norm(raw).split(" ").filter(Boolean);
    if (!pieces.length) continue;
    aligned.push(raw);
    for (const piece of pieces.slice(1)) aligned.push(piece);
  }
  return aligned;
}

const LEADING_UNITS = new Set([
  "kilo", "kilos", "kg", "litro", "litros", "pieza", "piezas", "paquete", "paquetes",
  "bolsa", "bolsas", "frasco", "frascos", "lata", "latas", "botella", "botellas",
  "caja", "cajas", "docena", "docenas", "rollo", "rollos",
]);

function isLeadingQty(token: string): boolean {
  const qty = wordToQty(token);
  if (qty == null || qty <= 0) return false;
  if (QTY_WORDS[token] != null) return true;
  return qty <= 40;
}

// "2 kilos de jitomate" lleva la cantidad ANTES del nombre. El corte de cada
// producto empieza en esa cantidad, no en la palabra de producto más cercana:
// si no, "un kilo" cae en la mayonesa y el "2" del jitomate cae en las papas.
function segmentStart(words: string[], hitIndex: number): number {
  let index = hitIndex;
  while (index > 0) {
    const prev = words[index - 1];
    if (prev === "de" || prev === "del") {
      index -= 1;
      continue;
    }
    if (LEADING_UNITS.has(prev)) {
      index -= 1;
      continue;
    }
    if (isLeadingQty(prev)) {
      index -= 1;
      break;
    }
    break;
  }
  return index;
}

function papelHigienicoIsModifier(category: Category, words: string[], wordIndex: number): boolean {
  if (category.id !== "papel") return false;
  if (!/^higienicos?$/.test(words[wordIndex] ?? "")) return false;
  const prev = words[wordIndex - 1] ?? "";
  if (prev === "papel") return true;
  return CATEGORIES.some((other) => other.id !== "papel" && other.match.test(prev));
}

const PURCHASE_UNIT =
  "cajas?|paquetes?|litros?|kilos?|kg|piezas?|bolsas?|botellas?|frascos?|latas?|rollos?|garrafones?|bidones?";

// "una caja de Sanitas" / "un litro de Pinol": la cantidad va adelante y el
// nombre no tiene que estar en la lista de categorías. "sería 1 litro" no
// abre otro producto: no empieza con la cantidad.
function purchaseClause(part: string): boolean {
  const text = norm(part);
  return new RegExp(
    `^(?:tambien |ademas )?(?:quiero |dame |manden? |mandame |traeme |anota |anotame )?(?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\\d+)\\s+(?:${PURCHASE_UNIT})\\b`,
  ).test(text);
}

function unknownProductLabel(clause: string): string | null {
  const tokens = norm(clause)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP.has(token) && !/^\d+$/.test(token));
  if (!tokens.length) return null;
  const label = displayBrand(clause, tokens).trim();
  return label || null;
}

function clauseOpensProduct(part: string): boolean {
  if (hitsIn(part).length > 0) return true;
  if (purchaseClause(part) && unknownProductLabel(part) != null) return true;
  return measuredUnknownWindow(part) != null;
}

const STACK_LEAD = new Set([
  "quiero", "quieres", "dame", "traeme", "manden", "manda", "anota", "anotame",
  "ocupo", "necesito", "seria", "serian", "tambien", "ademas",
]);

// "un kilo de azúcar dos Tanks de horchata" no trae coma ni "y" entre los dos.
// El segundo empieza con cantidad + tanque/kilo: ahí se parte, sin cortar
// "Quiero un kilo…" (el verbo no es un producto).
function separateStackedPurchases(message: string): string {
  return message
    .replace(
      /([A-Za-zÁÉÍÓÚÑáéíóúñ]{4,})\s+((?:un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+(?:tanks?|tanques?|kilos?|kg)\b)/gi,
      (full, word: string, rest: string) => (STACK_LEAD.has(norm(word)) ? full : `${word}, ${rest}`),
    )
    .replace(
      /([A-Za-zÁÉÍÓÚÑáéíóúñ]{4,})\s+(\d+\s*\/\s*\d+\s+[A-Za-zÁÉÍÓÚÑáéíóúñ])/g,
      (full, word: string, rest: string) => (STACK_LEAD.has(norm(word)) ? full : `${word}, ${rest}`),
    );
}

function splitProductClauses(message: string): string[] {
  const text = separateStackedPurchases(rewriteGrocerySlips(dropAddressTail(message)));
  const parts = text
    .split(/\s*(?:,|;|\by\b|\btambi[eé]n\b|\badem[aá]s\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!parts.length) return [text];
  // "La leche es entera y sería 1 l": el "y" parte el tamaño del producto.
  // Si el tramo no nombra otro producto, se queda en el anterior.
  // "un litro de Pinol" sí nombra otro, aunque Pinol no esté en las categorías.
  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length && !clauseOpensProduct(part)) merged[merged.length - 1] = `${merged[merged.length - 1]} y ${part}`;
    else merged.push(part);
  }
  return merged;
}

function windowsInClause(message: string): Array<{ category: Category; text: string }> {
  const rewritten = rewriteGrocerySlips(message);
  const words = alignedWords(rewritten);
  const found = hitsIn(rewritten);
  // "galletas Emperador" nombra el producto y la marca: es una sola línea.
  const sameCategory = found.length > 1 && new Set(found.map((hit) => hit.category.id)).size === 1;
  const hits = sameCategory ? [found[0]] : found;
  if (!words.length || !hits.length) return [];
  const normWords = norm(dropAddressTail(rewritten)).split(" ").filter(Boolean);
  if (hits.length === 1 || words.length !== normWords.length) {
    if (hits.length === 1) return [{ category: hits[0].category, text: words.join(" ") }];
    const buckets = new Map<string, { category: Category; words: string[] }>();
    words.forEach((word, index) => {
      let best = hits[0];
      let bestDistance = Math.abs(index - best.wordIndex);
      for (const hit of hits.slice(1)) {
        const distance = Math.abs(index - hit.wordIndex);
        if (distance < bestDistance) {
          best = hit;
          bestDistance = distance;
        }
      }
      const key = `${best.category.id}:${best.wordIndex}`;
      const bucket = buckets.get(key) ?? { category: best.category, words: [] };
      bucket.words.push(word);
      buckets.set(key, bucket);
    });
    return [...buckets.values()].map((bucket) => ({
      category: bucket.category,
      text: bucket.words.join(" "),
    }));
  }

  let previousHit = -1;
  const starts = hits.map((hit) => {
    const start = Math.max(segmentStart(normWords, hit.wordIndex), previousHit + 1);
    previousHit = hit.wordIndex;
    return start;
  });
  return hits.map((hit, index) => {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : words.length;
    return { category: hit.category, text: words.slice(from, to).join(" ") };
  });
}

function purchaseQtyUnit(blob: string): { cantidad: number; unidad: string } | null {
  const match = blob.match(
    new RegExp(
      `\\b(un|una|uno|unos|unas|\\d+)\\s+(${PURCHASE_UNIT})\\b`,
    ),
  );
  if (!match) return null;
  const qty = wordToQty(match[1]);
  if (qty == null || qty <= 0) return null;
  const singular: Record<string, string> = {
    cajas: "caja",
    paquetes: "paquete",
    litros: "litro",
    kilos: "kilo",
    kg: "kilo",
    piezas: "pieza",
    bolsas: "bolsa",
    botellas: "botella",
    frascos: "frasco",
    latas: "lata",
    rollos: "rollo",
    garrafones: "garrafón",
    bidones: "bidón",
  };
  return { cantidad: qty, unidad: singular[match[2]] ?? match[2] };
}

// "un litro" / "una caja" ya traen la pieza. "2 litros" es el tamaño del empaque.
function indefiniteUnit(blob: string): { cantidad: number; unidad: string } | null {
  const match = blob.match(new RegExp(`\\b(un|una|uno)\\s+(${PURCHASE_UNIT})\\b`));
  if (!match) return null;
  return purchaseQtyUnit(`${match[1]} ${match[2]}`);
}

function containerAlreadyCounted(blob: string, item: PedidoItemInput): boolean {
  if (/\b(un|una|uno)\s+(litros?|botellas?|garrafones?|cajas?|paquetes?|piezas?)\b/.test(blob)) return true;
  if (typeof item.cantidad !== "number" || item.cantidad <= 0) return false;
  const unit = norm(`${item.unidad ?? ""} ${item.presentacion ?? ""}`);
  return /^(1|un|una)\b/.test(String(item.cantidad)) && /\b(litro|litros|botella|caja|paquete|pieza|garrafon)\b/.test(unit);
}

function applySpokenPurchase(item: PedidoItemInput, text: string): PedidoItemInput {
  const purchase = purchaseQtyUnit(norm(text));
  if (!purchase) return item;
  return {
    ...item,
    cantidad: item.cantidad ?? purchase.cantidad,
    unidad: purchase.unidad,
  };
}

function unknownProductWindow(clause: string): { category: Category; text: string } | null {
  if (!purchaseClause(clause)) return null;
  const label = unknownProductLabel(clause);
  if (!label) return null;
  return { category: fallbackPackaged(label), text: clause };
}

function measuredUnknownWindow(clause: string): { category: Category; text: string } | null {
  if (hitsIn(clause).length) return null;
  if (!measuredAmount(clause)) return null;
  const label = productLabelOutsideMeasure(clause);
  if (!label) return null;
  if (categoryFor(label)) return null;
  return { category: fallbackPackaged(label), text: clause };
}

function windowsFor(message: string): Array<{ category: Category; text: string }> {
  return splitProductClauses(message).flatMap((clause) => {
    const found = windowsInClause(clause);
    if (found.length) return found;
    const unknown = unknownProductWindow(clause) ?? measuredUnknownWindow(clause);
    return unknown ? [unknown] : [];
  });
}

function windowLabel(category: Category, text: string): string {
  return category.label?.(text) ?? category.nombre;
}

function shelfName(category: Category, currentName: string | null | undefined, label: string): string {
  if (category.id.startsWith("otro:") || category.id === "verdura") return clean(currentName) || label;
  const current = clean(currentName);
  if (current && category.match.test(norm(current))) return current;
  return label;
}

function contentTokens(text: string): string[] {
  return norm(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP.has(token) && !/^\d+$/.test(token));
}

function itemMatchesWindow(item: PedidoItemInput, window: { category: Category; text: string }): boolean {
  const current = itemCategory(item);
  const wanted = windowLabel(window.category, window.text);
  if (current?.id === window.category.id) {
    if (current.id === "verdura") return norm(item.nombre_producto) === norm(wanted);
    const itemBrands = contentTokens(item.marca ?? "");
    const nameTokens = new Set(norm(window.category.nombre).split(" "));
    const windowBrands = contentTokens(window.text).filter((token) => !nameTokens.has(token));
    if (itemBrands.length && windowBrands.length && !itemBrands.some((token) => windowBrands.includes(token))) {
      return false;
    }
    return true;
  }
  const stem = (value: string) => {
    const token = norm(value).split(" ").find((part) => part.length >= 4) ?? "";
    return token.endsWith("s") ? token.slice(0, -1) : token;
  };
  const left = stem(item.nombre_producto);
  const right = stem(wanted);
  return left.length >= 4 && left === right;
}

function fieldTouches(text: string, windows: Array<{ category: Category; text: string }>): number {
  const tokens = new Set(contentTokens(text));
  if (!tokens.size) return 0;
  let count = 0;
  for (const window of windows) {
    const bag = new Set(contentTokens(`${window.text} ${windowLabel(window.category, window.text)}`));
    if ([...tokens].some((token) => bag.has(token))) count += 1;
  }
  return count;
}

function mashedLine(item: PedidoItemInput, windows: Array<{ category: Category; text: string }>): boolean {
  // "Sanitas Sam's Pinol" en el nombre o en la marca junta tres productos.
  // "Frijol" con marca "Lentejas" solo toca una ventana ajena: no se tira.
  return fieldTouches(item.nombre_producto, windows) >= 2 || fieldTouches(item.marca ?? "", windows) >= 2;
}

function bareInventedPapel(
  item: PedidoItemInput,
  message: string,
  windows: Array<{ category: Category; text: string }>,
): boolean {
  if (windows.some((window) => window.category.id === "papel")) return false;
  if (clean(item.marca) || clean(item.presentacion) || clean(item.notas)) return false;
  if (item.cantidad != null || clean(item.unidad)) return false;
  const name = norm(item.nombre_producto);
  if (name !== "papel" && name !== "papel higienico") return false;
  const hay = norm(rewriteGrocerySlips(message));
  if (/\bpapel\b/.test(hay)) return false;
  return /\bhigienicos?\b/.test(norm(message));
}

function missingSlots(category: Category, item: PedidoItemInput, extra = ""): SlotId[] {
  const blob = blobOf(item, extra);
  if (waiverNote(blob)) return [];
  return category.slots.filter((slot) => !category.filled(slot, blob, item));
}

function scrubItem(item: PedidoItemInput, ignore: Set<string>): PedidoItemInput {
  const scrub = (value?: string | null): string | null => {
    const text = clean(value);
    if (!text) return null;
    const kept = text.split(/\s+/).filter((word) => {
      const token = norm(word);
      return token.length > 0 && !ignore.has(token);
    });
    return kept.join(" ") || null;
  };
  const nombre = scrub(item.nombre_producto) || item.nombre_producto;
  const marca = scrub(item.marca);
  return {
    ...item,
    nombre_producto: nombre,
    ...(marca ? { marca } : { marca: null }),
    presentacion: scrub(item.presentacion),
    notas: scrub(item.notas),
  };
}

function presentationBelongsToWindow(presentacion: string | null | undefined, extra: string): boolean {
  const text = norm(presentacion ?? "");
  if (!text) return true;
  const blob = norm(extra);
  const tokens = text.split(" ").filter((token) => token.length > 1 && token !== "de" && token !== "del");
  return tokens.every((token) => blob.includes(token));
}

function soleLiterQuestion(category: Category, item: PedidoItemInput): boolean {
  const missing = missingSlots(category, item);
  if (missing.length !== 1 || missing[0] !== "tamano") return false;
  const question = norm(category.ask(missing, item, blobOf(item)));
  if (/\b(ml|garrafon|medio|kilo|rollo|lata|pieza|docena)\b/.test(question)) return false;
  return /\blitro/.test(question);
}

function genericBrandNote(value: string): string | null {
  return /\bgeneric\w*\b/.test(norm(value)) ? "genéricas" : null;
}

// "Si quieres valle" es Verde Valle dicho de oídas, no una marca "Quieres".
function riceBrandFrom(extraRaw: string): string | null {
  const blob = norm(extraRaw);
  if (/\b(verde valle|quieres valle|valle)\b/.test(blob)) return "Verde Valle";
  if (/\bmorelos\b/.test(blob)) return "Morelos";
  if (/\bsos\b/.test(blob)) return "SOS";
  return null;
}

function categoryNouns(): Set<string> {
  const nouns = new Set<string>();
  for (const category of CATEGORIES) {
    for (const token of norm(category.nombre).split(" ")) {
      if (token.length >= 4) nouns.add(token);
    }
  }
  return nouns;
}

const TYPE_GROUPS: Record<string, string[][]> = {
  verdura: [["blanca", "blanco", "morada", "morado", "cambray", "jalapeño", "serrano", "habanero", "poblano", "güero", "chipotle", "morrón", "de árbol"]],
  frijol: [["negro", "negra", "bayo", "peruano", "pinto", "flor de mayo"]],
  leche: [["entera", "deslactosada", "light", "orgánica", "chocolate", "fresa"]],
  huevo: [["rojo", "blanco"]],
  tortilla: [["de harina", "de maíz"]],
  pan: [["de caja", "bolillo", "telera", "birote", "dulce"]],
};

function mergeType(category: Category, current: string | null | undefined, typed: string | null): string | null {
  if (!typed) return clean(current);
  const group = (TYPE_GROUPS[category.id] ?? []).find((words) => words.some((word) => norm(typed).includes(norm(word))));
  let prev = clean(current) ?? "";
  if (group) {
    for (const word of [...group].sort((a, b) => b.length - a.length)) {
      prev = prev.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
    }
    prev = prev.replace(/\s+/g, " ").trim();
  }
  return mergeText(prev || null, typed);
}

// La respuesta corta no repite el producto. Se prueba primero el texto tal
// cual y, si no trae el nombre, se antepone el de la línea abierta — sin la
// presentación vieja, para que «blanca» reemplace «morada».
function typeFromReply(category: Category, item: PedidoItemInput, extraNorm: string): string | null {
  const direct = category.typePhrase?.(extraNorm) ?? null;
  if (direct) return direct;
  const name = norm(item.nombre_producto);
  if (!name || !extraNorm) return null;
  return category.typePhrase?.(`${name} ${extraNorm}`) ?? null;
}

function measuredAmount(raw: string): { cantidad: number; unidad: string; presentacion: string } | null {
  const text = String(raw ?? "");
  if (/\b(litro|litros|ml)\b/i.test(text) && !/\d+\s*\/\s*\d+/.test(text)) return null;
  const grams = text.match(/\b(\d+(?:\.\d+)?)\s*(?:g|gr|gramos)\b/i);
  if (grams) {
    const n = Number(grams[1]);
    if (n > 0) return { cantidad: n, unidad: "g", presentacion: `${n} g` };
  }
  const fraction = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (fraction) {
    const num = Number(fraction[1]);
    const den = Number(fraction[2]);
    if (den > 0 && num > 0 && num / den < 5) {
      const label = `${num}/${den}`;
      return { cantidad: num / den, unidad: "kilo", presentacion: `${label} kg` };
    }
  }
  if (/\b(?:un|una)\s+cuarto\b|\bcuarto\s+de\b/i.test(text)) {
    return { cantidad: 0.25, unidad: "kilo", presentacion: "1/4 kg" };
  }
  return null;
}

const MEASURE_WORDS = new Set([
  "cuarto", "cuartos", "medio", "media", "kilo", "kilos", "kg", "gramo", "gramos", "gr",
]);

function productLabelOutsideMeasure(clause: string): string | null {
  const withoutFraction = clause.replace(/\d+\s*\/\s*\d+/g, " ");
  const tokens = norm(withoutFraction)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP.has(token) && !MEASURE_WORDS.has(token) && !/^\d+(?:\.\d+)?$/.test(token));
  if (!tokens.length) return null;
  const label = displayBrand(withoutFraction, tokens).trim();
  return label || null;
}

function applyDetail(
  item: PedidoItemInput,
  extraRaw: string,
  ignore: Set<string>,
  boundWindow = false,
): PedidoItemInput {
  const extra = norm(extraRaw)
    .split(" ")
    .filter((token) => !ignore.has(token))
    .join(" ");
  const category = categoryFor(`${itemText(item)} ${extra}`) ?? itemCategory(item);
  if (!category) return scrubItem(item, ignore);
  const literQuestionOpen = soleLiterQuestion(category, item);

  if (waiverNote(blobOf(item))) {
    return scrubItem({ ...item, notas: clean(item.notas) ?? waiverNote(blobOf(item)) ?? "la que sea" }, ignore);
  }

  const next: PedidoItemInput = { ...item };
  if (boundWindow && !presentationBelongsToWindow(next.presentacion, extra)) next.presentacion = null;
  const productTokens = new Set(norm(next.nombre_producto).split(" ").filter((token) => token.length >= 3));
  const nouns = categoryNouns();
  const tokens = brandTokens(extra, ignore).filter(
    (token) => !productTokens.has(token) && !nouns.has(token) && !MEASURE_WORDS.has(token),
  );
  if (category.kind !== "produce" && !spokenBrand(next) && tokens.length) next.marca = displayBrand(extraRaw, tokens);
  if (category.id === "arroz") {
    const hinted = riceBrandFrom(extraRaw);
    if (hinted) next.marca = hinted;
    else if (/\bquieres\b/.test(norm(next.marca ?? ""))) next.marca = null;
  }
  if (genericBrandNote(next.marca ?? "")) next.marca = null;
  if (
    category.kind !== "produce" &&
    clean(next.marca) &&
    norm(next.nombre_producto) === norm(String(next.marca)) &&
    norm(category.nombre) !== norm(String(next.marca))
  ) {
    next.nombre_producto = category.nombre;
  }

  next.presentacion = mergeType(category, next.presentacion, typeFromReply(category, next, extra));
  let size = category.sizePhrase?.(extra) ?? null;
  if (!size && literQuestionOpen) {
    const bare = bareLiterQuantity(extra);
    if (bare != null) size = literPhraseFromQty(bare);
  }
  if (size && (category.id === "papel" || /lata|ml|familiar|vidrio|six|caguama|media|cajetilla|carton|garrafon/.test(norm(size)))) {
    next.presentacion = mergeText(next.presentacion, size);
  } else if (size && /\blitro/.test(norm(size))) {
    if (category.countSeparate) {
      next.presentacion = mergeText(next.presentacion, size);
    } else {
      const qty = parseQty(norm(size));
      // "l" ya guardado no trae la palabra litro: esta respuesta la reemplaza.
      const replaceLiter = isLiterAbbrev(next.unidad);
      if (qty != null && (next.cantidad == null || replaceLiter)) next.cantidad = qty;
      if (!clean(next.unidad) || replaceLiter) next.unidad = qtyUnit(size);
    }
  } else if (size && /\bkilo|docena/.test(norm(size))) {
    if (category.countSeparate) {
      next.presentacion = mergeText(next.presentacion, size);
    } else {
      if (!clean(next.unidad)) next.unidad = norm(size).includes("docena") ? "docena" : "kilo";
      const qty = qtyBeforeUnit(extra, /kilos?|kg|docenas?/) ?? parseQty(extra);
      if (qty != null && (next.cantidad == null || boundWindow)) next.cantidad = qty;
    }
  } else if (size) {
    next.presentacion = mergeText(next.presentacion, size);
  }

  if (category.countSeparate) {
    const count = parsePackageCount(extra);
    if (count != null && (next.cantidad == null || boundWindow)) next.cantidad = count;
    // "un litro de Cloralex": el "un" no es un número suelto y el litro es el
    // tamaño, pero también es un bote. "2 litros" de la Coca no entra aquí.
    if (next.cantidad == null) {
      const spoken = indefiniteUnit(extra);
      if (spoken) {
        next.cantidad = spoken.cantidad;
        if (!clean(next.unidad)) next.unidad = spoken.unidad;
      }
    }
    if (!clean(next.unidad)) {
      const unit = countUnit(extra);
      if (unit) next.unidad = unit;
    }
    if (category.id === "refresco" && next.cantidad != null && !clean(next.unidad)) next.unidad = "pieza";
  } else if (next.cantidad == null) {
    const qty = parseQty(extra);
    const bareMl = /\b\d{3}\b/.test(extra) && !/\b(litro|litros|kilo|kilos|rollo|rollos|pieza|piezas|docena)\b/.test(extra);
    const mentionsCount =
      /\b(kilo|kilos|kg|docena|pieza|piezas|bolsa|paquete|paquetes|litro|litros|rollo|rollos|lata|caguama|caja|cajas)\b/.test(extra) ||
      (/\d/.test(extra) && !bareMl);
    if (qty != null && mentionsCount) next.cantidad = qty;
  }
  if (category.kind === "produce" && /\b(kilo|kilos|kg)\b/.test(extra)) {
    const qty = qtyBeforeUnit(extra, /kilos?|kg/) ?? parseQty(extra);
    if (qty != null && (next.cantidad == null || boundWindow)) next.cantidad = qty;
    else if (next.cantidad == null) next.cantidad = 1;
    if (!clean(next.unidad)) next.unidad = "kilo";
  }
  if (!clean(next.unidad) && !category.countSeparate) {
    const unit = extra.match(/\b(kilos|kilo|kg|litros|litro|paquetes|paquete|piezas|pieza|bolsa|docena|garrafon|lata|rollos|rollo|cajas|caja)\b/);
    if (unit) {
      const mapped: Record<string, string> = {
        kilos: "kilo",
        kg: "kilo",
        litros: "litros",
        paquetes: "paquete",
        cajas: "caja",
        garrafon: "garrafón",
      };
      next.unidad = mapped[unit[1]] ?? unit[1];
    }
  }
  if (category.id === "cigarros" && clean(next.marca) && !/\bcarton|cajetilla/.test(blobOf(next))) {
    if (next.cantidad != null || /\b(un|una)\b/.test(extra)) {
      next.presentacion = mergeText(next.presentacion, "cajetilla");
      if (next.cantidad == null) next.cantidad = 1;
    }
  }
  // "Del que sea" cierra lo que siga faltando, pero no borra los litros o la marca que ya dijo.
  const waiver = waiverNote(extra);
  if (waiver && missingSlots(category, next).length) next.notas = waiver;
  if (genericBrandNote(extra) || genericBrandNote(next.notas ?? "")) {
    next.notas = "genéricas";
    if (genericBrandNote(next.marca ?? "")) next.marca = null;
  }
  const measured = measuredAmount(extraRaw);
  const bulkMeasure =
    measured != null &&
    (category.id.startsWith("otro:") || category.kind === "produce" || measured.presentacion.includes("/"));
  if (measured && bulkMeasure) {
    const prev = clean(next.presentacion) ?? "";
    const stripped = prev
      .replace(/\b1 kilo\b/gi, " ")
      .replace(/\b\d+(?:\.\d+)?\s*kilos?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    next.presentacion = mergeText(stripped || null, measured.presentacion);
    next.cantidad = measured.cantidad;
    next.unidad = measured.unidad;
  }
  return scrubItem(next, ignore);
}

function qtyUnit(size: string): string {
  const qty = parseQty(norm(size));
  if (qty != null && qty > 1) return "litros";
  return "litro";
}

function fallbackPackaged(nombre: string): Category {
  const pretty = niceWord(nombre);
  const base = packagedFamily({
    id: `otro:${norm(nombre)}`,
    nombre: pretty,
    match: /$^/,
    article: "El",
    example: "la marca que uses en tu casa",
    shelfAsk: "de qué presentación (chico, grande, gramos o litros)",
    follow: FOLLOW_LO,
    emoji: "🛒",
  });
  return {
    ...base,
    filled: (slot, blob, item) => {
      const ownWords = norm(item.nombre_producto).split(" ").filter((token) => token.length >= 3 && !STOP.has(token));
      if (slot === "marca") {
        const own = new Set(ownWords);
        if (brandTokens(blob, own).length > 0) return true;
        return ownWords.length >= 2;
      }
      // "Frutos rojos Fusi" ya dice qué bajar. No se pregunta tamaño de más.
      if (slot === "tamano") {
        if (base.filled(slot, blob, item)) return true;
        return ownWords.filter((token) => token.length >= 4).length >= 2;
      }
      return base.filled(slot, blob, item);
    },
  };
}

function itemText(item: PedidoItemInput): string {
  return [item.nombre_producto, item.marca, item.presentacion, item.unidad, item.notas].filter(Boolean).join(" ");
}

function itemCategory(item: PedidoItemInput): Category | null {
  const known = categoryFor(itemText(item));
  if (known) return known;
  const nombre = clean(item.nombre_producto);
  if (!nombre) return null;
  return fallbackPackaged(nombre);
}

function nameTokensOf(item: PedidoItemInput): string[] {
  return norm(item.nombre_producto)
    .split(" ")
    .filter((token) => token.length >= 4 && !STOP.has(token));
}

function withoutFakeBrand(item: PedidoItemInput): PedidoItemInput {
  const marca = clean(item.marca);
  const generic = genericBrandNote(marca ?? "") || genericBrandNote(item.notas ?? "");
  const waived = marca ? waiverNote(marca) : null;
  if (!generic && !waived) return item;
  const next: PedidoItemInput = { ...item, notas: generic || waived || item.notas };
  if (generic || waived) next.marca = null;
  return next;
}

function stripStolenBrands(items: PedidoItemInput[]): PedidoItemInput[] {
  const names = items.map(nameTokensOf);
  return items.map((item, index) => {
    const cleaned = withoutFakeBrand(item);
    const marca = clean(cleaned.marca);
    if (!marca) return cleaned;
    const words = marca.split(/\s+/);
    const kept = words.filter((word) => {
      const token = norm(word);
      if (token.length < 4) return true;
      return !names.some((bag, other) => other !== index && bag.includes(token));
    });
    if (kept.length === words.length) return cleaned;
    return { ...cleaned, marca: kept.join(" ") || null };
  });
}

const GENERIC_SHELF =
  /^(refresco|refrescos|limpiador|limpiadores|cloro|papel higienico|papel|frijol|frijoles|arroz|leche|agua|galleta|galletas|jabon|aceite|detergente|cerveza|huevo|huevos|pan|tortilla|tortillas|mayonesa|crema|lentejas|lenteja)$/;

function collapseAliasDuplicate(items: PedidoItemInput[]): PedidoItemInput[] {
  const next = items.map((item) => ({ ...item }));
  const drop = new Set<number>();
  for (let i = 0; i < next.length; i += 1) {
    if (drop.has(i)) continue;
    for (let j = i + 1; j < next.length; j += 1) {
      if (drop.has(j)) continue;
      const aGeneric = GENERIC_SHELF.test(norm(next[i].nombre_producto));
      const bGeneric = GENERIC_SHELF.test(norm(next[j].nombre_producto));
      if (aGeneric === bGeneric) continue;
      const generic = aGeneric ? next[i] : next[j];
      const specific = aGeneric ? next[j] : next[i];
      const genericIndex = aGeneric ? i : j;
      const specificIndex = aGeneric ? j : i;
      const brandTokensOfGeneric = norm(generic.marca ?? "")
        .split(" ")
        .filter((token) => token.length >= 4 && !STOP.has(token));
      const specificBlob = norm(`${specific.nombre_producto} ${specific.marca ?? ""}`);
      if (!brandTokensOfGeneric.some((token) => specificBlob.includes(token))) continue;
      next[specificIndex] = {
        ...specific,
        cantidad: specific.cantidad ?? generic.cantidad,
        unidad: specific.unidad ?? generic.unidad,
        presentacion: specific.presentacion ?? generic.presentacion,
        notas: specific.notas ?? generic.notas,
      };
      drop.add(genericIndex);
    }
  }
  return next.filter((_, index) => !drop.has(index));
}

function collapseSameName(items: PedidoItemInput[]): PedidoItemInput[] {
  const kept: PedidoItemInput[] = [];
  for (const item of items) {
    const name = norm(item.nombre_producto);
    const index = kept.findIndex((prev) => {
      const prevName = norm(prev.nombre_producto);
      const related = prevName === name || (name.length >= 4 && prevName.length >= 4 && (prevName.includes(name) || name.includes(prevName)));
      if (!related) return false;
      const leftBrand = norm(prev.marca ?? "");
      const rightBrand = norm(item.marca ?? "");
      if (leftBrand && rightBrand && leftBrand !== rightBrand) return false;
      const leftSize = norm(prev.presentacion ?? "");
      const rightSize = norm(item.presentacion ?? "");
      if (leftSize && rightSize && leftSize !== rightSize) return false;
      return true;
    });
    if (index === -1) {
      kept.push({ ...item });
      continue;
    }
    const prev = kept[index];
    const richer = name.length > norm(prev.nombre_producto).length ? item : prev;
    const other = richer === item ? prev : item;
    kept[index] = {
      ...richer,
      marca: richer.marca ?? other.marca,
      presentacion: richer.presentacion ?? other.presentacion,
      unidad: richer.unidad ?? other.unidad,
      notas: richer.notas ?? other.notas,
      cantidad: richer.cantidad ?? other.cantidad,
    };
  }
  return kept;
}

function tidyQuoteLines(items: PedidoItemInput[]): PedidoItemInput[] {
  return collapseSameName(collapseAliasDuplicate(stripStolenBrands(items)));
}

export function dropItemsNamedInRemoval(items: PedidoItemInput[], message: string): PedidoItemInput[] {
  const text = norm(message);
  const targets: string[] = [];
  const re =
    /\b(?:quit[aeo]\w*|borra(?:r|lo|la)?|elimina(?:r|lo|la)?|ya no quiero|ya no)\s+(?:el |la |los |las |un |una |al )?([a-z0-9]{4,})/g;
  for (const match of text.matchAll(re)) targets.push(match[1]);
  if (!targets.length) return items;
  return items.filter((item) => {
    const blob = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
    return !targets.some((target) => blob.includes(target));
  });
}

function titlePhrase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => niceWord(word))
    .join(" ");
}

function renameNegated(items: PedidoItemInput[], message: string): PedidoItemInput[] {
  const text = norm(message);
  const match = text.match(
    /\bno (?:es|era|son|eran) (?:el |la |los |las |un |una )?([a-z]{4,})\b[\s,;:]{0,16}(?:es|son|era|sino|mejor)\s+(?:un |una |el |la |de )?([a-z0-9][a-z0-9 ]{2,50})/,
  );
  if (!match) return items;
  const from = match[1];
  const to = match[2].split(/\b(?:y|pero|quita|tambien|porfa|gracias)\b/)[0]?.trim() ?? "";
  if (!to || norm(to) === from) return items;
  const titled = titlePhrase(to);
  let renamed = false;
  return items.map((item) => {
    if (renamed) return item;
    const name = norm(item.nombre_producto);
    if (name !== from && !name.startsWith(`${from} `)) return item;
    renamed = true;
    return { ...item, nombre_producto: titled };
  });
}

function stripClauses(message: string, items: PedidoItemInput[]): string {
  const nouns = categoryNouns();
  for (const item of items) {
    for (const token of norm(`${item.nombre_producto} ${item.marca ?? ""}`).split(" ")) {
      if (token.length >= 4) nouns.add(token);
    }
  }
  const withoutRemoval = message.replace(
    /\b(?:quit[aeo]\w*|borra(?:r|lo|la)?|elimina(?:r|lo|la)?|ya no quiero|ya no)\s+(?:el |la |los |las |un |una |al )?[a-z0-9]+/gi,
    " ",
  );
  return withoutRemoval.replace(
    /\bno (?:es|era|son|eran)\s+(?:el |la |los |las |un |una )?([a-záéíóúñ]+)/gi,
    (full, word: string) => (nouns.has(norm(word)) ? " " : full),
  );
}

function firstIncompleteIndex(items: PedidoItemInput[]): number {
  return items.findIndex((item) => {
    const category = itemCategory(item);
    return category != null && missingSlots(category, item).length > 0;
  });
}

function answerClosesItem(item: PedidoItemInput, message: string, ignore: Set<string>): boolean {
  const category = itemCategory(item);
  if (!category) return false;
  const before = missingSlots(category, item);
  if (!before.length) return false;
  const applied = applyDetail(item, message, ignore);
  return missingSlots(category, applied).length < before.length;
}

// La pregunta abierta es la primera línea incompleta. Si la respuesta corta
// no le cierra el hueco pero sí se lo cierra a otra (blanca → cebolla,
// Nutrioli → aceite), va a esa. Si varias lo aceptan, gana la de la marca.
function pickDetailIndex(items: PedidoItemInput[], message: string, ignore: Set<string>): number {
  const first = firstIncompleteIndex(items);
  if (first === -1) return -1;
  if (answerClosesItem(items[first], message, ignore)) return first;
  const others = items
    .map((_, index) => index)
    .filter((index) => index !== first && answerClosesItem(items[index], message, ignore));
  if (others.length === 1) return others[0];
  if (others.length > 1) {
    const hinted = categoryFromBrand(norm(message));
    if (hinted) {
      const match = others.find((index) => itemCategory(items[index])?.id === hinted.id);
      if (match != null) return match;
    }
  }
  return first;
}

export function prepareQuoteItems(
  items: PedidoItemInput[],
  userMessage?: string | null,
  ignoreText?: string | null,
): PedidoItemInput[] {
  const ignore = ignoreSet(ignoreText);
  let next = tidyQuoteLines(items.map((item) => ({ ...item })));
  const message = String(userMessage ?? "").trim();
  const visible = message ? stripClauses(message, next) : "";
  const windows = visible ? windowsFor(visible) : [];
  if (windows.length > 1) {
    next = next.filter((item) => !mashedLine(item, windows) && !bareInventedPapel(item, message, windows));
  }

  const agua = CATEGORIES.find((category) => category.id === "agua");
  const flavoredWater =
    agua?.exclude != null && agua.match.test(norm(message)) && agua.exclude.test(norm(message));
  if (flavoredWater && agua?.exclude) {
    const flavor = norm(message).match(agua.exclude)?.[0] ?? "de sabor";
    if (!next.some((item) => norm(`${item.nombre_producto} ${item.presentacion ?? ""}`).includes(flavor))) {
      next.push({ nombre_producto: "Agua", presentacion: flavor === "de sabor" ? "de sabor" : flavor });
    }
  }

  if (windows.length) {
    const boundWindow = windows.length > 1;
    const used = new Set<number>();
    const produced: PedidoItemInput[] = [];
    for (const window of windows) {
      const label = windowLabel(window.category, window.text);
      const index = next.findIndex((item, itemIndex) => !used.has(itemIndex) && itemMatchesWindow(item, window));
      const finish = (item: PedidoItemInput) => {
        const named = {
          ...item,
          nombre_producto: shelfName(window.category, item.nombre_producto, label),
        };
        const detailed = applyDetail(named, window.text, ignore, boundWindow);
        return window.category.id.startsWith("otro:") ? applySpokenPurchase(detailed, window.text) : detailed;
      };
      if (index === -1) {
        produced.push(finish({ nombre_producto: label }));
      } else {
        used.add(index);
        produced.push(finish(next[index]));
      }
    }
    const prior = next.filter((_, itemIndex) => !used.has(itemIndex));
    next = [...prior, ...produced];
  } else if (!flavoredWater && message && !looksLikeAddress(message) && (norm(message).split(" ").length <= 14 || waiverNote(message))) {
    const open = next.filter((item) => quoteItemNeedsDetail(item)).length;
    const splitsProducts = open > 1 && /\sy\s/.test(norm(message));
    if (!splitsProducts) {
      const index = pickDetailIndex(next, message, ignore);
      if (index !== -1) next[index] = applyDetail(next[index], message, ignore);
    }
  }

  next = tidyQuoteLines(next.map((item) => scrubItem(item, ignore)));
  next = dropItemsNamedInRemoval(next, message);
  next = renameNegated(next, message);
  return tidyQuoteLines(next);
}

export function quoteQuestionForItems(items: PedidoItemInput[]): string | null {
  for (const item of items) {
    const category = itemCategory(item);
    if (!category) continue;
    const missing = missingSlots(category, item);
    if (!missing.length) continue;
    return category.ask(missing, item, blobOf(item));
  }
  return null;
}

export function isGuidedQuoteItem(item: PedidoItemInput): boolean {
  return itemCategory(item) != null;
}

export function quoteItemNeedsDetail(item: PedidoItemInput): boolean {
  const category = itemCategory(item);
  if (!category) return false;
  return missingSlots(category, item).length > 0;
}
