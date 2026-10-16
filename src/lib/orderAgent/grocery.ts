import { foldAgent } from "@/lib/orderAgent/catalog";
import type { AgentLine, AgentUnit } from "@/lib/orderAgent/types";
import { quoteItemNeedsDetail, quoteQuestionForItems, waiverNote } from "@/lib/quoteProductClarity";
import type { PedidoItemInput } from "@/lib/services/captureEngine";

const WORD_QTY: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  medio: 0.5,
  media: 0.5,
};

const PACK_WORD: Record<string, string> = {
  paquete: "paquete",
  paquetes: "paquete",
  bolsa: "bolsa",
  bolsas: "bolsa",
  caja: "caja",
  cajas: "caja",
  botella: "botella",
  botellas: "botella",
  lata: "lata",
  latas: "lata",
  rollo: "rollo",
  rollos: "rollo",
  frasco: "frasco",
  frascos: "frasco",
};

const MEASURE_WORD: Record<string, AgentUnit> = {
  litro: "l",
  litros: "l",
  lt: "l",
  lts: "l",
  l: "l",
  kilo: "kg",
  kilos: "kg",
  kg: "kg",
  gramo: "g",
  gramos: "g",
  g: "g",
  gr: "g",
};

const COUNT_WORD = new Set(["pieza", "piezas", "pz", "pza", "pzas", "pzs"]);

const KNOWN_BRANDS: Array<[string, string]> = [
  ["santa clara", "Santa Clara"],
  ["tia rosa", "Tía Rosa"],
  ["don julio", "Don Julio"],
  ["coca cola", "Coca-Cola"],
  ["philadelphia", "Philadelphia"],
  ["lala", "Lala"],
  ["alpura", "Alpura"],
  ["chelita", "Chelita"],
  ["nutrioli", "Nutrioli"],
  ["pepsi", "Pepsi"],
  ["pinol", "Pinol"],
  ["zote", "Zote"],
];

const PRODUCT_NOUNS = new Set([
  "leche",
  "leches",
  "tortilla",
  "tortillas",
  "queso",
  "quesos",
  "crema",
  "vaso",
  "vasos",
  "medida",
  "aceite",
  "aguacate",
  "refresco",
  "refrescos",
  "jabon",
  "papel",
  "harina",
  "maiz",
  "entera",
  "enteras",
  "deslactosada",
  "light",
  "gramo",
  "gramos",
  "litro",
  "litros",
  "kilo",
  "kilos",
  "paquete",
  "paquetes",
  "pieza",
  "piezas",
]);

export type ParsedGrocery = {
  name: string;
  qty: number | null;
  unit: AgentUnit | null;
  brand: string | null;
  presentation: string | null;
  variant: string | null;
  note: string | null;
  pack: string | null;
};

function titleProduct(value: string): string {
  const small = new Set([
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "y",
    "con",
    "harina",
    "maiz",
    "medida",
    "entera",
    "deslactosada",
    "light",
    "gramos",
    "gramo",
    "kilos",
    "kilo",
    "litros",
    "litro",
  ]);
  return value
    .split(" ")
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLocaleLowerCase("es-MX");
      if (index > 0 && small.has(foldAgent(lower))) return lower;
      return lower.charAt(0).toLocaleUpperCase("es-MX") + lower.slice(1);
    })
    .join(" ");
}

function wordQty(token: string): number | null {
  const folded = foldAgent(token);
  if (/^\d+(?:\.\d+)?$/.test(folded)) {
    const value = Number(folded);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return WORD_QTY[folded] ?? null;
}

/** "Arina" junto a tortillas es harina. "de de" es un tropiezo, no parte del nombre. */
export function normalizeGroceryWords(value: string): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const harina = /tortilla/i.test(text) ? text.replace(/\barina\b/gi, "harina") : text;
  return harina.replace(/\bde\s+de\b/gi, "de").replace(/\s+/g, " ").trim();
}

function variantOf(name: string): string | null {
  const folded = foldAgent(name);
  if (/\bdeslactosada\b|\bsin lactosa\b/.test(folded)) return "deslactosada";
  if (/\blight\b|\bdescremada\b/.test(folded)) return "light";
  if (/\bentera\b/.test(folded)) return "entera";
  if (/\bde harina\b/.test(folded)) return "de harina";
  if (/\bde maiz\b/.test(folded)) return "de maíz";
  if (/\bchica\b/.test(folded)) return "chica";
  if (/\bgrande\b/.test(folded)) return "grande";
  return null;
}

function brandOf(name: string): string | null {
  const folded = foldAgent(name);
  for (const [needle, label] of KNOWN_BRANDS) {
    if (folded.includes(needle)) return label;
  }
  const extras = name.split(" ").filter((word) => {
    const token = foldAgent(word);
    return token.length >= 4 && !/^\d+$/.test(token) && !PRODUCT_NOUNS.has(token);
  });
  if (extras.length === 1) return titleProduct(extras[0]);
  return null;
}

/**
 * Quita la cantidad del nombre. "2 2 Queso Crema" queda "Queso Crema".
 * "3 litros de leche" queda leche, 3, litros.
 */
export function parseGroceryFreeText(raw: string): ParsedGrocery {
  const note = waiverNote(raw);
  let rest = normalizeGroceryWords(raw);
  let qty: number | null = null;
  let unit: AgentUnit | null = null;
  let pack: string | null = null;

  for (let pass = 0; pass < 4 && rest; pass += 1) {
    const tokens = rest.split(" ").filter(Boolean);
    const first = foldAgent(tokens[0] ?? "");
    const second = foldAgent(tokens[1] ?? "");
    const qtyWord = wordQty(tokens[0] ?? "");
    const measure = MEASURE_WORD[second];
    const packWord = PACK_WORD[second];
    if (qtyWord != null && (measure || packWord || COUNT_WORD.has(second))) {
      qty = qtyWord;
      if (measure) unit = measure;
      if (packWord) {
        unit = "pz";
        pack = packWord;
      }
      if (COUNT_WORD.has(second)) unit = "pz";
      rest = tokens.slice(2).join(" ").replace(/^(de\s+)+/i, "").trim();
      continue;
    }
    if (qtyWord != null && tokens.length > 1 && !MEASURE_WORD[first] && !PACK_WORD[first]) {
      qty = qtyWord;
      rest = tokens.slice(1).join(" ").replace(/^(de\s+)+/i, "").trim();
      continue;
    }
    if (MEASURE_WORD[first] && tokens.length > 1) {
      unit = MEASURE_WORD[first];
      rest = tokens.slice(1).join(" ").replace(/^(de\s+)+/i, "").trim();
      continue;
    }
    if (PACK_WORD[first] && tokens.length > 1) {
      pack = PACK_WORD[first];
      unit = unit ?? "pz";
      rest = tokens.slice(1).join(" ").replace(/^(de\s+)+/i, "").trim();
      continue;
    }
    break;
  }

  rest = rest
    .replace(/^(de\s+)+/i, "")
    .replace(
      /\b(del que sea|de la que sea|de lo que sea|la que sea|el que sea|lo que sea|cualquiera|lo que haya|la que haya|el que haya|me da igual|da igual|como sea|la que tengas|el que tengas|lo que tengas)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const name = titleProduct(rest);
  const variant = variantOf(name);
  const sized = variant === "chica" || variant === "grande" ? variant : null;
  return {
    name,
    qty,
    unit,
    brand: brandOf(name),
    presentation: pack ?? sized,
    variant: sized ? null : variant,
    note,
    pack,
  };
}

export function groceryFamily(text: string): string | null {
  const folded = foldAgent(normalizeGroceryWords(text));
  if (/\bqueso\b/.test(folded) && /\bcrema\b/.test(folded)) return "queso crema";
  if (/\btortilla/.test(folded)) return "tortilla";
  if (/\bleche/.test(folded)) return "leche";
  if (/\bqueso/.test(folded)) return "queso";
  if (/\bvaso/.test(folded)) return "vaso";
  if (/\b(refresco|coca|pepsi)\b/.test(folded)) return "refresco";
  if (/\baceite\b/.test(folded)) return "aceite";
  if (/\bjabon\b/.test(folded)) return "jabon";
  if (/\bpapel\b/.test(folded)) return "papel";
  return null;
}

function probeItem(line: Pick<AgentLine, "name" | "brand" | "presentation" | "variant" | "qty" | "unit" | "note">): PedidoItemInput {
  const sizeHint = line.unit === "l" ? `${line.qty} litros` : line.unit === "kg" ? `${line.qty} kilos` : line.unit === "g" ? `${line.qty} g` : "";
  const unidad = line.unit === "l" ? "litro" : line.unit === "kg" ? "kilo" : line.unit === "g" ? "g" : line.unit === "pesos" ? "pesos" : "pieza";
  return {
    nombre_producto: line.name,
    marca: line.brand,
    presentacion: [line.variant, line.presentation, sizeHint].filter(Boolean).join(" ") || null,
    cantidad: line.qty,
    unidad,
    notas: line.note,
  };
}

/** Reglas de quoteProductClarity, como retroalimentación al agente. Null si ya se puede anotar. */
export function groceryClarityError(line: Pick<AgentLine, "name" | "brand" | "presentation" | "variant" | "qty" | "unit" | "note">): string | null {
  if (!line.name.trim()) return "Falta el producto. No anotes solo la cantidad.";
  if (waiverNote(`${line.note ?? ""} ${line.name}`)) return null;
  const item = probeItem(line);
  if (!quoteItemNeedsDetail(item)) return null;
  const question = quoteQuestionForItems([item]);
  if (!question) return null;
  return `Falta marca, tipo o tamaño. No lo anotes todavía. Pregúntalo en su propio ask_customer, sin juntarlo con otro producto y sin repetir lo que el cliente ya dijo: ${question}`;
}

export function sameGroceryLine(left: Pick<AgentLine, "name" | "freeText">, right: Pick<AgentLine, "name" | "freeText">): boolean {
  const family = groceryFamily(`${left.name} ${left.freeText ?? ""}`);
  if (!family) return false;
  return family === groceryFamily(`${right.name} ${right.freeText ?? ""}`);
}
