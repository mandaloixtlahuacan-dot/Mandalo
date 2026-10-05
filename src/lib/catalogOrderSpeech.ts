/**
 * Lo que el cliente dijo de un menú fijo, sin completar huecos.
 *
 * La IA a veces anota "Chica" y "1 pieza" y en el mismo mensaje pregunta
 * tamaño y cantidad. Aquí el texto del cliente gana: no se guarda un tamaño
 * ni una cantidad que no dijo, y un mensaje que suma Pepsi o un dogo se
 * agrega al pedido aunque la IA solo haya repetido la hamburguesa.
 */

import type { CatalogPriceRow } from "@/lib/catalogQuantities";

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
]);

const SIZE_WORDS = ["chica", "chico", "mediana", "mediano", "grande"];
const BRANDS = ["pepsi", "coca", "seven", "sprite", "mirinda", "manzana"];
const HEADS = new Set(["hamburguesa", "dogo", "hotdog", "refresco"]);

type Family = {
  key: string;
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
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canon(word: string): string {
  if (word === "hamburguesas") return "hamburguesa";
  if (word === "hawaianas") return "hawaiana";
  if (word === "cubanas") return "cubana";
  if (word === "hotdogs" || word === "hotdog" || word === "dogos" || word === "dogo") return "dogo";
  if (word === "refrescos") return "refresco";
  if (word === "manzanitas" || word === "manzanita") return "manzana";
  if (word === "clasicos" || word === "clasicas" || word === "clasica") return "clasico";
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

function words(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((word) => qtyWord(word) == null)
    .map(canon)
    .filter((word) => word.length >= 3 && !FILLER.has(word));
}

function stripSize(value: string): string {
  return norm(value)
    .replace(/\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleBrand(brand: string): string {
  if (brand === "coca") return "Coca";
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function sizesIn(name: string): string[] {
  const found: string[] = norm(name).match(/\b(chica|chico|grande|mediana|mediano)\b/g) ?? [];
  return found.filter((word, index) => found.indexOf(word) === index);
}

function unsizedLabel(name: string): string {
  return name
    .replace(/\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano)\b/gi, " ")
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
    const nameTokens = words(key);
    const distinct = nameTokens.filter((token) => !HEADS.has(token));
    const sizes = SIZE_WORDS.filter((size) => rows.some((row) => sizesIn(row.nombreProducto).includes(size)));
    const sample = rows.slice().sort((a, b) => a.nombreProducto.length - b.nombreProducto.length)[0];
    return {
      key,
      rows,
      nameTokens,
      distinct,
      unsizedName: unsizedLabel(sample?.nombreProducto ?? key),
      sizes,
    };
  });
}

function qtyAttached(text: string, index: number): number | null {
  const before = norm(text.slice(0, index)).split(" ").filter(Boolean);
  for (let i = before.length - 1; i >= 0 && i >= before.length - 6; i--) {
    const word = before[i];
    const qty = qtyWord(word);
    if (qty != null) return qty;
    if (FILLER.has(word)) continue;
    break;
  }
  return null;
}

function qtyIn(text: string): number | null {
  const match = norm(text).match(/\b(un|una|uno|unos|unas|otro|otra|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d{1,2})\b/);
  return match ? qtyWord(match[1]) : null;
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
  const target = phrase.replace(/\s+/g, "");
  if (target.length < 5) return [];
  const tokens = wordSpans(text);
  const hits: Array<{ index: number; end: number }> = [];
  const widest = Math.min(4, tokens.length);
  for (let size = 1; size <= widest; size++) {
    for (let i = 0; i + size <= tokens.length; i++) {
      const slice = tokens.slice(i, i + size);
      if (slice.map((token) => token.word).join("") !== target) continue;
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
    if (isHeadFamily(family)) continue;
    const phrases = [family.key];
    const longest = family.distinct.slice().sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 6 && longest !== family.key.replace(/\s+/g, "")) phrases.push(longest);
    for (const phrase of phrases) hits.push(...phraseHits(text, phrase));
  }
  return hits;
}

function spansOf(text: string, families: Family[] = []): Array<{ kind: AnchorKind | null; text: string; qty: number | null }> {
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
    if (
      hit.kind === "brand" &&
      prev &&
      (prev.kind === "refresco" || prev.kind === "brand") &&
      fillerBetween(text.slice(prev.end, hit.index))
    ) {
      continue;
    }
    if (prev && hit.index < prev.end) continue;
    kept.push(hit);
  }
  if (!kept.length) return [{ kind: null, text, qty: qtyIn(text) }];

  return kept.map((hit, index) => {
    const end = index + 1 < kept.length ? kept[index + 1].index : text.length;
    const kind: AnchorKind | null = hit.kind === "brand" ? "refresco" : hit.kind;
    return { kind, text: text.slice(hit.index, end), qty: qtyAttached(text, hit.index) };
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
  const compactSpan = norm(span.text).replace(/[^a-z0-9]/g, "");
  const compactKey = family.key.replace(/[^a-z0-9]/g, "");
  const compactHit = compactKey.length >= 5 && compactSpan.includes(compactKey);
  const brandList = isBrandListDrink(family);

  if (brandList) {
    const mentioned = BRANDS.some((brand) => tokens.has(brand));
    if (!(span.kind === "refresco" || mentioned)) return 0;
    return mentioned ? 3 : 1;
  }

  if (family.distinct.length) {
    const tokensHit = family.distinct.every((token) => tokens.has(token));
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
  return score;
}

function brandIn(text: string): string | null {
  const tokens = norm(text).split(" ").filter(Boolean).map(canon);
  const found = BRANDS.find((brand) => tokens.includes(brand));
  return found ? titleBrand(found) : null;
}

function uncountedPlural(span: { text: string; qty: number | null }): boolean {
  if (span.qty != null) return false;
  return /\b(hamburguesas|dogos|hotdogs|hot\s+dogs|refrescos|manzanitas)\b/.test(norm(span.text));
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
  const match = norm(text).match(/\b(chica|chico|grande|mediana|mediano)\b/);
  return match?.[1] ?? null;
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
  return lineFromSpan({ kind: null, text: `${family.key} ${size}`, qty: typeof qty === "number" ? qty : null }, families);
}

function lineFromSpan(span: { kind: AnchorKind | null; text: string; qty: number | null }, catalog: Family[]): SpokenLine | null {
  const ranked = catalog
    .map((family) => ({ family, score: scoreFamily(family, span) }))
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
  if (typeof item.cantidad === "number" && item.cantidad > 0) return `• ${name} — ${pieceLabel(item.cantidad)}`;
  return `• ${name}`;
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
    .join(" ");
}

export function applyCatalogSpeech(params: {
  base: CatalogSpeechItem[];
  userMessage: string;
  catalog: CatalogPriceRow[];
}): CatalogSpeechResult {
  const base = params.base.map((item) => ({ ...item }));
  const text = norm(params.userMessage);
  const families = familiesOf(params.catalog);
  if (!text || !families.length) return { applied: false, missing: false, items: base, reply: null, question: null };

  const fromAnchors = spansOf(text, families)
    .map((span) => lineFromSpan(span, families))
    .filter((line): line is SpokenLine => line != null);
  const spoken = dropDrinkIntroducers(
    fromAnchors.length ? fromAnchors : [sizeFollowUp(base, text, families)].filter((line): line is SpokenLine => line != null),
  );
  if (!spoken.length) return { applied: false, missing: false, items: base, reply: null, question: null };

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
    const next: CatalogSpeechItem = {
      ...(previous ?? {}),
      nombre_producto: line.nombre,
      cantidad,
      ...(line.marca ? { marca: line.marca } : {}),
    };
    if (cantidad == null) delete next.cantidad;
    if (line.gaps.includes("tamano") && SIZE_WORDS.includes(norm(String(next.presentacion ?? "")))) {
      delete next.presentacion;
    }
    if (index >= 0) items[index] = next;
    else items.push(next);
  }

  const missing = spoken.some((line) => line.gaps.length);
  const question = questionFor(spoken, items.length);
  const reply = `Anoto:\n${items.map(itemLine).join("\n")}${question ? `\n\n${question}` : ""}`;
  return { applied: true, missing, items, reply, question };
}
