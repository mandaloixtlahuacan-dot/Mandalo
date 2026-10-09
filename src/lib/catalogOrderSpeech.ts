/**
 * Lo que el cliente dijo de un menú fijo, sin completar huecos.
 *
 * La IA a veces anota "Chica" y "1 pieza" y en el mismo mensaje pregunta
 * tamaño y cantidad. Aquí el texto del cliente gana: no se guarda un tamaño
 * ni una cantidad que no dijo, y un mensaje que suma Pepsi o un dogo se
 * agrega al pedido aunque la IA solo haya repetido la hamburguesa.
 */

import type { CatalogPriceRow } from "@/lib/catalogQuantities";
import { formatCheckedLine, joinBlocks, stripBotDecorations } from "@/lib/messageStyle";

export type CatalogSpeechItem = {
  nombre_producto: string;
  marca?: string | null;
  presentacion?: string | null;
  cantidad?: number | null;
  unidad?: string | null;
  notas?: string | null;
};

export type CatalogSpeechResult = {
  applied: boolean;
  missing: boolean;
  items: CatalogSpeechItem[];
  /** Lista "Anoto" y, si falta algo, una sola pregunta de ese hueco. */
  reply: string | null;
  /** Solo el hueco, para pegarlo debajo del resumen de confirmación. */
  question: string | null;
  /** Producto que el cliente dijo y el menú no tiene, o un corte que no se maneja así. */
  aside: string | null;
};

type AnchorKind = "hamburguesa" | "dogo" | "refresco" | "product";
type Gap = "tamano" | "cantidad" | "marca" | "tipo";

const QTY: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  unos: 1,
  unas: 1,
  otro: 1,
  otra: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

const FILLER = new Set([
  "ok", "va", "quiero", "quiere", "queremos", "dame", "ponme", "gustaria", "gusta",
  "tambien", "ademas", "me", "te", "se", "porfa", "por", "favor", "de", "del", "la",
  "el", "los", "las", "y", "e", "o", "con", "sin", "para", "que", "un", "una", "uno",
  "unos", "unas", "al", "lo", "ya", "es", "son", "esa", "ese", "eso",
  "oye", "mira", "pues", "fijate", "fijese", "verdad", "este", "esta", "nomas", "solo",
  "seria", "serian", "seran", "agrega", "agregame", "agregale", "anade", "anademe",
  "quieta", "quita", "kita", "cambia", "cambiar",
  "pero", "faltaron", "faltan", "faltaba", "falta", "demas",
]);

const SIZE_WORDS = ["chica", "chico", "mediana", "mediano", "grande", "sencilla", "sencillo", "doble", "triple"];
const SIZE_FOLD: Record<string, string> = {
  chica: "chica",
  chicas: "chica",
  chico: "chico",
  chicos: "chico",
  mediana: "mediana",
  medianas: "mediana",
  mediano: "mediano",
  medianos: "mediano",
  grande: "grande",
  grandes: "grande",
  sencilla: "sencilla",
  sencillas: "sencilla",
  sencillo: "sencillo",
  sencillos: "sencillo",
  doble: "doble",
  dobles: "doble",
  triple: "triple",
  triples: "triple",
};
const BRANDS = ["pepsi", "coca", "seven", "sprite", "mirinda", "manzana"];
const HEADS = new Set(["hamburguesa", "dogo", "hotdog", "refresco"]);

/** Una sola forma de «grande/grandes», «chica/chicas», «la grande», «2 grandes». */
export function foldSizeToken(word: string): string | null {
  return SIZE_FOLD[norm(word)] ?? null;
}

function isSizeWord(word: string): boolean {
  return foldSizeToken(word) != null;
}

type Family = {
  key: string;
  /** Nombre sin gramos/piezas, para reconocer «papas gajo» en «Papas Gajo 315g». */
  matchKey: string;
  rows: CatalogPriceRow[];
  nameTokens: string[];
  distinct: string[];
  unsizedName: string;
  sizes: string[];
};

type SpokenLine = {
  familyKey: string;
  nombre: string;
  marca: string | null;
  cantidad: number | null;
  unidad: string | null;
  presentacion: string | null;
  gaps: Gap[];
  sizeAsk: string;
  label: string;
  distinct: string[];
  nameTokens: string[];
  /** Palabra que agrupa varias filas (hamburguesa, dogo, bistec). */
  head: string;
  options: string[];
  /** El cliente dijo un número en este tramo. Si no, se conserva la cantidad ya anotada. */
  qtyExplicit: boolean;
  /** Pregunta concreta cuando el tramo no cayó en una fila («¿Te refieres a X?»). */
  ask?: string | null;
};

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\bhotwins\b/g, "hot wings")
    .replace(/\bhotwings\b/g, "hot wings")
    .replace(/\bhot\s+wins\b/g, "hot wings")
    .replace(/\$\s*(\d+)/g, "$1 pesos")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_WORDS = new Set([
  "kilo", "kilos", "kg", "gramo", "gramos", "gram", "pieza", "piezas",
]);

function canon(word: string): string {
  const sized = SIZE_FOLD[word];
  if (sized) return sized;
  if (
    word === "hamburguesas" ||
    word === "amburguesa" ||
    word === "amburguesas" ||
    word === "hamburgesa" ||
    word === "hamburgesas"
  ) {
    return "hamburguesa";
  }
  if (word === "hawaianas" || word === "awaiana" || word === "awaianas") return "hawaiana";
  if (word === "hawaianos" || word === "hawaiano" || word === "awaiano" || word === "awaianos") return "hawaiano";
  if (word === "cubanas") return "cubana";
  if (word === "cubanos") return "cubano";
  if (
    word === "hotdogs" ||
    word === "hotdog" ||
    word === "dogos" ||
    word === "dogo" ||
    word === "dogs" ||
    word === "dog" ||
    word === "jotdog" ||
    word === "jotdogs"
  ) {
    return "dogo";
  }
  if (word === "refrescos" || word === "refrezco" || word === "refrezcos") return "refresco";
  if (word === "salchiloco" || word === "salchilokos") return "salchilocos";
  if (word === "pepsis") return "pepsi";
  if (word === "cocas" || word === "cocacolas") return "coca";
  if (word === "sevens") return "seven";
  if (word === "sprites") return "sprite";
  if (word === "mirindas") return "mirinda";
  if (word === "manzanitas" || word === "manzanita") return "manzana";
  if (word === "clasicos" || word === "clasicas" || word === "clasica") return "clasico";
  if (word === "marinada" || word === "marinado" || word === "marinadas" || word === "marinados" || word === "marinda" || word === "marindo") return "marinad";
  if (word === "arracera") return "arrachera";
  if (word === "wins" || word === "win" || word === "wing" || word === "wings") return "wings";
  if (word === "chorizos") return "chorizo";
  if (word === "arracheras") return "arrachera";
  if (word === "bistecs") return "bistec";
  if (word === "costillas") return "costilla";
  if (word === "peinesillos") return "peinesillo";
  if (word === "diezmillos") return "diezmillo";
  if (word === "chamberetes") return "chamberete";
  if (word === "ribeyes") return "ribeye";
  if (word === "argentinos") return "argentino";
  if (word === "firo" || word === "firos") return "fino";
  if (word === "pulpas") return "pulpa";
  // «hawaianos» → hawaiano. «locos» (5) y «salchilocos» se quedan: si no, «salchi locos» deja de pegar.
  if (word.length >= 6 && word.endsWith("os") && !word.endsWith("locos")) return word.slice(0, -1);
  if (word.length >= 6 && word.endsWith("as") && !word.endsWith("locas")) return word.slice(0, -1);
  return word;
}

function qtyWord(word: string): number | null {
  if (QTY[word] != null) return QTY[word];
  if (/^\d{1,2}$/.test(word)) {
    const parsed = Number(word);
    if (parsed >= 1 && parsed <= 30) return parsed;
  }
  return null;
}

const MEASURE_WORDS = new Set(["medio", "media", "peso", "pesos", "cuarto"]);

function words(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((word) => qtyWord(word) == null && !UNIT_WORDS.has(word) && !MEASURE_WORDS.has(word))
    .map(canon)
    .filter((word) => word.length >= 3 && !FILLER.has(word));
}

function stripSize(value: string): string {
  return norm(value)
    .replace(/\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// «315g», «315 gramos» y «1 pieza» son el empaque del menú, no otra palabra
// que el cliente tenga que decir. Si se quedan en el nombre, «papas gajo» no
// alcanza a «Papas Gajo 315g» y «salchi locos» no alcanza a «Salchi locos 1 pieza».
function stripPack(value: string): string {
  return norm(value)
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:gramos?|grs|gr|g|kilos?|kg|piezas?|pzas?|pza|pz)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleBrand(brand: string): string {
  if (brand === "coca") return "Coca";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function sizesIn(name: string): string[] {
  const found = norm(name)
    .split(" ")
    .map((word) => SIZE_FOLD[word])
    .filter((word): word is string => Boolean(word));
  return found.filter((word, index) => found.indexOf(word) === index);
}

function unsizedLabel(name: string): string {
  return name
    .replace(/\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function familiesOf(catalog: CatalogPriceRow[]): Family[] {
  const groups = new Map<string, CatalogPriceRow[]>();
  for (const row of catalog) {
    const key = stripSize(row.nombreProducto);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const matchKey = stripPack(key) || key;
    const nameTokens = words(matchKey);
    const distinct = nameTokens.filter((token) => !HEADS.has(token));
    const sizes = SIZE_WORDS.filter((size) => rows.some((row) => sizesIn(row.nombreProducto).includes(size)));
    const sample = rows.slice().sort((a, b) => a.nombreProducto.length - b.nombreProducto.length)[0];
    return {
      key,
      matchKey,
      rows,
      nameTokens,
      distinct,
      unsizedName: unsizedLabel(sample?.nombreProducto ?? key),
      sizes,
    };
  });
}

type Measure = { qty: number; unidad: "kilo" | "pesos"; presentacion: string | null };

function measureBefore(rawText: string, index: number): Measure | null {
  const rawBefore = rawText.slice(0, index);
  const before = norm(rawBefore);
  const kiloYMedio = before.match(/(?:^|\s)(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:kilos?|kg)\s+y\s+medio\s*(?:de\s*)?$/);
  if (kiloYMedio) {
    const base = qtyWord(kiloYMedio[1]) ?? Number(kiloYMedio[1]);
    if (base >= 1 && base <= 30) return { qty: base + 0.5, unidad: "kilo", presentacion: null };
  }
  const grams = before.match(/(?:^|\s)(\d{2,4})\s*(?:gramos?|grs?|g)\s*(?:de\s*)?$/);
  if (grams) {
    const g = Number(grams[1]);
    if (g >= 50 && g <= 5000) return { qty: Math.round((g / 1000) * 1000) / 1000, unidad: "kilo", presentacion: null };
  }
  const saidMoney = /\$\s*\d/.test(rawBefore) || /\bpesos?\b/i.test(rawBefore.slice(-32));
  const moneyWord = before.match(/(?:^|\s)(cien|cincuenta|doscientos)\s+pesos?\s*(?:de\s*)?$/);
  if (moneyWord) {
    const amount = moneyWord[1] === "cien" ? 100 : moneyWord[1] === "cincuenta" ? 50 : 200;
    return { qty: amount, unidad: "pesos", presentacion: `$${amount}` };
  }
  const money = before.match(/(?:^|\s)(\d{2,4})\s*(?:pesos?)?\s*(?:de\s*)?$/);
  if (money && saidMoney) {
    const amount = Number(money[1]);
    if (amount >= 10 && amount <= 5000) return { qty: amount, unidad: "pesos", presentacion: `$${amount}` };
  }
  if (/(?:^|\s)medio\s*(?:kilo|kg)?\s*(?:de\s*)?$/.test(before)) {
    return { qty: 0.5, unidad: "kilo", presentacion: null };
  }
  const weighed = before.match(/(?:^|\s)(\d{1,2}(?:[.,]\d+)?|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:kilos?|kg)\s*(?:de\s*)?$/);
  if (weighed) {
    const raw = weighed[1].replace(",", ".");
    const parsed = qtyWord(raw) ?? Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 30) return { qty: parsed, unidad: "kilo", presentacion: null };
  }
  return null;
}

function qtyAttached(text: string, index: number): number | null {
  const measured = measureBefore(text, index);
  if (measured) return measured.qty;
  const before = norm(text.slice(0, index));
  const tokens = before.split(" ").filter(Boolean);
  for (let i = tokens.length - 1; i >= 0 && i >= tokens.length - 6; i--) {
    const word = tokens[i];
    if (UNIT_WORDS.has(word) || MEASURE_WORDS.has(word)) continue;
    const qty = qtyWord(word);
    if (qty != null) return qty;
    if (FILLER.has(word)) continue;
    break;
  }
  return null;
}

function unitAttached(text: string, index: number): string | null {
  return measureBefore(text, index)?.unidad ?? null;
}

function presentacionAttached(text: string, index: number): string | null {
  return measureBefore(text, index)?.presentacion ?? null;
}

function qtyIn(text: string): number | null {
  const match = norm(text).match(/\b(un|una|uno|unos|unas|otro|otra|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d{1,2})\b/);
  return match ? qtyWord(match[1]) : null;
}

function nickContinues(rawNick: string, kind: AnchorKind | "brand", families: Family[]): boolean {
  const nick = canon(norm(rawNick).split(" ")[0] ?? "");
  if (!nick) return false;
  return families.some((family) => {
    if (kind === "dogo" && !family.nameTokens.includes("dogo")) return false;
    if (kind === "hamburguesa" && !family.nameTokens.includes("hamburguesa")) return false;
    return family.distinct.includes(nick) || family.nameTokens.includes(nick);
  });
}

function fillerBetween(raw: string): boolean {
  const parts = norm(raw).split(" ").filter(Boolean);
  return parts.every((word) => FILLER.has(word) || QTY[word] != null);
}

/** Entre «hamburguesa» y «camarón» puede ir el tamaño: «hamburguesa grande de camarón». */
function bridgeBetween(raw: string): boolean {
  const parts = norm(raw).split(" ").filter(Boolean);
  return parts.every((word) => FILLER.has(word) || QTY[word] != null || isSizeWord(word));
}

function wordSpans(text: string): Array<{ word: string; index: number; end: number }> {
  const spans: Array<{ word: string; index: number; end: number }> = [];
  for (const match of text.matchAll(/\S+/g)) {
    if (match.index == null) continue;
    spans.push({ word: match[0], index: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function phraseHits(text: string, phrase: string): Array<{ index: number; end: number }> {
  const target = phrase.split(" ").filter(Boolean).map(canon).join("");
  if (target.length < 5) return [];
  const tokens = wordSpans(text);
  const hits: Array<{ index: number; end: number }> = [];
  // «Ribeye de res con hueso» son 5 palabras. Una ventana corta partía el corte.
  const widest = Math.min(6, tokens.length);
  for (let size = 1; size <= widest; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const slice = tokens.slice(i, i + size);
      if (slice.map((token) => canon(token.word)).join("") !== target) continue;
      hits.push({ index: slice[0].index, end: slice[slice.length - 1].end });
    }
  }
  return hits;
}

function isHeadFamily(family: Family): boolean {
  return family.nameTokens.some((token) => HEADS.has(token));
}

function productAnchorHits(text: string, families: Family[]): Array<{ index: number; end: number }> {
  const hits: Array<{ index: number; end: number }> = [];
  for (const family of families) {
    if (isHeadFamily(family)) {
      const nick = family.distinct.slice().sort((a, b) => b.length - a.length)[0];
      if (nick && nick.length >= 6) hits.push(...phraseHits(text, nick));
      continue;
    }
    const phrases = new Set<string>();
    if (family.matchKey.replace(/\s+/g, "").length >= 5) phrases.add(family.matchKey);
    const longest = family.distinct.slice().sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 6) phrases.add(longest);
    for (const phrase of phrases) hits.push(...phraseHits(text, phrase));
  }
  return hits;
}

function spansOf(text: string, families: Family[] = []): Array<{ kind: AnchorKind | null; text: string; qty: number | null; unidad: string | null; presentacion: string | null }> {
  const patterns: Array<{ kind: AnchorKind | "brand"; re: RegExp }> = [
    { kind: "hamburguesa", re: /\b(?:hamburguesas?|amburguesas?|hamburgesas?)\b/g },
    { kind: "dogo", re: /\b(?:jot\s*dogs?|hot\s*dogs?|hotdogs?|jotdogs?|dogos?|dogs?|dogo)\b/g },
    { kind: "refresco", re: /\b(?:refrescos?|refrezcos?)\b/g },
    { kind: "brand", re: /\b(pepsis?|cocas?|sevens?|sprites?|mirindas?|manzanitas?|manzana)\b/g },
  ];
  const hits: Array<{ kind: AnchorKind | "brand"; index: number; end: number }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index == null) continue;
      hits.push({ kind: pattern.kind, index: match.index, end: match.index + match[0].length });
    }
  }
  for (const hit of productAnchorHits(text, families)) {
    hits.push({ kind: "product", index: hit.index, end: hit.end });
  }
  hits.sort((a, b) => a.index - b.index || a.end - b.end);
  const kept: typeof hits = [];
  for (const hit of hits) {
    const prev = kept[kept.length - 1];
    // «un refresco pepsi» es una sola línea. «una Pepsi y una manzanita» son
    // dos: la segunda marca no se traga aunque entre medias solo haya «y una».
    if (
      hit.kind === "brand" &&
      prev?.kind === "refresco" &&
      fillerBetween(text.slice(prev.end, hit.index))
    ) {
      continue;
    }
    if (
      prev &&
      (prev.kind === "hamburguesa" || prev.kind === "dogo") &&
      hit.kind === "product" &&
      bridgeBetween(text.slice(prev.end, hit.index)) &&
      nickContinues(text.slice(hit.index, hit.end), prev.kind, families)
    ) {
      prev.end = hit.end;
      continue;
    }
    if (prev && hit.index < prev.end) {
      // «bistec de res marinada» también ancla «bistec». Se queda el nombre largo.
      if (hit.index === prev.index && hit.end > prev.end) kept[kept.length - 1] = hit;
      continue;
    }
    kept.push(hit);
  }
  if (!kept.length) return [{ kind: null, text, qty: qtyIn(text), unidad: unitAttached(text, 0), presentacion: presentacionAttached(text, 0) }];

  return kept.map((hit, index) => {
    const end = index + 1 < kept.length ? kept[index + 1].index : text.length;
    const kind: AnchorKind | null = hit.kind === "brand" ? "refresco" : hit.kind;
    return {
      kind,
      text: text.slice(hit.index, end),
      qty: qtyAttached(text, hit.index),
      unidad: unitAttached(text, hit.index),
      presentacion: presentacionAttached(text, hit.index),
    };
  });
}

function isBrandListDrink(family: Family): boolean {
  const brands = family.distinct.filter((token) => BRANDS.includes(token));
  const other = family.distinct.filter((token) => !BRANDS.includes(token));
  return brands.length >= 2 && other.length === 0;
}

function scoreFamily(family: Family, span: { kind: AnchorKind | null; text: string }): number {
  const tokens = new Set(words(span.text));
  for (const brand of BRANDS) {
    if (norm(span.text).includes(brand)) tokens.add(brand);
  }
  const compactSpan = words(span.text).join("");
  const compactKey = words(family.matchKey).join("");
  const compactHit = compactKey.length >= 5 && compactSpan.includes(compactKey);
  const brandList = isBrandListDrink(family);

  if (brandList) {
    const mentioned = BRANDS.some((brand) => tokens.has(brand));
    if (!(span.kind === "refresco" || mentioned)) return 0;
    return mentioned ? 3 : 1;
  }

  if (/marinad/.test(family.key) && rejectsMarinada(span.text)) return 0;
  if (family.distinct.length) {
    const tokensHit = family.distinct.every((token) => tokenHit(token, tokens));
    if (!tokensHit && !compactHit) return 0;
  } else if (!(family.nameTokens.includes("refresco") && (span.kind === "refresco" || BRANDS.some((brand) => tokens.has(brand))))) {
    return 0;
  }
  let score = family.distinct.length * 2;
  if (compactHit) score += 3;
  if (family.distinct.length === 0) score = 2;
  if (span.kind && span.kind !== "product" && family.nameTokens.includes(span.kind)) score += 3;
  if (span.kind === "dogo" && family.nameTokens.includes("hamburguesa")) score -= 8;
  if (span.kind === "hamburguesa" && family.nameTokens.includes("dogo")) score -= 8;
  // «hamburguesa … hawaiana» no puede caer en la Torta Hawaiana.
  if (span.kind === "hamburguesa" && !family.nameTokens.includes("hamburguesa")) return 0;
  if (span.kind === "dogo" && !family.nameTokens.includes("dogo")) return 0;
  if (span.kind === "refresco" && (family.nameTokens.includes("hamburguesa") || family.nameTokens.includes("dogo"))) score -= 8;
  const said = norm(span.text);
  if (/\bclasicos?\b/.test(said) && /\bclasico\b/.test(family.key)) score += 1;
  if (/\bclasicas?\b/.test(said) && /\bclasica\b/.test(family.key)) score += 1;
  // «bistec de puerco marinada» también contiene «bistec de puerco». El corte
  // más corto no se queda con la frase si sobra una palabra de otro producto.
  const allowed = new Set([...family.distinct, ...family.nameTokens, ...BRANDS]);
  const parts = [...family.distinct, ...family.nameTokens];
  const extras = [...tokens].filter((token) => {
    if (allowed.has(token) || isSizeWord(token)) return false;
    // «hot dog» / «jot dog»: hot y jot no son otro producto.
    if ((token === "hot" || token === "jot") && (span.kind === "dogo" || family.nameTokens.includes("dogo"))) return false;
    if ([...allowed].some((part) => closeEnough(part, token))) return false;
    // «Salchi locos» es un solo nombre en el menú («Salchilocos»): esas
    // palabras no son otro producto.
    return !parts.some((part) => part.includes(token) || token.includes(part));
  });
  if (extras.length) score -= extras.length * 3;
  return score;
}

function brandIn(text: string): string | null {
  const tokens = norm(text).split(" ").filter(Boolean).map(canon);
  const found = BRANDS.find((brand) => tokens.includes(brand));
  return found ? titleBrand(found) : null;
}

const MEAT_PLURALS = ["chorizos", "arracheras", "bistecs", "costillas", "peinesillos", "diezmillos", "chamberetes", "ribeyes"];

function uncountedPlural(span: { text: string; qty: number | null }): boolean {
  if (span.qty != null) return false;
  const said = norm(span.text);
  if (/\b(hamburguesas|amburguesas|hamburgesas|dogos|dogs|hotdogs|hot\s+dogs|jot\s+dogs|refrescos|refrezcos|manzanitas)\b/.test(said)) return true;
  return MEAT_PLURALS.some((word) => new RegExp(`\\b${word}\\b`).test(said));
}

function isDrinkLine(line: SpokenLine): boolean {
  return line.familyKey === "refresco" || line.nameTokens.includes("refresco");
}

function dropDrinkIntroducers(lines: SpokenLine[]): SpokenLine[] {
  const branded = lines.some((line) => isDrinkLine(line) && Boolean(line.marca));
  if (!branded) return lines;
  return lines.filter((line) => !(isDrinkLine(line) && !line.marca));
}

function sizeIn(text: string): string | null {
  for (const word of norm(text).split(" ").filter(Boolean)) {
    const folded = SIZE_FOLD[word];
    if (folded) return folded;
  }
  return null;
}

function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const upper = prev[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + cost);
      corner = upper;
    }
  }
  return prev[right.length];
}

function closeEnough(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  return editDistance(left, right) <= 1;
}

function tokenHit(wanted: string, tokens: Set<string>): boolean {
  if (tokens.has(wanted)) return true;
  for (const token of tokens) {
    if (closeEnough(wanted, token)) return true;
  }
  return false;
}

function rejectsMarinada(text: string): boolean {
  const said = norm(text).replace(/\b(?:marinad[ao]s?|marind[ao]s?|marinar)\b/g, "marinad");
  return /\bno\b(?:\s+(?:esta|este|la|el|lo|quiero|tan|muy|nada)){0,3}\s+marinad\b/.test(said) || /\bsin\s+marinad\b/.test(said);
}

function leadingSize(text: string, families: Family[]): string | null {
  const spans = spansOf(text, families);
  const anchored = spans.some((span) => span.kind != null);
  if (!anchored) return sizeIn(text);
  const first = spans.find((span) => span.kind != null);
  if (!first) return null;
  const at = text.indexOf(first.text);
  const prefix = at > 0 ? text.slice(0, at) : "";
  return sizeIn(prefix);
}

function sizeFollowUp(base: CatalogSpeechItem[], text: string, families: Family[]): SpokenLine | null {
  const size = leadingSize(text, families);
  if (!size) return null;
  const pending: Array<{ index: number; family: Family }> = [];
  base.forEach((item, index) => {
    const family = families.find((candidate) => candidate.key === stripSize(item.nombre_producto));
    if (!family || family.sizes.length < 2) return;
    if (sizesIn(item.nombre_producto).length) return;
    pending.push({ index, family });
  });
  if (pending.length !== 1) return null;
  const family = pending[0].family;
  const qty = base[pending[0].index]?.cantidad ?? null;
  // «2 grandes» y «las dos grandes» confirman el tamaño. No cambian la cantidad ya anotada.
  return lineFromSpan(
    { kind: null, text: `${family.key} ${size}`, qty: typeof qty === "number" ? qty : null },
    families,
    text,
  );
}

function looseScore(family: Family, spanText: string, families: Family[]): number {
  if (isBrandListDrink(family)) return 0;
  if (/marinad/.test(family.key) && rejectsMarinada(spanText)) return 0;
  if (isHeadFamily(family)) {
    const lead = family.distinct.slice().sort((a, b) => b.length - a.length)[0];
    const spoken = words(spanText).filter((token) => !isSizeWord(token));
    if (!lead || lead.length < 6 || !spoken.includes(lead)) return 0;
    const owners = families.filter((candidate) => candidate.distinct.includes(lead));
    if (owners.length !== 1) return 0;
    const extras = spoken.filter((token) => token !== lead && !family.distinct.includes(token) && !family.nameTokens.includes(token));
    if (extras.length) return 0;
    return 4;
  }
  const rawSpoken = words(spanText).filter((token) => !isSizeWord(token));
  const onMenu = rawSpoken.filter((token) =>
    families.some((candidate) =>
      candidate.nameTokens.some((name) => name === token || name.includes(token) || token.includes(name) || closeEnough(name, token)),
    ),
  );
  const spoken = onMenu.length ? onMenu : rawSpoken;
  if (!spoken.length) return 0;
  const familyTokens = new Set(family.distinct.length ? family.distinct : family.nameTokens);
  if (!spoken.every((token) => familyTokens.has(token))) return 0;
  const owners = families.filter((candidate) => {
    if (isHeadFamily(candidate) || isBrandListDrink(candidate)) return false;
    const tokens = new Set(candidate.distinct.length ? candidate.distinct : candidate.nameTokens);
    return spoken.every((token) => tokens.has(token));
  });
  if (owners.length !== 1 || owners[0] !== family) return 0;
  // «fino» y «pulpa» son cortos, pero en este menú nombran un solo producto.
  const strong =
    spoken.some((token) => token.length >= 6 || token === "fino" || token === "pulpa") || spoken.length >= 2;
  if (!strong) return 0;
  return spoken.length * 2 + 3;
}

const FAMILY_HEADS = [
  "hamburguesa",
  "dogo",
  "torta",
  "sincronizada",
  "quesadilla",
  "alitas",
  "papas",
  "bistec",
  "costilla",
  "chorizo",
  "salsa",
  "refresco",
];

function familyHead(family: Family): string {
  return family.nameTokens.find((token) => FAMILY_HEADS.includes(token)) ?? family.nameTokens[0] ?? "";
}

function titleHead(head: string): string {
  if (head === "papas") return "Papas";
  if (head === "alitas") return "Alitas";
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function shortOption(family: Family, head: string): string {
  const stripped = family.unsizedName.replace(new RegExp(`^${head}\\s+`, "i"), "").trim();
  const label = stripped || family.unsizedName;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function optionLine(labels: string[]): string {
  const unique = labels.filter((label, index) => labels.findIndex((other) => other.toLowerCase() === label.toLowerCase()) === index);
  if (unique.length <= 1) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} o ${unique[unique.length - 1]}`;
}

function saidTokens(span: { kind: AnchorKind | null; text: string }): Set<string> {
  const said = new Set(words(span.text));
  if (span.kind === "hamburguesa") said.add("hamburguesa");
  if (span.kind === "dogo") said.add("dogo");
  if (span.kind === "refresco") said.add("refresco");
  return said;
}

/** Varias filas comparten la palabra (hamburguesa, dogo, bistec) y ninguna quedó única. */
function pendingFamilyLine(
  span: { kind: AnchorKind | null; text: string; qty: number | null; unidad?: string | null; presentacion?: string | null },
  pool: Family[],
  tied: Family[] = [],
): SpokenLine | null {
  const said = saidTokens(span);
  const groups = new Map<string, Family[]>();
  const source = tied.length > 1 ? tied : pool;
  for (const family of source) {
    if (isBrandListDrink(family)) continue;
    let head = familyHead(family);
    if (head !== "dogo" && family.key.replace(/\s+/g, "").includes("dogo") && said.has("dogo")) head = "dogo";
    if (!head || !said.has(head)) continue;
    const list = groups.get(head) ?? [];
    list.push(family);
    groups.set(head, list);
  }
  let best: { head: string; families: Family[] } | null = null;
  for (const [head, families] of groups) {
    if (families.length < 2) continue;
    if (!best || families.length > best.families.length) best = { head, families };
  }
  if (!best) return null;
  const complete = best.families.filter((family) => {
    const distinct = family.distinct.filter((token) => token !== best?.head && token.length >= 3);
    return distinct.length > 0 && distinct.every((token) => tokenHit(token, said));
  });
  if (complete.length === 1 && tied.length === 0) return lineFromFamily(complete[0], span);
  const sizes = SIZE_WORDS.filter((size) => best.families.some((family) => family.sizes.includes(size)));
  const spokenSize = sizeIn(span.text);
  const gaps: Gap[] = ["tipo"];
  if (sizes.length > 1 && !spokenSize) gaps.push("tamano");
  const cantidad = span.qty ?? (uncountedPlural(span) ? null : 1);
  if (cantidad == null) gaps.push("cantidad");
  return {
    familyKey: best.head,
    nombre: titleHead(best.head),
    marca: null,
    cantidad,
    unidad: span.unidad ?? null,
    presentacion: span.presentacion ?? null,
    gaps,
    sizeAsk: sizes.join(" o "),
    label: titleHead(best.head),
    distinct: [],
    nameTokens: [best.head],
    head: best.head,
    options: best.families.map((family) => shortOption(family, best.head)),
    qtyExplicit: span.qty != null,
  };
}

function rowChoiceLine(family: Family, span: { text: string; qty: number | null; unidad?: string | null; presentacion?: string | null }): SpokenLine | null {
  if (family.rows.length < 2 || family.sizes.length > 0 || isBrandListDrink(family)) return null;
  const head = familyHead(family);
  const cantidad = span.qty ?? (uncountedPlural({ text: span.text, qty: span.qty }) ? null : 1);
  const gaps: Gap[] = ["tipo"];
  if (cantidad == null) gaps.push("cantidad");
  return {
    familyKey: family.key,
    nombre: titleHead(head || family.unsizedName),
    marca: null,
    cantidad,
    unidad: span.unidad ?? null,
    presentacion: span.presentacion ?? null,
    gaps,
    sizeAsk: "",
    label: titleHead(head || "opción"),
    distinct: family.distinct,
    nameTokens: family.nameTokens,
    head: head,
    options: family.rows.map((row) => row.nombreProducto),
    qtyExplicit: span.qty != null,
  };
}

type Span = { kind: AnchorKind | null; text: string; qty: number | null; unidad?: string | null; presentacion?: string | null };

function lineFromFamily(family: Family, span: Span): SpokenLine | null {
  const spokenSize = sizeIn(span.text);
  const wantedSize = spokenSize === "chico" ? "chica" : spokenSize === "mediano" ? "mediana" : spokenSize === "sencillo" ? "sencilla" : spokenSize;
  const sizedRow = wantedSize
    ? family.rows.find((row) => sizesIn(row.nombreProducto).includes(wantedSize))
    : null;
  const needsSize = family.sizes.length > 1 && !sizedRow;
  const brandList = isBrandListDrink(family);
  const drink = (family.nameTokens.includes("refresco") && family.distinct.length === 0) || brandList;
  const brand = drink ? brandIn(span.text) : null;
  const needsBrand = drink && !brand;
  const gaps: Gap[] = [];
  if (needsSize) gaps.push("tamano");
  if (needsBrand) gaps.push("marca");
  const cantidad = span.qty ?? (uncountedPlural(span) ? null : 1);
  if (cantidad == null) gaps.push("cantidad");
  const pieceChoice = !needsSize && !sizedRow ? rowChoiceLine(family, span) : null;
  if (pieceChoice) return pieceChoice;
  const single = family.rows.length === 1 ? family.rows[0].nombreProducto : family.unsizedName;
  const nombre = sizedRow?.nombreProducto ?? (needsSize ? family.unsizedName : brandList ? "Refresco" : single);
  return {
    familyKey: brandList ? "refresco" : family.key,
    nombre: brandList ? "Refresco" : nombre,
    marca: brand,
    cantidad,
    unidad: span.unidad ?? null,
    presentacion: span.presentacion ?? null,
    gaps,
    sizeAsk: family.sizes.join(" o "),
    label: brandList ? "Refresco" : family.unsizedName,
    distinct: brandList ? [] : family.distinct,
    nameTokens: brandList ? ["refresco"] : family.nameTokens,
    head: brandList ? "refresco" : familyHead(family),
    options: [],
    qtyExplicit: span.qty != null,
  };
}

function lineFromSpan(span: Span, catalog: Family[], fullText = ""): SpokenLine | null {
  const pool = fullText && rejectsMarinada(fullText) ? catalog.filter((family) => !/marinad/.test(family.key)) : catalog;
  const ranked = pool
    .map((family) => {
      const strict = scoreFamily(family, span);
      return { family, score: strict > 0 ? strict : looseScore(family, span.text, pool) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const tied = ranked.length > 1 && ranked[0].score === ranked[1].score;
  if (!ranked.length || tied) {
    const pending = pendingFamilyLine(span, pool, tied ? ranked.filter((entry) => entry.score === ranked[0].score).map((entry) => entry.family) : []);
    return pending;
  }
  return lineFromFamily(ranked[0].family, span);
}

function spanScore(span: Span, families: Family[]): number {
  return families.reduce((best, family) => {
    const strict = scoreFamily(family, span);
    const score = strict > 0 ? strict : looseScore(family, span.text, families);
    return Math.max(best, score);
  }, 0);
}

/** Un tramo con puntaje ≤ 0 se vuelve a partir en cantidades y cabezas, para no tragarse el siguiente producto. */
function resplitWeak(text: string): string[] | null {
  const re = /\b(?:un|una|uno|unos|unas|otro|otra|otros|otras|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d{1,2}|hamburguesas?|amburguesas?|hamburgesas?|jot\s*dogs?|hot\s*dogs?|dogos?|dogs?|dogo|refrescos?|refrezcos?)\b/g;
  const cuts: number[] = [];
  for (const match of text.matchAll(re)) {
    if (match.index == null || match.index <= 0) continue;
    cuts.push(match.index);
  }
  if (!cuts.length) return null;
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut <= start) continue;
    parts.push(text.slice(start, cut));
    start = cut;
  }
  parts.push(text.slice(start));
  const usable = parts.map((part) => part.trim()).filter(Boolean);
  return usable.length > 1 ? usable : null;
}

function unresolvedLine(span: Span, families: Family[], fullText = ""): SpokenLine | null {
  if (rejectsMarinada(span.text) || rejectsMarinada(fullText)) return null;
  const tokens = words(span.text).filter((token) => !isSizeWord(token) && token !== "hot" && token !== "jot" && !/marinad/.test(token));
  if (!tokens.length) return null;
  const onMenu = families.some((family) =>
    family.nameTokens.some((token) =>
      tokens.some((said) => token === said || token.includes(said) || said.includes(token) || closeEnough(token, said)),
    ),
  );
  if (!onMenu) return null;
  const label = tokens.map(titleWord).join(" ");
  const closest = families
    .map((family) => {
      const hits = family.nameTokens.filter((token) =>
        tokens.some((said) => token === said || token.includes(said) || said.includes(token) || closeEnough(token, said)),
      ).length;
      return { family, hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)[0];
  const guess = closest ? (isBrandListDrink(closest.family) ? "Refresco" : closest.family.unsizedName) : label;
  return {
    familyKey: norm(label),
    nombre: label,
    marca: null,
    cantidad: span.qty ?? (uncountedPlural(span) ? null : 1),
    unidad: span.unidad ?? null,
    presentacion: span.presentacion ?? null,
    gaps: ["tipo"],
    sizeAsk: "",
    label,
    distinct: [],
    nameTokens: tokens,
    head: "",
    options: [],
    qtyExplicit: span.qty != null,
    ask: `¿Te refieres a ${guess}?`,
  };
}

function interpretText(text: string, families: Family[], fullText: string, depth = 0): SpokenLine[] {
  const lines: SpokenLine[] = [];
  for (const span of spansOf(text, families)) {
    const line = lineFromSpan(span, families, fullText);
    // Puntaje claro, o un «¿cuál hamburguesa?» que ya trae su cantidad.
    // Re-partir ese tramo se comería el «dos» del producto que sigue.
    if (line && (spanScore(span, families) > 0 || (line.gaps.includes("tipo") && !line.ask))) {
      lines.push(line);
      continue;
    }
    if (depth < 2) {
      const pieces = resplitWeak(span.text);
      if (pieces) {
        const nested = pieces.flatMap((piece) => interpretText(piece, families, fullText, depth + 1));
        if (nested.length) {
          lines.push(...nested);
          continue;
        }
      }
    }
    if (line) {
      lines.push(line);
      continue;
    }
    const asked = unresolvedLine(span, families, fullText);
    if (asked) lines.push(asked);
  }
  return lines;
}

function sameFamily(item: CatalogSpeechItem, line: SpokenLine): boolean {
  const key = stripSize(item.nombre_producto);
  let matched = key === line.familyKey;
  if (!matched) {
    if (!line.distinct.length || !line.distinct.every((token) => words(key).includes(token))) return false;
    const tokens = new Set(words(key));
    const itemIsDogo = tokens.has("dogo");
    const itemIsBurger = tokens.has("hamburguesa");
    const familyIsDogo = line.nameTokens.includes("dogo");
    const familyIsBurger = line.nameTokens.includes("hamburguesa");
    if (itemIsDogo && familyIsBurger) return false;
    if (itemIsBurger && familyIsDogo) return false;
    matched = true;
  }
  const itemBrand = canon(norm(String(item.marca ?? "")));
  const lineBrand = canon(norm(String(line.marca ?? "")));
  if (itemBrand && lineBrand && itemBrand !== lineBrand) return false;
  return matched;
}

function pieceLabel(qty: number): string {
  const shown = Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 100) / 100);
  return qty === 1 ? "1 pieza" : `${shown} piezas`;
}

function itemLine(item: CatalogSpeechItem): string {
  const name = [item.nombre_producto, item.marca].filter(Boolean).join(" ");
  if (item.unidad === "pesos" && typeof item.cantidad === "number") return formatCheckedLine(`${name} — $${item.cantidad}`);
  if (item.unidad === "kilo" && typeof item.cantidad === "number" && item.cantidad > 0) {
    const shown = Number.isInteger(item.cantidad) ? String(item.cantidad) : String(Math.round(item.cantidad * 1000) / 1000);
    return formatCheckedLine(`${name} — ${shown} ${item.cantidad === 1 ? "kilo" : "kilos"}`);
  }
  if (typeof item.cantidad === "number" && item.cantidad > 0) return formatCheckedLine(`${name} — ${pieceLabel(item.cantidad)}`);
  return formatCheckedLine(name);
}

function headEmoji(head: string): string {
  if (head === "hamburguesa") return "🍔";
  if (head === "dogo") return "🌭";
  if (head === "papas") return "🍟";
  if (head === "refresco") return "🥤";
  if (["bistec", "costilla", "chorizo", "salsa", "arrachera"].includes(head)) return "🥩";
  return "🍽️";
}

function questionFor(lines: SpokenLine[], itemCount: number): string | null {
  const pending = lines.filter((line) => line.gaps.length);
  if (!pending.length) return null;
  return pending
    .map((line) => {
      if (line.ask) return line.ask;
      const size = line.gaps.includes("tamano");
      const brand = line.gaps.includes("marca");
      const qty = line.gaps.includes("cantidad");
      const tipo = line.gaps.includes("tipo");
      const who = itemCount > 1 && !tipo ? `${line.label}, ` : "";
      if (tipo) {
        const several = (line.cantidad ?? 1) > 1;
        const asked = line.head === "papas" || line.head.endsWith("s") ? line.head : `${line.head}s`;
        const ask = several ? `*¿Cuáles ${asked}? (pueden ser distintas)*` : `${headEmoji(line.head)} *¿Cuál ${line.head}?*`;
        const options = optionLine(line.options);
        const sizeLine = size && line.sizeAsk ? `\n\n*¿${line.sizeAsk.charAt(0).toUpperCase()}${line.sizeAsk.slice(1)}?*` : "";
        return `${ask}\n\n${options}${sizeLine}`;
      }
      if (size && qty && !brand) return who ? `¿${who}la quieres ${line.sizeAsk}, y cuántas?` : `¿La quieres ${line.sizeAsk}, y cuántas?`;
      if (size && !brand) return who ? `¿${who}la quieres ${line.sizeAsk}?` : `¿La quieres ${line.sizeAsk}?`;
      if (brand && qty) return who ? `¿${who}de qué marca y cuántas? Por ejemplo Pepsi, Coca o Seven.` : "¿De qué marca y cuántas? Por ejemplo Pepsi, Coca o Seven.";
      if (brand) return who ? `¿${who}de qué marca? Por ejemplo Pepsi, Coca o Seven.` : "¿De qué marca? Por ejemplo Pepsi, Coca o Seven.";
      if (qty) return who ? `¿${who}cuántas piezas?` : "¿Cuántas piezas?";
      return null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

/** Si la lista tiene un tipo pendiente, el cliente puede contestar sin repetir la palabra. */
function prefixPendingHeads(text: string, base: CatalogSpeechItem[], families: Family[]): string {
  const heads = base
    .filter((item) => norm(item.notas ?? "") === "falta tipo")
    .map((item) => norm(item.nombre_producto))
    .filter((head) => FAMILY_HEADS.includes(head));
  if (!heads.length) return text;
  const headAlt = FAMILY_HEADS.map((head) => (head.endsWith("s") ? head : `${head}s?`)).join("|");
  const parts = text.split(new RegExp(`(\\s*,\\s*|\\s+\\by\\b\\s+|\\s+(?=(?:${headAlt})\\b))`));
  return parts
    .map((part) => {
      if (/^\s*,\s*$/.test(part) || /^\s+y\s+$/.test(part) || !part.trim()) return part;
      const said = new Set(words(part));
      if (heads.some((head) => said.has(head))) return part;
      const head = heads.find((candidate) =>
        families.some(
          (family) =>
            familyHead(family) === candidate &&
            family.distinct.some((token) => token !== candidate && tokenHit(token, said)),
        ),
      );
      return head ? `${head} ${part}` : part;
    })
    .join("");
}

function familyForItem(item: CatalogSpeechItem, families: Family[]): Family | null {
  const key = stripSize(item.nombre_producto);
  const direct = families.find((family) => family.key === key);
  if (direct) return direct;
  if (norm(item.nombre_producto) === "refresco" || key.startsWith("refresco")) {
    return families.find((family) => isBrandListDrink(family)) ?? null;
  }
  return null;
}

/** Huecos que ya estaban anotados y este mensaje no cerró: el sabor del refresco sigue abierto. */
function lingeringLines(items: CatalogSpeechItem[], families: Family[], open: SpokenLine[]): SpokenLine[] {
  const extra: SpokenLine[] = [];
  for (const item of items) {
    if (/\b(?:la|el) que sea\b/.test(norm(item.notas ?? "")) || /\b(?:la|el) que sea\b/.test(norm(item.marca ?? ""))) continue;
    const family = familyForItem(item, families);
    const drink = Boolean(family && isBrandListDrink(family));
    const gaps: Gap[] = [];
    if (norm(item.notas ?? "") === "falta tipo") gaps.push("tipo");
    if (drink && !item.marca) gaps.push("marca");
    if (family && family.sizes.length > 1 && !sizesIn(item.nombre_producto).length && norm(item.notas ?? "") !== "falta tipo") {
      gaps.push("tamano");
    }
    if (typeof item.cantidad !== "number" && norm(item.notas ?? "") !== "falta tipo") gaps.push("cantidad");
    const fresh = gaps.filter((gap) => !open.some((line) => line.gaps.includes(gap) && sameFamily(item, line)));
    if (!fresh.length) continue;
    const head = family ? familyHead(family) : norm(item.nombre_producto);
    const group = families.filter((candidate) => familyHead(candidate) === head);
    extra.push({
      familyKey: drink ? "refresco" : family?.key ?? norm(item.nombre_producto),
      nombre: drink ? "Refresco" : item.nombre_producto,
      marca: item.marca ?? null,
      cantidad: typeof item.cantidad === "number" ? item.cantidad : null,
      unidad: item.unidad ?? null,
      presentacion: item.presentacion ?? null,
      gaps: fresh,
      sizeAsk: family?.sizes.join(" o ") ?? "",
      label: drink ? "Refresco" : family?.unsizedName ?? item.nombre_producto,
      distinct: drink ? [] : family?.distinct ?? [],
      nameTokens: drink ? ["refresco"] : family?.nameTokens ?? words(item.nombre_producto),
      head,
      options: fresh.includes("tipo") ? group.map((candidate) => shortOption(candidate, head)) : [],
      qtyExplicit: true,
    });
  }
  return extra;
}

function uncoveredQuestion(
  text: string,
  items: CatalogSpeechItem[],
  question: string | null,
  aside: string | null,
): string | null {
  const covered = new Set<string>();
  for (const item of items) {
    for (const token of words(`${item.nombre_producto} ${item.marca ?? ""}`)) covered.add(token);
  }
  const blob = norm(`${question ?? ""} ${aside ?? ""}`);
  if (rejectsMarinada(text)) return null;
  const branded = items.some((item) => {
    const name = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
    return BRANDS.some((brand) => name.includes(brand));
  });
  const missing: string[] = [];
  for (const token of words(text)) {
    if (isSizeWord(token) || token === "hot" || token === "jot" || /marinad/.test(token)) continue;
    // «3 refrescos: 1 Pepsi y 2 manzanitas»: refresco solo presenta las marcas.
    if (token === "refresco" && branded) continue;
    const hit = [...covered].some(
      (known) => known === token || known.includes(token) || token.includes(known) || closeEnough(known, token),
    );
    if (hit || blob.includes(token)) continue;
    missing.push(token);
  }
  if (!missing.length) return null;
  return `¿Te refieres a ${missing.map((token) => titleWord(token)).join(" ")}?`;
}

export function applyCatalogSpeech(params: {
  base: CatalogSpeechItem[];
  userMessage: string;
  catalog: CatalogPriceRow[];
}): CatalogSpeechResult {
  const base = params.base.map((item) => ({ ...item }));
  const families = familiesOf(params.catalog);
  const text = prefixPendingHeads(norm(stripBotDecorations(params.userMessage)), base, families);
  if (!text || !families.length) return { applied: false, missing: false, items: base, reply: null, question: null, aside: null };

  for (const item of base) {
    const family = familyForItem(item, families);
    if (family && isBrandListDrink(family)) item.nombre_producto = "Refresco";
  }

  const fromAnchors = interpretText(text, families, text);
  const sizeLine = sizeFollowUp(base, text, families);
  const combined =
    sizeLine && !fromAnchors.some((line) => line.familyKey === sizeLine.familyKey && !line.gaps.includes("tamano"))
      ? [sizeLine, ...fromAnchors]
      : fromAnchors.length
        ? fromAnchors
        : sizeLine
          ? [sizeLine]
          : [];
  const spoken = dropDrinkIntroducers(combined);
  const aside = noticeFor(text, spoken, families);
  if (!spoken.length && !aside) return { applied: false, missing: false, items: base, reply: null, question: null, aside: null };
  if (!spoken.length) return { applied: true, missing: true, items: base, reply: aside, question: aside, aside };

  const items = base;
  for (const line of spoken) {
    let index = items.findIndex((item) => sameFamily(item, line) && norm(item.notas ?? "") !== "falta tipo");
    if (index < 0 && line.head) {
      index = items.findIndex((item) => norm(item.notas ?? "") === "falta tipo" && norm(item.nombre_producto) === line.head);
    }
    if (index < 0) index = items.findIndex((item) => sameFamily(item, line));
    // «el argentino» precisa el chorizo ya anotado. No abre otra línea de 1.
    if (index < 0 && !line.qtyExplicit && !line.gaps.includes("tipo")) {
      const generic = items.findIndex((item) => {
        if (norm(item.notas ?? "") === "falta tipo") return false;
        const short = norm(item.nombre_producto);
        const long = norm(line.nombre);
        return Boolean(short) && long.startsWith(`${short} `) && short.split(" ").length <= 3;
      });
      if (generic >= 0) index = generic;
    }
    const previous = index >= 0 ? items[index] : null;
    const adding = /^(?:agrega\w*|a[nñ]ade\w*|a[nñ]adir)\b/.test(norm(stripBotDecorations(params.userMessage)));
    const addingOnto =
      adding &&
      previous != null &&
      norm(previous.notas ?? "") !== "falta tipo" &&
      !line.gaps.includes("tipo") &&
      !line.gaps.includes("tamano") &&
      norm(previous.nombre_producto) === norm(line.nombre);
    let cantidad = line.qtyExplicit
      ? line.cantidad
      : typeof previous?.cantidad === "number"
        ? previous.cantidad
        : line.cantidad;
    if (addingOnto) {
      const extra = line.qtyExplicit ? (line.cantidad ?? 1) : 1;
      const baseQty = typeof previous.cantidad === "number" && previous.cantidad > 0 ? previous.cantidad : 1;
      cantidad = baseQty + extra;
    } else if (cantidad != null) {
      line.gaps = line.gaps.filter((gap) => gap !== "cantidad");
    }
    if (line.marca == null && previous?.marca) line.marca = previous.marca;
    if (line.gaps.includes("marca") && line.marca) {
      line.gaps = line.gaps.filter((gap) => gap !== "marca");
    }
    const unidad = line.unidad ?? previous?.unidad ?? null;
    const next: CatalogSpeechItem = {
      ...(previous ?? {}),
      nombre_producto: line.nombre,
      cantidad,
      ...(line.marca ? { marca: line.marca } : {}),
      ...(unidad ? { unidad } : {}),
    };
    if (line.gaps.includes("tipo")) next.notas = "falta tipo";
    else if (norm(next.notas ?? "") === "falta tipo") delete next.notas;
    if (line.presentacion) next.presentacion = line.presentacion;
    else if (line.unidad) delete next.presentacion;
    if (cantidad == null) delete next.cantidad;
    if (line.gaps.includes("tamano") && SIZE_WORDS.includes(norm(String(next.presentacion ?? "")))) {
      delete next.presentacion;
    }
    if (index >= 0) items[index] = next;
    else items.push(next);
  }

  // «una hamburguesa, mar y tierra chica» es una sola. Si en el mismo mensaje
  // ya quedó la de mar y tierra, no se pregunta otra vez cuál hamburguesa.
  const answered = new Set(spoken.filter((line) => line.head && !line.gaps.includes("tipo")).map((line) => line.head));
  if (answered.size) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (norm(items[index]?.notas ?? "") !== "falta tipo") continue;
      if (answered.has(norm(items[index]?.nombre_producto ?? ""))) items.splice(index, 1);
    }
  }
  const open = [
    ...spoken.filter((line) => !(line.head && line.gaps.includes("tipo") && answered.has(line.head))),
    ...lingeringLines(items, families, spoken),
  ];

  const hole = questionFor(open, items.length);
  const uncovered = uncoveredQuestion(text, items, hole, aside);
  const question = [hole, uncovered, aside].filter(Boolean).join(" ") || null;
  const missing =
    open.some((line) => line.gaps.length) ||
    Boolean(uncovered) ||
    items.some((item) => norm(item.notas ?? "") === "falta tipo");
  const shown = items.filter((item) => norm(item.notas ?? "") !== "falta tipo");
  const reply = shown.length
    ? `🛒 *Anoto:*\n\n${joinBlocks(shown.map(itemLine))}${question ? `\n\n${question}` : ""}`
    : question;
  return { applied: true, missing, items, reply, question, aside };
}

const OFF_MENU_NOISE = new Set<string>([
  ...FILLER,
  ...UNIT_WORDS,
  ...MEASURE_WORDS,
  ...SIZE_WORDS,
  "marinad",
  "marinda",
  "marinada",
  "marinado",
]);

function titleWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function offMenuWords(text: string, lines: SpokenLine[], families: Family[]): string[] {
  const covered = new Set<string>();
  for (const line of lines) {
    for (const token of words(`${line.nombre} ${line.familyKey} ${line.marca ?? ""}`)) covered.add(token);
  }
  const hits: string[] = [];
  for (const clause of norm(text).split(/\s+y\s+|,\s*/)) {
    if (rejectsMarinada(clause)) continue;
    const tokens = clause
      .split(" ")
      .map(canon)
      .filter((token) => token.length >= 4 && !OFF_MENU_NOISE.has(token));
    if (!tokens.length) continue;
    const onLine = tokens.some((token) =>
      [...covered].some((known) => known === token || known.includes(token) || token.includes(known) || closeEnough(known, token)),
    );
    const onMenu = families.some((family) =>
      family.nameTokens.some((token) => tokens.some((said) => token === said || token.includes(said) || said.includes(token) || closeEnough(token, said))),
    );
    if (!onLine && !onMenu) hits.push(titleWord(tokens[0]));
  }
  return [...new Set(hits)];
}

function refusedCuts(text: string, families: Family[], lines: SpokenLine[]): string[] {
  if (!rejectsMarinada(text)) return [];
  const names: string[] = [];
  const said = norm(text);
  for (const family of families) {
    if (!/marinad/.test(norm(family.key))) continue;
    const head = family.nameTokens.filter((token) => token !== "marinad");
    if (!head.length || !head.every((token) => said.includes(token))) continue;
    const taken = lines.some((line) => {
      const name = norm(line.nombre);
      return head.every((token) => name.includes(token)) && !/marinad/.test(name);
    });
    if (!taken) names.push(head.map(titleWord).join(" "));
  }
  return [...new Set(names)];
}

function noticeFor(text: string, lines: SpokenLine[], families: Family[]): string | null {
  const parts: string[] = [];
  const off = offMenuWords(text, lines, families);
  const refused = refusedCuts(text, families, lines);
  if (off.length) parts.push(`🛍️ ${off.map((name) => `*${name}*`).join(" y ")} no lo manejamos.`);
  if (refused.length) parts.push(`🥩 ${refused.map((name) => `*${name}*`).join(" y ")} sin marinar no la manejamos.`);
  return parts.length ? parts.join(" ") : null;
}

type MenuPending = {
  itemKey: string;
  slots: string[];
  question: string;
  count: number;
  mode: "ask" | "options";
  choices?: string[];
};

function menuChoiceList(question: string): { title: string; emoji: string; choices: string[] } {
  if (/marca/i.test(question)) {
    return {
      title: "¿De qué marca?",
      emoji: "🥤",
      choices: ["Pepsi", "Seven", "Coca", "Mirinda", "Manzana", "El que sea"],
    };
  }
  if (/chica/i.test(question) && /grande/i.test(question)) {
    return { title: "¿Chica o grande?", emoji: "🍔", choices: ["Chica", "Grande", "El que sea"] };
  }
  return { title: "¿Cuál va?", emoji: "🍽️", choices: ["El que sea"] };
}

function messageEngagesOrder(message: string): boolean {
  const text = norm(message);
  if (!text) return false;
  if (sizeIn(text)) return true;
  if (BRANDS.some((brand) => text.includes(brand))) return true;
  return text.split(" ").some((word) => word.length >= 4 && !FILLER.has(word) && !isSizeWord(word) && word !== "cual" && word !== "nada");
}

function applyMenuWaiver(items: CatalogSpeechItem[], question: string): CatalogSpeechItem[] {
  const next = items.map((item) => ({ ...item }));
  if (/marca/i.test(question)) {
    const drink = next.find((item) => norm(item.nombre_producto) === "refresco" && !item.marca);
    if (drink) drink.marca = "La que sea";
    return next;
  }
  const open = next.find((item) => !sizesIn(item.nombre_producto).length);
  if (open) open.notas = "la que sea";
  return next;
}

function applyMenuChoice(items: CatalogSpeechItem[], choice: string, question: string): CatalogSpeechItem[] {
  if (/el que sea|la que sea/i.test(choice)) return applyMenuWaiver(items, question);
  const next = items.map((item) => ({ ...item }));
  if (/marca/i.test(question)) {
    const drink = next.find((item) => norm(item.nombre_producto) === "refresco" && !item.marca);
    if (drink) drink.marca = choice === "Manzana" ? "Manzana" : choice;
    return next;
  }
  return next;
}

/**
 * En menú fijo no se repite la misma pregunta: a la segunda van opciones
 * numeradas y, si tampoco contestan, queda «el que sea».
 */
export function advanceMenuAsk(params: {
  items: CatalogSpeechItem[];
  question: string | null;
  reply: string | null;
  message: string;
  pending: MenuPending | null;
}): { items: CatalogSpeechItem[]; question: string | null; reply: string | null; pendingAsk: MenuPending | null } {
  const pending = params.pending;
  let items = params.items.map((item) => ({ ...item }));
  let question = params.question;
  if (pending?.mode === "options" && pending.choices?.length) {
    const text = norm(params.message);
    let picked = -1;
    if (/^(el|la) que sea|cualquiera|me da igual$/.test(text) || /\b(el|la) que sea\b/.test(text)) {
      picked = pending.choices.findIndex((choice) => /el que sea|la que sea/i.test(choice));
    } else if (/^\d+$/.test(text)) {
      const number = Number(text);
      if (number >= 1 && number <= pending.choices.length) picked = number - 1;
    }
    if (picked >= 0) {
      items = applyMenuChoice(items, pending.choices[picked], pending.question);
      question = null;
    }
  }
  if (!question) {
    const reply = params.reply && params.question && params.reply.includes(params.question)
      ? params.reply.replace(params.question, "").trim() || null
      : params.reply;
    return { items, question: null, reply, pendingAsk: null };
  }
  const same = Boolean(pending && norm(pending.question) === norm(question));
  if (same && pending && !messageEngagesOrder(params.message)) {
    if (pending.mode !== "options") {
      const choice = menuChoiceList(question);
      const lines = [
        `${choice.emoji} *${choice.title}*`,
        ...choice.choices.map((label, index) => `*${index + 1})* ${label}`),
        "_Contesta con el número._",
      ];
      const nextQuestion = lines.join("\n\n");
      const reply = params.reply?.includes(question) ? params.reply.replace(question, nextQuestion) : nextQuestion;
      return {
        items,
        question: nextQuestion,
        reply,
        pendingAsk: {
          itemKey: "menu",
          slots: [],
          question: nextQuestion,
          count: pending.count + 1,
          mode: "options",
          choices: choice.choices,
        },
      };
    }
    items = applyMenuWaiver(items, question);
    const reply = params.reply?.includes(question) ? params.reply.replace(question, "").trim() || null : params.reply;
    return { items, question: null, reply, pendingAsk: null };
  }
  return {
    items,
    question,
    reply: params.reply,
    pendingAsk: { itemKey: "menu", slots: [], question, count: 1, mode: "ask" },
  };
}
