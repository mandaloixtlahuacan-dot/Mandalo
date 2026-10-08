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
type Gap = "tamano" | "cantidad" | "marca";

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
]);

const SIZE_WORDS = ["chica", "chico", "mediana", "mediano", "grande", "sencilla", "sencillo", "doble", "triple"];
const BRANDS = ["pepsi", "coca", "seven", "sprite", "mirinda", "manzana"];
const HEADS = new Set(["hamburguesa", "dogo", "hotdog", "refresco"]);

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
  if (word === "hamburguesas") return "hamburguesa";
  if (word === "hawaianas") return "hawaiana";
  if (word === "cubanas") return "cubana";
  if (word === "hotdogs" || word === "hotdog" || word === "dogos" || word === "dogo") return "dogo";
  if (word === "refrescos") return "refresco";
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
  const found: string[] = norm(name).match(/\b(chica|chico|grande|mediana|mediano|sencilla|sencillo|doble|triple)\b/g) ?? [];
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
  const kiloYMedio = before.match(/(?:^|\s)(\d{1,2}|un|una|uno)\s*(?:kilos?|kg)\s+y\s+medio\s*(?:de\s*)?$/);
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
  const weighed = before.match(/(?:^|\s)(\d{1,2}(?:[.,]\d+)?|un|una|uno)\s*(?:kilos?|kg)\s*(?:de\s*)?$/);
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
    { kind: "hamburguesa", re: /\bhamburguesas?\b/g },
    { kind: "dogo", re: /\b(?:hot\s*dogs?|hotdogs?|dogos?|dogo)\b/g },
    { kind: "refresco", re: /\brefrescos?\b/g },
    { kind: "brand", re: /\b(pepsi|coca|seven|sprite|mirinda|manzanitas?|manzana)\b/g },
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
      fillerBetween(text.slice(prev.end, hit.index)) &&
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
  if (span.kind === "refresco" && (family.nameTokens.includes("hamburguesa") || family.nameTokens.includes("dogo"))) score -= 8;
  const said = norm(span.text);
  if (/\bclasicos?\b/.test(said) && /\bclasico\b/.test(family.key)) score += 1;
  if (/\bclasicas?\b/.test(said) && /\bclasica\b/.test(family.key)) score += 1;
  // «bistec de puerco marinada» también contiene «bistec de puerco». El corte
  // más corto no se queda con la frase si sobra una palabra de otro producto.
  const allowed = new Set([...family.distinct, ...family.nameTokens, ...BRANDS]);
  const parts = [...family.distinct, ...family.nameTokens];
  const extras = [...tokens].filter((token) => {
    if (allowed.has(token) || SIZE_WORDS.includes(token)) return false;
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
  if (/\b(hamburguesas|dogos|hotdogs|hot\s+dogs|refrescos|manzanitas)\b/.test(said)) return true;
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
  const match = norm(text).match(/\b(chica|chico|grande|mediana|mediano|sencilla|sencillo|doble|triple)\b/);
  return match?.[1] ?? null;
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

function sizeFollowUp(base: CatalogSpeechItem[], text: string, families: Family[]): SpokenLine | null {
  const size = sizeIn(text);
  if (!size) return null;
  if (spansOf(text).some((span) => span.kind != null)) return null;
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
  return lineFromSpan({ kind: null, text: `${family.key} ${size}`, qty: typeof qty === "number" ? qty : null }, families, text);
}

function looseScore(family: Family, spanText: string, families: Family[]): number {
  if (isBrandListDrink(family)) return 0;
  if (/marinad/.test(family.key) && rejectsMarinada(spanText)) return 0;
  if (isHeadFamily(family)) {
    const lead = family.distinct.slice().sort((a, b) => b.length - a.length)[0];
    const spoken = words(spanText).filter((token) => !SIZE_WORDS.includes(token));
    if (!lead || lead.length < 6 || !spoken.includes(lead)) return 0;
    const owners = families.filter((candidate) => candidate.distinct.includes(lead));
    if (owners.length !== 1) return 0;
    const extras = spoken.filter((token) => token !== lead && !family.distinct.includes(token) && !family.nameTokens.includes(token));
    if (extras.length) return 0;
    return 4;
  }
  const rawSpoken = words(spanText).filter((token) => !SIZE_WORDS.includes(token));
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

function lineFromSpan(
  span: { kind: AnchorKind | null; text: string; qty: number | null; unidad?: string | null; presentacion?: string | null },
  catalog: Family[],
  fullText = "",
): SpokenLine | null {
  const pool = fullText && rejectsMarinada(fullText) ? catalog.filter((family) => !/marinad/.test(family.key)) : catalog;
  const ranked = pool
    .map((family) => {
      const strict = scoreFamily(family, span);
      return { family, score: strict > 0 ? strict : looseScore(family, span.text, pool) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  const family = ranked[0].family;
  const spokenSize = sizeIn(span.text);
  const wantedSize = spokenSize === "chico" ? "chica" : spokenSize === "mediano" ? "mediana" : spokenSize;
  const sizedRow = wantedSize
    ? family.rows.find((row) => sizesIn(row.nombreProducto).includes(wantedSize) || sizesIn(row.nombreProducto).includes(spokenSize ?? ""))
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
  const single = family.rows.length === 1 ? family.rows[0].nombreProducto : family.unsizedName;
  return {
    familyKey: brandList ? "refresco" : family.key,
    nombre: sizedRow?.nombreProducto ?? (needsSize ? family.unsizedName : brandList ? "Refresco" : single),
    marca: brand,
    cantidad,
    unidad: span.unidad ?? null,
    presentacion: span.presentacion ?? null,
    gaps,
    sizeAsk: family.sizes.join(" o "),
    label: brandList ? "Refresco" : family.unsizedName,
    distinct: brandList ? [] : family.distinct,
    nameTokens: brandList ? ["refresco"] : family.nameTokens,
  };
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

function questionFor(lines: SpokenLine[], itemCount: number): string | null {
  const pending = lines.filter((line) => line.gaps.length);
  if (!pending.length) return null;
  return pending
    .map((line) => {
      const size = line.gaps.includes("tamano");
      const brand = line.gaps.includes("marca");
      const qty = line.gaps.includes("cantidad");
      const who = itemCount > 1 ? `${line.label}, ` : "";
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

export function applyCatalogSpeech(params: {
  base: CatalogSpeechItem[];
  userMessage: string;
  catalog: CatalogPriceRow[];
}): CatalogSpeechResult {
  const base = params.base.map((item) => ({ ...item }));
  const text = norm(stripBotDecorations(params.userMessage));
  const families = familiesOf(params.catalog);
  if (!text || !families.length) return { applied: false, missing: false, items: base, reply: null, question: null, aside: null };

  const fromAnchors = spansOf(text, families)
    .map((span) => lineFromSpan(span, families, text))
    .filter((line): line is SpokenLine => line != null);
  const spoken = dropDrinkIntroducers(
    fromAnchors.length ? fromAnchors : [sizeFollowUp(base, text, families)].filter((line): line is SpokenLine => line != null),
  );
  const aside = noticeFor(text, spoken, families);
  if (!spoken.length && !aside) return { applied: false, missing: false, items: base, reply: null, question: null, aside: null };
  if (!spoken.length) return { applied: true, missing: true, items: base, reply: aside, question: aside, aside };

  const items = base;
  for (const line of spoken) {
    const index = items.findIndex((item) => sameFamily(item, line));
    const previous = index >= 0 ? items[index] : null;
    const cantidad = line.cantidad ?? (typeof previous?.cantidad === "number" ? previous.cantidad : null);
    if (line.cantidad == null && cantidad != null) {
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
    if (line.presentacion) next.presentacion = line.presentacion;
    else if (line.unidad) delete next.presentacion;
    if (cantidad == null) delete next.cantidad;
    if (line.gaps.includes("tamano") && SIZE_WORDS.includes(norm(String(next.presentacion ?? "")))) {
      delete next.presentacion;
    }
    if (index >= 0) items[index] = next;
    else items.push(next);
  }

  const missing = spoken.some((line) => line.gaps.length);
  const hole = questionFor(spoken, items.length);
  const question = [hole, aside].filter(Boolean).join(" ") || null;
  const reply = `🛒 *Anoto:*\n\n${joinBlocks(items.map(itemLine))}${question ? `\n\n${question}` : ""}`;
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
    for (const token of words(`${line.nombre} ${line.familyKey}`)) covered.add(token);
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
