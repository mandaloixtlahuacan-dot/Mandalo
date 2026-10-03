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
  "chico", "chica", "chicos", "chicas", "mediano", "mediana", "medianos", "medianas", "grande", "grandes", "bolsaza", "jumbo",
  "individual", "frasco", "frascos", "sobre", "sobres", "tubo",
  "mayonesa", "mayonesas", "mayo", "crema", "gomita", "gomitas",
  "papa", "papas", "galleta", "galletas", "queso", "quesos",
  "jitomate", "jitomates", "tomate", "tomates", "cebolla", "cebollas",
  "cilantro", "perejil", "limon", "limones", "chile", "chiles",
  "zanahoria", "zanahorias", "pepino", "pepinos", "lechuga", "lechugas",
  "aguacate", "aguacates", "platano", "platanos", "manzana", "manzanas",
  "naranja", "naranjas", "ajo", "ajos", "calabaza", "calabazas",
  "elote", "elotes", "repollo", "col", "brocoli", "chayote", "chayotes",
  "ejote", "ejotes",   "nopal", "nopales", "sandia", "melon", "pina",
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
  if (/\b1\s*2\s*3\b|\b123\b/.test(blob)) return true;
  return blob.split(" ").some((token) => token.length >= 3 && !/^\d+$/.test(token) && !STOP.has(token) && !ignore.has(token));
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
        return norm(cleanWord) === token;
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

function litrosPhrase(blob: string): string | null {
  const ml = blob.match(/\b(\d+)\s*ml\b/);
  if (ml) return `${ml[1]} ml`;
  if (!/\blitros?\b/.test(blob)) return null;
  const qty = qtyBeforeUnit(blob, /litros?/);
  if (qty == null) return "1 litro";
  return qty === 1 ? "1 litro" : `${qty} litros`;
}

function rollPhrase(blob: string): string | null {
  const match = blob.match(new RegExp(`\\b(${ROLL_COUNTS})\\b`));
  return match ? `${match[1]} rollos` : null;
}

const SIZE_UNITS = new Set([
  "litro", "litros", "ml", "g", "gr", "gramo", "gramos", "kg", "kilo", "kilos", "rollo", "rollos",
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

function produceType(blob: string): string | null {
  if (/\bcebollas?\b/.test(blob)) {
    if (/\bcambray\b/.test(blob)) return "cambray";
    if (/\bmorad[ao]\b/.test(blob)) return "morada";
    if (/\bblanc[ao]\b/.test(blob)) return "blanca";
    return null;
  }
  if (/\bchiles?\b/.test(blob)) {
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
      const brand = clean(item.marca) || (hasBrand(blob, new Set()) ? displayBrand(blob, brandTokens(blob, new Set())) : null);
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
    filled: (slot, blob) => (slot === "marca" ? hasBrand(blob, new Set()) : rollPhrase(blob) != null),
    ask: (missing, item) => {
      const brandName = clean(item.marca);
      if (missing.includes("marca") && missing.includes("tamano")) {
        return `Va. El papel higiénico, ¿de qué marca y de cuántos rollos (4, 12, 18 o 32)? Por ejemplo Pétalo, Regio o Suavel. ${FOLLOW_LO} 🧻`;
      }
      if (missing.includes("marca")) {
        return `Va. El papel, ¿de qué marca? Por ejemplo Pétalo, Regio o Suavel. ${FOLLOW_LO} 🧻`;
      }
      const who = brandName ? `El ${brandName}` : "El papel";
      return `Va. ${who}, ¿de cuántos rollos: 4, 12, 18 o 32? ${FOLLOW_LO} 🧻`;
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
      const brand = clean(item.marca) || (/\bcoca\b/.test(blob) ? "Coca" : /\bred bull\b|\bredbull\b/.test(blob) ? "Red Bull" : null);
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
      if (/\bnegro\b/.test(blob)) return "negro";
      if (/\bbayo\b/.test(blob)) return "bayo";
      if (/\bperuano\b/.test(blob)) return "peruano";
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
      const brand = clean(item.marca);
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

function categoryFor(text: string): Category | null {
  const haystack = norm(text);
  if (!haystack) return null;
  for (const category of CATEGORIES) {
    if (!category.match.test(haystack)) continue;
    if (categoryRejected(category, haystack)) continue;
    return category;
  }
  return null;
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
  const words = norm(dropAddressTail(message)).split(" ").filter(Boolean);
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
  return unique;
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

function splitProductClauses(message: string): string[] {
  const text = dropAddressTail(message);
  const parts = text
    .split(/\s*(?:,|;|\by\b)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length ? parts : [text];
}

function windowsInClause(message: string): Array<{ category: Category; text: string }> {
  const words = alignedWords(message);
  const hits = hitsIn(message);
  if (!words.length || !hits.length) return [];
  const normWords = norm(dropAddressTail(message)).split(" ").filter(Boolean);
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

function windowsFor(message: string): Array<{ category: Category; text: string }> {
  return splitProductClauses(message).flatMap((clause) => windowsInClause(clause));
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

  if (waiverNote(blobOf(item))) {
    return scrubItem({ ...item, notas: clean(item.notas) ?? waiverNote(blobOf(item)) ?? "la que sea" }, ignore);
  }

  const next: PedidoItemInput = { ...item };
  if (boundWindow && !presentationBelongsToWindow(next.presentacion, extra)) next.presentacion = null;
  const productTokens = new Set(norm(next.nombre_producto).split(" ").filter((token) => token.length >= 3));
  const tokens = brandTokens(extra, ignore).filter((token) => !productTokens.has(token));
  if (category.kind !== "produce" && !clean(next.marca) && tokens.length) next.marca = displayBrand(extraRaw, tokens);
  if (
    category.kind !== "produce" &&
    clean(next.marca) &&
    norm(next.nombre_producto) === norm(String(next.marca)) &&
    norm(category.nombre) !== norm(String(next.marca))
  ) {
    next.nombre_producto = category.nombre;
  }

  next.presentacion = mergeText(next.presentacion, category.typePhrase?.(extra) ?? null);
  const size = category.sizePhrase?.(extra) ?? null;
  if (size && (category.id === "papel" || /lata|ml|familiar|vidrio|six|caguama|media|cajetilla|carton|garrafon/.test(norm(size)))) {
    next.presentacion = mergeText(next.presentacion, size);
  } else if (size && /\blitro/.test(norm(size))) {
    if (category.countSeparate) {
      next.presentacion = mergeText(next.presentacion, size);
    } else {
      const qty = parseQty(norm(size));
      if (next.cantidad == null && qty != null) next.cantidad = qty;
      if (!clean(next.unidad)) next.unidad = qtyUnit(size);
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
    if (!clean(next.unidad)) {
      const unit = countUnit(extra);
      if (unit) next.unidad = unit;
    }
  } else if (next.cantidad == null) {
    const qty = parseQty(extra);
    const bareMl = /\b\d{3}\b/.test(extra) && !/\b(litro|litros|kilo|kilos|rollo|rollos|pieza|piezas|docena)\b/.test(extra);
    const mentionsCount =
      /\b(kilo|kilos|kg|docena|pieza|piezas|bolsa|paquete|litro|litros|rollo|rollos|lata|caguama)\b/.test(extra) ||
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
    const unit = extra.match(/\b(kilos|kilo|kg|litros|litro|paquete|piezas|pieza|bolsa|docena|garrafon|lata|rollos|rollo)\b/);
    if (unit) {
      const mapped: Record<string, string> = { kilos: "kilo", kg: "kilo", litros: "litros", garrafon: "garrafón" };
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
      if (slot !== "marca") return base.filled(slot, blob, item);
      const own = new Set(norm(item.nombre_producto).split(" ").filter((token) => token.length >= 3));
      if (brandTokens(blob, own).length > 0) return true;
      return [...own].filter((token) => !STOP.has(token)).length >= 2;
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

function firstIncompleteIndex(items: PedidoItemInput[]): number {
  return items.findIndex((item) => {
    const category = itemCategory(item);
    return category != null && missingSlots(category, item).length > 0;
  });
}

export function prepareQuoteItems(
  items: PedidoItemInput[],
  userMessage?: string | null,
  ignoreText?: string | null,
): PedidoItemInput[] {
  const ignore = ignoreSet(ignoreText);
  const next = items.map((item) => ({ ...item }));
  const message = String(userMessage ?? "").trim();
  const windows = message ? windowsFor(message) : [];

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
    for (const window of windows) {
      const index = next.findIndex((item) => {
        const current = itemCategory(item);
        const wanted = window.category.label?.(window.text) ?? window.category.nombre;
        if (current?.id === window.category.id) {
          if (current.id !== "verdura") return true;
          return norm(item.nombre_producto) === norm(wanted);
        }
        // "Papa" a secas cae en papas de bolsa. "un kilo de papas" es la verdura.
        const stem = (value: string) => {
          const token = norm(value).split(" ").find((part) => part.length >= 4) ?? "";
          return token.endsWith("s") ? token.slice(0, -1) : token;
        };
        const left = stem(item.nombre_producto);
        const right = stem(wanted);
        return left.length >= 4 && left === right;
      });
      if (index === -1) {
        const label = window.category.label?.(window.text) ?? window.category.nombre;
        next.push(applyDetail({ nombre_producto: label }, window.text, ignore, boundWindow));
      } else {
        next[index] = applyDetail(next[index], window.text, ignore, boundWindow);
      }
    }
  } else if (!flavoredWater && message && !looksLikeAddress(message) && (norm(message).split(" ").length <= 14 || waiverNote(message))) {
    const open = next.filter((item) => quoteItemNeedsDetail(item)).length;
    const splitsProducts = open > 1 && /\sy\s/.test(norm(message));
    if (!splitsProducts) {
      const index = firstIncompleteIndex(next);
      if (index !== -1) next[index] = applyDetail(next[index], message, ignore);
    }
  }

  return next.map((item) => scrubItem(item, ignore));
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
