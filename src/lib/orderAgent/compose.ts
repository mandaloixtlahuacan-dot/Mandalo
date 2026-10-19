/**
 * Arma el pedido directo contra el catálogo de la tienda.
 * Una cláusula se anota, se pregunta o se dice que no la tienen.
 * No inventa productos ni deja una línea en silencio.
 */
import { foldAgent, genericDogoProduct, isGenericDogoText, searchAgentProducts } from "@/lib/orderAgent/catalog";
import { isAffirmativeChatter, isCancelIntent } from "@/lib/messages";
import { isVagueListaQuery, listaRankTokens, listaWordHit, normalizeMeasureWords, synonymForms } from "@/lib/storeProductSearch";
import {
  asideNote,
  catalogAsk,
  clauseMisspelled,
  conjunctionPhrases,
  contentTokens,
  filterAskedType,
  foldCatalogName,
  isPackProduct,
  listClauses,
  normalizedAsk,
  packInName,
  orderClauses,
  presentationFromName,
  productTypeTokens,
  sauceTypeAlias,
  spokenMeasure,
  spokenPackageSize,
  variantFromMessage,
} from "@/lib/orderAgent/match";
import type { AgentLine, AgentProduct, AgentStore, AgentUnit } from "@/lib/orderAgent/types";

export type ClauseAdd = {
  kind: "add";
  clause: string;
  product: AgentProduct;
  qty: number;
  unit: AgentUnit;
  variant: string | null;
};

export type ClauseAsk = {
  kind: "ask";
  clause: string;
  query: string;
  products: AgentProduct[];
  qty: number | null;
  unit: AgentUnit | null;
  marinade: boolean;
};

export type ClauseMissing = { kind: "missing"; clause: string; label: string };

export type ClauseDecision = ClauseAdd | ClauseAsk | ClauseMissing | { kind: "skip"; clause: string };

const SIZE_WORD = /\b(chica|chico|grande|mediana|medianas|medianos)\b/;

function cleanClause(clause: string): string {
  return clause.replace(/\s+/g, " ").trim();
}

function countIn(clause: string): number {
  const text = foldAgent(clause).replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|l|lt|lts|litros?|g|gr|gramos?|kg|kilos?)\b/g, " ");
  const digit = text.match(/\b(\d+(?:[.,]\d+)?)\b/);
  if (digit) {
    const qty = Number(digit[1].replace(",", "."));
    if (qty > 0 && qty <= 40) return qty;
  }
  if (/\bmedio\b|\bmedia\b/.test(text)) return 0.5;
  if (/\bdos\b/.test(text)) return 2;
  if (/\btres\b/.test(text)) return 3;
  if (/\bcuatro\b/.test(text)) return 4;
  if (/\bcinco\b/.test(text)) return 5;
  return 1;
}

function gramsOf(clause: string): number | null {
  const match = foldAgent(clause).match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gr|gramos?)\b/);
  if (!match) return null;
  const qty = Number(match[1].replace(",", "."));
  return qty > 0 ? qty : null;
}

function saidPack(clause: string): boolean {
  if (!/\b(cajas?|paquetes?)\b/.test(foldAgent(clause))) return false;
  // «caja» sola es el producto. «caja de nito» sí pide la caja.
  const rest = clauseTokens(clause).filter((token) => !/^(?:cajas?|paquetes?)$/.test(token));
  return rest.length > 0;
}

function saidSize(clause: string): "chica" | "grande" | null {
  const text = foldAgent(clause);
  if (/\bgrandes?\b/.test(text)) return "grande";
  if (/\bchicas?\b|\bchicos?\b/.test(text)) return "chica";
  return null;
}

function stemOf(name: string): string {
  return foldAgent(name)
    .replace(SIZE_WORD, " ")
    .replace(/\bmarinad[oa]s?\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|l|lt|lts|g|gr|kg|paq|pz)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sizeWordOf(name: string): "chica" | "grande" | null {
  const text = foldAgent(name);
  if (/\bgrande\b/.test(text)) return "grande";
  if (/\bchica\b|\bchico\b/.test(text)) return "chica";
  return null;
}

function productBlob(product: AgentProduct): string {
  return foldAgent([product.name, product.brand ?? "", product.presentation ?? "", ...(product.alias ?? [])].join(" "));
}

function prefixLimit(token: string): number {
  return token.length >= 6 ? 3 : 2;
}

function wordMatches(word: string, token: string): boolean {
  return listaWordHit(word, token);
}

function categoryOnlyClause(clause: string): boolean {
  const tokens = clauseTokens(clause);
  return tokens.length > 0 && tokens.every((token) => CATEGORY_TOKENS.has(token));
}

function tokenInBlob(blob: string, token: string): boolean {
  const forms = new Set<string>([token]);
  for (const form of listaRankTokens(token)) forms.add(form);
  const words = blob.split(" ").filter(Boolean);
  for (const form of forms) {
    if (words.some((word) => wordMatches(word, form))) return true;
  }
  return false;
}

/** «Coca Cola» se pide «coca» o «cocas». La segunda palabra no es otro producto. */
const BRAND_PAIR: string[][] = [["coca", "cocas", "cola", "cocacola"]];

function brandSibling(token: string): string | null {
  const stem = token.endsWith("s") ? token.slice(0, -1) : token;
  for (const group of BRAND_PAIR) {
    if (!group.includes(token) && !group.includes(stem)) continue;
    return group.find((form) => form !== token && form !== stem) ?? null;
  }
  return null;
}

function clauseTokens(clause: string): string[] {
  return productTypeTokens(clause).filter((token) => !SIZE_WORD.test(token));
}

function coverage(product: AgentProduct, tokens: string[]): number {
  if (!tokens.length) return 0;
  const blob = productBlob(product);
  return tokens.filter((token) => tokenInBlob(blob, token)).length;
}

function extrasOf(product: AgentProduct, clause: string): string[] {
  const text = foldAgent(clause);
  return contentTokens(product.name).filter((token) => {
    if (SIZE_WORD.test(token)) return false;
    if (/^\d/.test(token)) return false;
    return !tokenInBlob(text, token);
  });
}

function wantsKilo(clause: string): boolean {
  return /\b(kilo|kilos|kg)\b/.test(foldAgent(clause));
}

function hasKilo(product: AgentProduct): boolean {
  return /\b(kg|kilos?)\b/.test(productBlob(product));
}

function matchesPackage(product: AgentProduct, wanted: string | null): boolean {
  if (!wanted) return true;
  const blob = foldAgent(normalizeMeasureWords(`${product.name} ${product.presentation ?? ""}`));
  if (wanted === "250ml") return /\b(?:250ml|8oz|cuartos?)\b/.test(blob);
  if (wanted === "500ml") return /\b500ml\b/.test(blob) || /\bmedio litro\b/.test(blob);
  const key = presentationFromName(`${product.name} ${product.presentation ?? ""}`)?.key ?? "";
  if (!key) return false;
  if (wanted.endsWith("l")) {
    const n = wanted.slice(0, -1);
    return key === wanted || key === `${Number(n) * 1000}ml`;
  }
  return key === wanted;
}

function householdSize(clause: string): boolean {
  const folded = foldAgent(normalizeMeasureWords(clause));
  if (/\b(?:jamon|kilo|kilos|kg|gramo|gramos)\b/.test(folded)) return false;
  return /\b(?:cuartos?|8oz|250ml|500ml)\b/.test(folded) || (/\bmedio\b/.test(folded) && /\blitros?\b/.test(folded));
}

/** Nombre completo de un solo producto: se anota. Si ese nombre es el principio de otro, se pregunta. */
function exactNameDecision(clause: string, pool: AgentProduct[], store: AgentStore): ClauseDecision | null {
  const full = foldCatalogName(clause);
  const stripped = catalogAsk(clause);
  const available = pool.filter((product) => product.available);
  const said = full.length >= 3 && available.some((product) => foldCatalogName(product.name) === full) ? full : stripped;
  if (!said || said.length < 3) return null;
  const same = available.filter((product) => foldCatalogName(product.name) === said);
  if (!same.length) return null;
  const longer = available.filter((product) => foldCatalogName(product.name).startsWith(`${said} `) && !same.some((row) => row.id === product.id));
  if (longer.length) {
    const options = [...same, ...longer].slice(0, 5);
    const measure = lineQty(clause, options[0], store);
    return {
      kind: "ask",
      clause,
      query: said,
      products: options,
      qty: measure.qty,
      unit: measure.unit,
      marinade: false,
    };
  }
  if (same.length > 1) {
    const measure = lineQty(clause, same[0], store);
    return {
      kind: "ask",
      clause,
      query: said,
      products: same.slice(0, 5),
      qty: measure.qty,
      unit: measure.unit,
      marinade: false,
    };
  }
  // «aguacate» es el nombre exacto y también está en muchos productos. Se pregunta.
  if (store.hasProductList && !said.includes(" ")) {
    const cousins = available.filter((product) => product.id !== same[0].id && foldAgent(product.name).split(" ").includes(said));
    if (cousins.length >= 2) {
      const measure = lineQty(clause, same[0], store);
      return {
        kind: "ask",
        clause,
        query: said,
        products: [same[0], ...cousins].slice(0, 5),
        qty: measure.qty,
        unit: measure.unit,
        marinade: false,
      };
    }
  }
  const product = same[0];
  const qty = lineQty(clause, product, store);
  return { kind: "add", clause, product, qty: qty.qty, unit: qty.unit, variant: null };
}

function lineQty(clause: string, product: AgentProduct, store: AgentStore): { qty: number; unit: AgentUnit } {
  // «7 Up 1.5 Lt» y «ET 4» traen el número en el nombre. No es la cantidad.
  if (store.category === "abarrotes" && foldCatalogName(clause) === foldCatalogName(product.name)) {
    return { qty: 1, unit: "pz" };
  }
  const grams = gramsOf(clause);
  if (grams != null && (store.category === "carniceria" || product.unit === "kg")) {
    return { qty: grams, unit: "g" };
  }
  const spoken = spokenMeasure(clause, product.name);
  if (spoken && (spoken.unit === "kg" || spoken.unit === "pesos" || store.category === "carniceria" || product.unit === spoken.unit)) {
    return spoken;
  }
  if (store.category === "carniceria" && product.unit === "kg") {
    return { qty: countIn(clause) === 1 ? 1 : countIn(clause), unit: "kg" };
  }
  const qty = countIn(clause);
  return { qty: Number.isInteger(qty) ? qty : 1, unit: "pz" };
}

function labelOf(clause: string): string {
  const text = normalizedAsk(clause)
    .replace(/^(?:latas?|latitas?|cajitas?|cajas?|paquetes?|paquetitos?|bolsas?|bolsitas?|piezas?|botellas?)\s+de\s+/, "")
    .trim();
  const name = text || clauseTokens(clause).slice(0, 4).join(" ");
  if (wantsKilo(clause) && name) return `${name} por kilo`;
  return name || cleanClause(clause);
}

function unexplainedWords(product: AgentProduct, clause: string): string[] {
  const text = foldAgent(clause);
  return foldAgent(product.name).split(" ").filter((word) => {
    if (!word || word.length < 2) return false;
    if (/^\d+(?:[.,]\d+)?(?:ml|l|lt|lts|g|gr|kg|pz|paq)?$/.test(word)) return false;
    if (/^(?:ml|lt|lts|gr|kg|pz|paq|de|del|la|el|las|los)$/.test(word)) return false;
    if (/^marinad/.test(word)) return false;
    if (tokenInBlob(text, word)) return false;
    const sibling = brandSibling(word);
    return sibling ? !tokenInBlob(text, sibling) : true;
  });
}

function capOptions(products: AgentProduct[]): AgentProduct[] {
  const head = products.slice(0, 5);
  if (head.some((product) => isPackProduct(product))) return head;
  const pack = products.find((product) => isPackProduct(product));
  if (!pack) return head;
  return [...head.slice(0, 4), pack];
}

function uniqueProducts(products: AgentProduct[]): AgentProduct[] {
  const seen = new Set<string>();
  const out: AgentProduct[] = [];
  for (const product of products) {
    const key = foldAgent([product.name, product.brand ?? "", product.presentation ?? ""].join(" "));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(product);
  }
  return out;
}

function typeFilter(clause: string, products: AgentProduct[]): AgentProduct[] {
  const text = foldAgent(clause);
  const hints = ["pollo", "res", "gajo", "francesa", "cuban", "hawaian", "camaron", "arrachera", "clasic", "puerco", "pastor"];
  const wanted = hints.filter((hint) => new RegExp(`\\b${hint}`).test(text));
  if (!wanted.length) return products;
  const filtered = products.filter((product) => {
    const name = foldAgent(product.name);
    return wanted.every((hint) => name.includes(hint));
  });
  return filtered.length ? filtered : products;
}

const FLAVOR_WORD = /\b(cherry|zero|light|diet|sin azucar)\b/;

function falseFriend(clause: string, product: AgentProduct): boolean {
  const words = foldAgent(product.name).split(" ").filter(Boolean);
  return clauseTokens(clause).some((token) =>
    words.some((word) => word !== token && word.startsWith(token) && word.length - token.length > prefixLimit(token)),
  );
}

function withoutFlavors(clause: string, products: AgentProduct[]): AgentProduct[] {
  if (products.length <= 1 || FLAVOR_WORD.test(foldAgent(clause))) return products;
  const plain = products.filter((product) => !FLAVOR_WORD.test(foldAgent(product.name)));
  return plain.length ? plain : products;
}

/** «chorizo» es el Chorizo, no el Chorizo Argentino. «nito» no se queda en Nito 62g. */
function preferBareName(products: AgentProduct[]): AgentProduct[] {
  const bare = products.filter((product) => {
    const name = foldAgent(product.name);
    return products.some((other) => {
      if (other.id === product.id) return false;
      const extra = foldAgent(other.name);
      if (!extra.startsWith(`${name} `)) return false;
      const rest = extra.slice(name.length).trim();
      if (/^marinad/.test(rest)) return false;
      if (/^(?:ch|chica|chico|grande)\b/.test(rest)) return false;
      return true;
    });
  });
  if (bare.length !== 1) return products;
  const name = foldAgent(bare[0].name);
  const unrelated = products.some((product) => {
    const extra = foldAgent(product.name);
    return extra !== name && !extra.startsWith(`${name} `);
  });
  return unrelated ? products : bare;
}

function pickStandardSize(clause: string, products: AgentProduct[]): AgentProduct | null {
  if (products.length < 2) return products[0] ?? null;
  const stems = new Set(products.map((product) => stemOf(product.name)));
  if (stems.size !== 1) return null;
  const sizes = products.map((product) => sizeWordOf(product.name));
  if (!sizes.every((size) => size === "chica" || size === "grande")) return null;
  const asked = saidSize(clause);
  if (asked) return products.find((product) => sizeWordOf(product.name) === asked) ?? null;
  const folded = foldAgent(clause);
  // «una hamburguesa» y la de res preguntan el tamaño. «de pollo» ya nombra el tipo y sigue en la chica.
  // «otra» también pregunta, no se asume.
  if (/\bres\b/.test(folded) || /\botr[oa]s?\b/.test(folded)) return null;
  if (!/\b(?:pollo|cuban\w*|hawaian\w*|camar[oó]n|arrachera|pastor|sencill\w*)\b/.test(folded)) return null;
  return products.find((product) => sizeWordOf(product.name) === "chica") ?? null;
}

function piecesFirst(products: AgentProduct[]): AgentProduct[] {
  const pieces = products.filter((product) => !packInName(product));
  const packs = products.filter((product) => packInName(product));
  if (!pieces.length || !packs.length) return products;
  return [...pieces, ...packs];
}

function hasFocusRank(product: AgentProduct, token: string): number {
  const forms = new Set<string>([token]);
  for (const form of listaRankTokens(token)) forms.add(form);
  const words = productBlob(product).split(" ").filter(Boolean);
  let best = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    for (const form of forms) {
      // «maria» no cuenta como «marias»: si no, el mole gana a las galletas.
      // «chinita» sí cuenta como «china»: el tronco no es un plural.
      if (form !== token && token.startsWith(form) && /^(?:s|es)$/.test(token.slice(form.length))) continue;
      if (word === form) best = Math.max(best, 2);
      else if (word === `${form}s` || form === `${word}s` || word === `${form}es` || form === `${word}es`) {
        // «chicles» es la misma familia que «Chicle …» al inicio del nombre.
        // Más adentro («Mole María») sigue siendo otra cosa.
        best = Math.max(best, index === 0 ? 2 : 1);
      } else if (Math.abs(word.length - form.length) <= 1 && word[0] === form[0] && listaWordHit(word, form)) best = Math.max(best, 1);
    }
  }
  return best;
}

function namedTokens(clause: string): string[] {
  return clauseTokens(clause).filter((token) => token.length >= 4);
}

function bestNamed(products: AgentProduct[], token: string): AgentProduct[] {
  const scored = products
    .map((product) => ({ product, rank: hasFocusRank(product, token) }))
    .filter((row) => row.rank > 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((row) => row.rank));
  return scored.filter((row) => row.rank === best).map((row) => row.product);
}

function anyNamed(products: AgentProduct[], token: string): AgentProduct[] {
  return products.filter((product) => hasFocusRank(product, token) > 0);
}

/** Palabras de categoría. No sustituyen al producto que el cliente nombró al final. */
const CATEGORY_TOKENS = new Set([
  "galleta", "galletas", "pan", "panes", "agua", "aguas", "leche", "leches",
  "jabon", "jabones", "refresco", "jugo", "papel", "tortilla", "tortillas",
  "carne", "huevo", "arroz", "frijol", "frijoles", "botella", "bolsa",
]);

/**
 * Se queda con el producto nombrado.
 * «galletas marías» usa marías, aunque el nombre no diga galleta.
 * «jabón zote» no se vuelve Savile, y «fuse morado» no se vuelve maíz morado:
 * una palabra que no está en ese producto no cambia a otro.
 */
function narrowToNamedProduct(clause: string, products: AgentProduct[]): AgentProduct[] | null {
  const tokens = namedTokens(clause);
  if (!tokens.length) return products;
  const specific = tokens.filter((token) => !CATEGORY_TOKENS.has(token));
  const wanted = specific.length ? specific : tokens;
  const groups = wanted.map((token) => ({ token, hits: bestNamed(products, token) }));
  const loose = wanted.map((token) => ({ token, hits: anyNamed(products, token) }));
  const looseScore = new Map<number, number>();
  for (const group of loose) {
    for (const product of group.hits) looseScore.set(product.id, (looseScore.get(product.id) ?? 0) + 1);
  }
  const looseMax = Math.max(0, ...looseScore.values());
  const exactScore = new Map<number, number>();
  for (const group of groups) {
    for (const product of group.hits) exactScore.set(product.id, (exactScore.get(product.id) ?? 0) + 1);
  }
  const exactMax = Math.max(0, ...exactScore.values());
  // «lubu babu»: Bubu Lubu cubre las dos, aunque «babu» no esté escrito igual.
  // «un nito» no: ahí la palabra exacta sigue ganando.
  if (looseMax >= 2 && looseMax > exactMax) {
    const both = products.filter((product) => looseScore.get(product.id) === looseMax);
    if (both.length) return both;
  }
  if (!groups[groups.length - 1]?.hits.length) return null;
  const known = groups.filter((group) => group.hits.length > 0);
  const score = new Map<number, number>();
  for (const group of known) {
    for (const product of group.hits) score.set(product.id, (score.get(product.id) ?? 0) + 1);
  }
  const max = Math.max(...score.values());
  let winners = products.filter((product) => score.get(product.id) === max);
  if (known.length > 1 && max < known.length) {
    const distinctive = [...known].sort((left, right) => {
      if (left.hits.length !== right.hits.length) return left.hits.length - right.hits.length;
      return wanted.indexOf(left.token) - wanted.indexOf(right.token);
    })[0];
    const ids = new Set(distinctive.hits.map((product) => product.id));
    const narrowed = winners.filter((product) => ids.has(product.id));
    if (narrowed.length) winners = narrowed;
  }
  return winners.length ? winners : null;
}

function sizeKeyOf(product: AgentProduct): string {
  const parsed = presentationFromName(`${product.name} ${product.presentation ?? ""}`);
  if (!parsed || parsed.pack) return parsed?.key ?? "";
  const raw = `${product.name} ${product.presentation ?? ""}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const ml = raw.match(/(\d+(?:[.,]\d+)?)\s*ml\b/);
  if (ml) return `${ml[1].replace(",", ".")}ml`;
  return parsed.key;
}

function offeringKey(product: AgentProduct): string {
  return foldAgent([product.name, product.brand ?? "", product.presentation ?? ""].join(" "));
}

function shortestName(products: AgentProduct[]): number {
  return Math.min(...products.map((product) => foldAgent(product.name).length));
}

function lowestId(products: AgentProduct[]): number {
  return Math.min(...products.map((product) => product.id));
}

/**
 * Presentación estándar de abarrotes, cuando el cliente no dijo tamaño ni caja.
 *
 * 1. Pieza, no caja. Caja, paquete, cj y multipack salen si hay pieza.
 * 2. Nombre base. Se queda el producto cuyas palabras, ya sin el tamaño,
 *    están en lo que el cliente dijo. Duo, funk, hotkis, cherry, retornable,
 *    la marca o el aroma son modificadores y no se eligen si no los nombró.
 * 3. Tamaño más común. Entre esos nombres base gana el tamaño que más veces
 *    aparece. Si empatan, gana el grupo con el nombre más corto; si siguen
 *    empatados, el id menor.
 * 4. Pregunta solo si en ese tamaño quedan varias opciones distintas
 *    (sabor, aroma, marca o variante). Si no hay nombre base, el mismo
 *    tamaño se calcula entre las que sí tienen modificador.
 * Una palabra de categoría (galleta, agua, pan) no cambia el producto.
 * Si en la búsqueda solo aparece la caja, se pregunta y no se anota.
 */
function standardPresentation(clause: string, products: AgentProduct[]): AgentProduct[] {
  const plain = products.filter((product) => unexplainedWords(product, clause).length === 0);
  const family = plain.length ? plain : products;
  const groups = new Map<string, AgentProduct[]>();
  for (const product of family) {
    const key = sizeKeyOf(product);
    const list = groups.get(key) ?? [];
    list.push(product);
    groups.set(key, list);
  }
  const [winners] = [...groups.values()].sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    const nameGap = shortestName(left) - shortestName(right);
    if (nameGap !== 0) return nameGap;
    return lowestId(left) - lowestId(right);
  });
  const sized = winners ?? family;
  if (!plain.length) return sized;
  const distinct = new Set(sized.map((product) => offeringKey(product)));
  if (distinct.size > 1) return sized;
  return [...sized].sort((left, right) => left.id - right.id).slice(0, 1);
}

function marinadePair(products: AgentProduct[]): { plain: AgentProduct; seasoned: AgentProduct } | null {
  const plain = products.filter((product) => !/\bmarinad/.test(foldAgent(product.name)));
  const seasoned = products.filter((product) => /\bmarinad/.test(foldAgent(product.name)));
  if (plain.length !== 1 || seasoned.length !== 1) return null;
  if (stemOf(plain[0].name) !== stemOf(seasoned[0].name)) return null;
  return { plain: plain[0], seasoned: seasoned[0] };
}

function customerSaidMarinade(clause: string): boolean {
  const text = foldAgent(clause);
  return /\bmarinad/.test(text) || /\b(normal|natural|sin marinar)\b/.test(text);
}

const MODIFIER_WORD = /^(?:funk|duo|hotkis|cherry|zero|light|diet|retornable|retornble|malteada|marinad[oa]s?)$/;

/** Caja, paquete o «15paq». «100pz» de una servilleta no es caja. */
function wholesalePack(product: AgentProduct): boolean {
  return /\b(cajas?|paquetes?|cj|paq)\b/.test(foldAgent(product.name));
}

function modifierVariant(product: AgentProduct, clause: string): boolean {
  const extra = unexplainedWords(product, clause);
  return extra.length > 0 && extra.every((word) => MODIFIER_WORD.test(word));
}

/** Una sola vocal distinta: «caeritos» es cueritos, no carritos. */
function vowelSlip(word: string, token: string): boolean {
  if (word.length !== token.length || !word || word[0] !== token[0]) return false;
  let diffs = 0;
  for (let index = 0; index < word.length; index += 1) {
    if (word[index] === token[index]) continue;
    if (!"aeiou".includes(word[index]) || !"aeiou".includes(token[index])) return false;
    diffs += 1;
  }
  return diffs === 1;
}

function preferVowelSlip(clause: string, products: AgentProduct[]): AgentProduct[] {
  const tokens = clauseTokens(clause).filter((token) => token.length >= 4);
  if (!tokens.length) return products;
  const tight = products.filter((product) => {
    const words = foldAgent(product.name).split(" ").filter(Boolean);
    return tokens.every((token) => words.some((word) => {
      if (word === token || word === `${token}s` || token === `${word}s` || word === `${token}es` || token === `${word}es`) return true;
      for (const form of synonymForms(token)) {
        if (form !== token && (word === form || word === `${form}s` || form === `${word}s`)) return true;
      }
      return vowelSlip(word, token);
    }));
  });
  return tight.length ? tight : products;
}

/** El cliente no escribió la palabra completa: hay falta o diminutivo. Se pregunta, no se anota. */
function spelledClose(clause: string, products: AgentProduct[]): AgentProduct[] | null {
  if (!products.length || !clauseMisspelled(clause, products)) return null;
  return closestOptions(clause, products);
}

function closestOptions(clause: string, products: AgentProduct[]): AgentProduct[] {
  const text = foldAgent(clause);
  let rows = products;
  // En este catálogo el papel Pétalo se llama «Hig Petalo», no «Papel Petalo».
  if (/\bpapel\b/.test(text) && /\bpetalo\b/.test(text) && !/\bservillet/.test(text)) {
    const hig = products.filter((product) => /\bhig\b/.test(foldAgent(product.name)));
    if (hig.length) rows = hig;
  }
  const ranked = searchAgentProducts(rows, clause, 5);
  return (ranked.length ? ranked : rows).slice(0, 5);
}

/**
 * Nombre exacto con una sola presentación: se anota.
 * «sanitas» no es exacto: existe «Sanitas 100 Toallas», así que se preguntan las dos.
 * Varias presentaciones (coca, zote, servilletas) se preguntan.
 * La pieza estándar que ya existía se queda: «un nito» es Nito 62g.
 */
function tokenWrittenWord(word: string, token: string): boolean {
  const forms = [token];
  for (const form of synonymForms(token)) {
    if (form !== token) forms.push(form);
  }
  return forms.some((form) => word === form || word === `${form}s` || form === `${word}s` || form === `${word}es` || word === `${form}es`);
}

/**
 * «para» en «jugo cosecha para» es «pura», no la preposición.
 * Si esa falta cabe en unos productos y en otros no, se quedan los que sí.
 * «jugo» no entra: es el tipo, y Jumex Bida sigue siendo el mismo sabor.
 */
function typoConstrained(clause: string, products: AgentProduct[]): AgentProduct[] {
  const kept = new Set(clauseTokens(clause));
  const extra = foldAgent(clause).split(" ").filter((word) => word.length >= 4 && !kept.has(word) && !CATEGORY_TOKENS.has(word));
  let rows = products;
  for (const token of extra) {
    const hits = rows.filter((product) => foldAgent(product.name).split(" ").some((word) => listaWordHit(word, token)));
    const exact = rows.some((product) => foldAgent(product.name).split(" ").includes(token));
    if (!exact && hits.length > 0 && hits.length < rows.length) rows = hits;
  }
  return rows;
}

/** Una palabra suelta en varias categorías: una opción por tipo, el más común primero. */
function categorySpread(products: AgentProduct[]): AgentProduct[] | null {
  const groups = new Map<string, AgentProduct[]>();
  for (const product of products) {
    const key = foldAgent(product.category ?? "") || "otros";
    const list = groups.get(key) ?? [];
    list.push(product);
    groups.set(key, list);
  }
  if (groups.size < 2) return null;
  const ordered = [...groups.values()].sort((left, right) => right.length - left.length);
  const out = ordered.map((list) => list[0]).slice(0, 5);
  return out.length >= 2 ? out : null;
}

function looseSingleToken(clause: string): boolean {
  const tokens = clauseTokens(clause).filter((token) => !CATEGORY_TOKENS.has(token));
  return tokens.length === 1;
}

/** La palabra está escrita en algún producto. «pawer» no: es falta de «powerade». */
function writtenAsSaid(clause: string, products: AgentProduct[]): boolean {
  const tokens = clauseTokens(clause).filter((token) => !CATEGORY_TOKENS.has(token));
  if (tokens.length !== 1) return false;
  const token = tokens[0];
  return products.some((product) => foldAgent(product.name).split(" ").some((word) => word === token || word === `${token}s` || token === `${word}s`));
}

/** Si la palabra sí está escrita en la familia, la falta de una letra no mete otro producto. */
function dropLooseWhenWritten(clause: string, products: AgentProduct[]): AgentProduct[] {
  const tokens = clauseTokens(clause).filter((token) => token.length >= 4);
  const wordsOf = (product: AgentProduct) => foldAgent(product.name).split(" ").filter(Boolean);
  const spelled = tokens.filter((token) => products.some((product) => wordsOf(product).some((word) => tokenWrittenWord(word, token))));
  if (!spelled.length) return products;
  const tight = products.filter((product) => spelled.every((token) => wordsOf(product).some((word) => tokenWrittenWord(word, token))));
  return tight.length ? tight : products;
}

function chooseAbarrotes(clause: string, products: AgentProduct[]): AgentProduct[] {
  if (!clauseMisspelled(clause, products)) {
    const namedLine = products.filter((product) => unsizedNamedLine(clause, product));
    if (namedLine.length === 1) return namedLine;
  }
  const plain = products.filter((product) => unexplainedWords(product, clause).length === 0);
  if (plain.length === 1) {
    const name = foldAgent(plain[0].name);
    const others = products.filter((product) => product.id !== plain[0].id);
    const extensions = others.filter((product) => {
      if (!foldAgent(product.name).startsWith(`${name} `)) return false;
      return unexplainedWords(product, clause).some((word) => !MODIFIER_WORD.test(word));
    });
    if (extensions.length) {
      // «lata de maíz» nombra la lata. «Maíz Morado» es bolsa y no se pregunta.
      if (saidOnlyOn(clause, plain[0], extensions)) return plain;
      return closestOptions(clause, [plain[0], ...extensions]);
    }
    if (others.every((product) => modifierVariant(product, clause))) return plain;
    // «cigarro» no se queda en una marca. «olé capuchino» sí: es la pieza sin tamaño.
    const siblings = others.filter((product) => !modifierVariant(product, clause));
    if (siblings.length && !unsizedNamedLine(clause, plain[0])) return closestOptions(clause, [plain[0], ...siblings]);
  }
  const sized = standardPresentation(clause, products);
  const keys = new Set(products.map((product) => sizeKeyOf(product)));
  // «cocacola» y «zote» traen tamaño y hay varias: se pregunta.
  // «olé capuchino» nombra la línea y la pieza sin tamaño se queda.
  if (sized.length === 1 && keys.size >= 3 && !unsizedNamedLine(clause, sized[0])) {
    return closestOptions(clause, products);
  }
  return sized;
}

/** Una palabra del cliente está en este producto y en ninguno de los otros. */
function saidOnlyOn(clause: string, product: AgentProduct, others: AgentProduct[]): boolean {
  const said = foldAgent(clause).split(" ").filter((word) => word.length >= 4);
  const blob = (row: AgentProduct) => foldAgent(`${row.presentation ?? ""} ${row.name}`);
  const mine = blob(product);
  return said.some((word) => mine.includes(word) && others.every((other) => !blob(other).includes(word)));
}

/** «ole capuchino» → Ole Cappuccino, que no trae mililitros. «coca» no: todas traen tamaño. */
function unsizedNamedLine(clause: string, product: AgentProduct): boolean {
  if (sizeKeyOf(product)) return false;
  const words = new Set(foldAgent(product.name).split(" ").filter(Boolean));
  const tokens = foldAgent(clause).split(" ").filter((token) => token.length >= 3 && !CATEGORY_TOKENS.has(token));
  const hits = tokens.filter((token) => {
    const forms = new Set([token, ...synonymForms(token)]);
    return [...forms].some((form) => words.has(form));
  });
  return hits.length >= 2;
}

export function decideClause(clause: string, pool: AgentProduct[], store: AgentStore): ClauseDecision {
  const text = cleanClause(clause);
  const exact = exactNameDecision(text, pool, store);
  if (exact) return exact;
  const tokens = clauseTokens(text);
  if (!tokens.length) return { kind: "skip", clause: text };

  if (store.category !== "abarrotes" && isGenericDogoText(text)) {
    const clasico = genericDogoProduct(pool) ?? genericDogoProduct(searchAgentProducts(pool, "dogo clasico", 8));
    if (clasico) {
      const qty = lineQty(text, clasico, store);
      return { kind: "add", clause: text, product: clasico, qty: qty.qty, unit: qty.unit, variant: null };
    }
  }

  const found = searchAgentProducts(pool, text, 16);
  const ranked = typeFilter(text, found);
  const best = ranked.length ? Math.max(...ranked.map((product) => coverage(product, tokens))) : 0;
  let hits = best > 0 ? ranked.filter((product) => coverage(product, tokens) === best) : [];
  if (!hits.length && isVagueListaQuery(text)) hits = ranked.slice(0, 5);

  if (!isVagueListaQuery(text) && tokens.length) {
    const typed = hits.filter((product) => tokens.every((token) => {
      const blob = productBlob(product);
      return tokenInBlob(blob, token) || sauceTypeAlias(blob, token, text);
    }));
    if (!typed.length) return { kind: "missing", clause: text, label: labelOf(text) };
    hits = typed;
  }
  const wanted = spokenPackageSize(text);
  if (wanted) {
    const sized = hits.filter((product) => matchesPackage(product, wanted));
    if (sized.length) hits = sized;
    else if (householdSize(text)) return { kind: "missing", clause: text, label: labelOf(text) };
  }
  let forceAsk = false;
  if (saidPack(text) && categoryOnlyClause(text)) {
    // «un paquete de aguas» tiene varias marcas. No se anota la única caja de la ventana.
    const packs = hits.filter((product) => isPackProduct(product));
    const rest = hits.filter((product) => !isPackProduct(product));
    hits = [...packs, ...rest].slice(0, 5);
    forceAsk = hits.length > 0;
  } else if (saidPack(text)) {
    const packs = hits.filter((product) => isPackProduct(product) && coverage(product, tokens) > 0);
    if (packs.length) hits = packs;
  } else if (hits.some((product) => isPackProduct(product)) && hits.some((product) => !isPackProduct(product))) {
    const pieces = hits.filter((product) => !isPackProduct(product));
    if (store.category === "abarrotes" || pieces.length === 1) hits = pieces;
  }
  hits = uniqueProducts(hits);
  const named = hits.filter((product) => !falseFriend(text, product));
  if (!named.length) return { kind: "missing", clause: text, label: labelOf(text) };
  // «una caja de sanitas» no se queda en el nombre pelón: la caja no existe y se ofrecen las presentaciones.
  const flavored = isVagueListaQuery(text) ? named : withoutFlavors(text, named);
  hits = saidPack(text) ? flavored : preferBareName(flavored);
  if (spokenPackageSize(text) && hits.length > 1) {
    const clean = hits.filter((product) => unexplainedWords(product, text).length === 0);
    if (clean.length === 1) hits = clean;
  }

  if (!hits.length) return { kind: "missing", clause: text, label: labelOf(text) };

  if (store.category !== "carniceria" && wantsKilo(text) && !hits.some((product) => hasKilo(product) || product.unit === "kg")) {
    const loose = hits.filter((product) => extrasOf(product, text).length === 0);
    if (!loose.length) return { kind: "missing", clause: text, label: labelOf(text) };
    hits = loose;
  }

  if (store.category === "carniceria" && !customerSaidMarinade(text)) {
    const pair = marinadePair(hits);
    if (pair) {
      const measure = lineQty(text, pair.plain, store);
      return {
        kind: "ask",
        clause: text,
        query: text,
        products: [pair.plain, pair.seasoned],
        qty: measure.qty,
        unit: measure.unit,
        marinade: true,
      };
    }
  }
  if (customerSaidMarinade(text)) {
    const seasoned = /\bmarinad/.test(foldAgent(text));
    const side = hits.filter((product) => /\bmarinad/.test(foldAgent(product.name)) === seasoned);
    if (side.length === 1) hits = side;
  }

  const standard = pickStandardSize(text, hits);
  if (standard) hits = [standard];
  if (store.category === "abarrotes" && !spokenPackageSize(text) && !saidPack(text)) {
    const available = pool.filter((product) => product.available);
    // «ole» tiene 3 letras. Sin esto, narrow devolvía toda la ventana de SQL
    // y «Oleo» (Elvive) ganaba al arroz Olé, que sí es la palabra completa.
    const focus = namedTokens(text);
    // «100pz» es la presentación de la servilleta, no una caja. La caja sí se quita si no la pidieron.
    const namedAll = focus.length ? narrowToNamedProduct(text, available) : null;
    // Con una falta se preguntan la caja y la pieza. No se adivina cuál.
    const keepPacks = Boolean(namedAll?.length && clauseMisspelled(text, namedAll));
    const withoutWholesale = (namedAll ?? []).filter((product) => !wholesalePack(product));
    const namedBase = keepPacks ? namedAll : withoutWholesale.length ? withoutWholesale : namedAll;
    const namedPieces = namedBase?.length ? typoConstrained(text, namedBase) : namedBase;
    if (namedPieces?.length) {
      const spread = store.hasProductList && looseSingleToken(text) && writtenAsSaid(text, namedPieces)
        ? categorySpread(namedPieces)
        : null;
      hits = spread ?? spelledClose(text, namedPieces) ?? chooseAbarrotes(text, namedPieces);
    } else if (isVagueListaQuery(text) && hits.length) {
      hits = hits.slice(0, 5);
    } else if (!focus.length && hits.length) {
      const pieceHits = hits.filter((product) => !packInName(product));
      hits = pieceHits.length ? pieceHits : hits;
    } else {
      // En la ventana cruda de SQL a veces solo cabe la caja. Se pregunta, no se anota.
      const namedPacks = focus.length
        ? narrowToNamedProduct(text, available.filter((product) => packInName(product)))
        : null;
      if (!namedPacks?.length) return { kind: "missing", clause: text, label: labelOf(text) };
      hits = namedPacks;
    }
  }
  if (!saidPack(text)) hits = piecesFirst(hits);
  if (hits.length > 1) {
    const narrowed = filterAskedType(text, hits);
    if (narrowed.length === 1 && narrowed.length < hits.length) {
      const family = filterAskedType(text, pool);
      hits = family.length >= 2 ? capOptions(family) : narrowed;
    } else {
      hits = narrowed.length ? narrowed : hits;
    }
  }

  // «Caja Nito» no se anota sola. La columna presentación «paquete» sí: ahí es la unidad.
  if (hits.length === 1 && packInName(hits[0]) && !saidPack(text)) {
    const measure = lineQty(text, hits[0], store);
    return {
      kind: "ask",
      clause: text,
      query: tokens.slice(0, 4).join(" ") || text,
      products: hits,
      qty: measure.qty,
      unit: measure.unit,
      marinade: false,
    };
  }

  if (store.hasProductList && hits.length) hits = dropLooseWhenWritten(text, hits);
  if (store.hasProductList && clauseMisspelled(text, hits)) hits = preferVowelSlip(text, hits);

  if (forceAsk && hits.length >= 1) {
    const measure = lineQty(text, hits[0], store);
    return {
      kind: "ask",
      clause: text,
      query: tokens.slice(0, 4).join(" ") || text,
      products: capOptions(hits),
      qty: measure.qty,
      unit: measure.unit,
      marinade: false,
    };
  }

  if (hits.length === 1 && store.hasProductList && clauseMisspelled(text, hits)) {
    const measure = lineQty(text, hits[0], store);
    return {
      kind: "ask",
      clause: text,
      query: clauseTokens(text).slice(0, 4).join(" ") || text,
      products: hits,
      qty: measure.qty,
      unit: measure.unit,
      marinade: false,
    };
  }

  if (hits.length === 1) {
    const product = hits[0];
    const drink = product.variants.length ? variantFromMessage(product.variants, text) : null;
    if (product.variants.length > 1 && !drink) {
      return { kind: "ask", clause: text, query: text, products: [product], qty: countIn(text), unit: "pz", marinade: false };
    }
    const qty = lineQty(text, product, store);
    return { kind: "add", clause: text, product, qty: qty.qty, unit: qty.unit, variant: drink };
  }

  const measure = lineQty(text, hits[0], store);
  return {
    kind: "ask",
    clause: text,
    query: tokens.slice(0, 4).join(" "),
    products: capOptions(hits),
    qty: measure.qty,
    unit: measure.unit,
    marinade: false,
  };
}

export function clauseResolvesTo(message: string, product: AgentProduct, products: AgentProduct[], store: AgentStore): boolean {
  for (const clause of orderClauses(message)) {
    const decision = decideClause(clause, products, store);
    if (decision.kind === "add" && decision.product.id === product.id) return true;
  }
  return false;
}

const META = /^(?:si|no|ok|va|sale|esta bien|asi esta bien|correcto|todo bien|sigue)$/;
const POINTER = /^(?:(?:la|el|del|de|opcion|numero|pues|es)\s+)?(?:ese|esa|eso|ese mismo|esa misma|el primero|la primera|\d+)$/;

export function messageIsNotAnOrder(message: string): boolean {
  if (isAffirmativeChatter(message)) return true;
  const text = foldAgent(message);
  if (!text || META.test(text) || POINTER.test(text)) return true;
  if (/^(?:cual|cuales|que)\b/.test(text) && text.split(" ").length <= 6) return true;
  if (/\b(ninguno|ninguna|ningunos|ningunas)\b/.test(text)) return true;
  if (/^(?:seguimos|sigue|continua|continuemos|es todo|nada mas)$/.test(text)) return true;
  if (isCancelIntent(message)) return true;
  if (/\b(quita|quitame|quiteme|quite|quitar|saca|sacame|sacalo|sacala|borra|elimina|cancela|ya no)\b/.test(text)) return true;
  return false;
}

export async function composeMessage(params: {
  message: string;
  store: AgentStore;
  pool: AgentProduct[];
  search?: (query: string) => Promise<AgentProduct[]> | AgentProduct[];
}): Promise<ClauseDecision[]> {
  if (messageIsNotAnOrder(params.message)) return [];
  const seenSearch = new Map<string, AgentProduct[]>();
  const searchClause = async (query: string): Promise<AgentProduct[]> => {
    if (!params.search) return [];
    const key = foldAgent(query);
    const cached = seenSearch.get(key);
    if (cached) return cached;
    const found = (await params.search(query)).filter((product) => product.available);
    seenSearch.set(key, found);
    return found;
  };
  if (params.store.hasProductList && params.search) {
    const lines = params.message.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) await searchClause(line);
  }
  const phrases = conjunctionPhrases([
    ...params.pool.map((product) => product.name),
    ...[...seenSearch.values()].flat().map((product) => product.name),
  ]);
  const resolved = params.store.hasProductList && params.search
    ? listClauses(params.message, (line) => {
        const key = foldAgent(line);
        const found = seenSearch.get(key) ?? [];
        return found.some((product) => foldAgent(product.name) === key);
      }, phrases)
    : orderClauses(params.message, phrases);
  const out: ClauseDecision[] = [];
  for (const clause of resolved) {
    let pool = params.pool;
    if (params.search) {
      const found = await searchClause(clause);
      if (found.length) pool = found;
    }
    out.push(decideClause(clause, pool, params.store));
  }
  return out;
}

function shownName(product: AgentProduct, variant: string | null): string {
  const base = product.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!variant) return product.name;
  if (foldAgent(base).includes(foldAgent(variant))) return base;
  return `${base} ${variant}`;
}

/** Quita lo que el modelo anotó de más: Pizzadogo cuando pidieron pizza, o la Coca de 355 cuando dijeron 600. */
export function dropInventedLines(prior: AgentLine[], cart: AgentLine[], decisions: ClauseDecision[]): AgentLine[] {
  const priorIds = new Set(prior.map((line) => line.lineId));
  const added = new Set(
    decisions.filter((decision): decision is ClauseAdd => decision.kind === "add").map((decision) => decision.product.id),
  );
  const asked = new Set(
    decisions
      .filter((decision): decision is ClauseAsk => decision.kind === "ask")
      .flatMap((decision) => decision.products.map((product) => product.id)),
  );
  const missingTokens = decisions
    .filter((decision): decision is ClauseMissing => decision.kind === "missing")
    .flatMap((decision) => contentTokens(decision.label));
  const addedTokens = decisions
    .filter((decision): decision is ClauseAdd => decision.kind === "add")
    .flatMap((decision) => contentTokens(decision.clause));
  return cart.filter((line) => {
    if (priorIds.has(line.lineId)) return true;
    if (line.productId != null && added.has(line.productId)) return true;
    if (line.productId != null && asked.has(line.productId)) return false;
    const words = foldAgent(line.name).split(" ").filter(Boolean);
    if (missingTokens.some((token) => words.some((word) => word.startsWith(token) && word.length - token.length > 2))) return false;
    if (addedTokens.some((token) => token.length >= 4 && words.some((word) => word === token || word.startsWith(token)))) return false;
    return true;
  });
}

export function lineFromDecision(lineId: string, decision: ClauseAdd): AgentLine {
  const variant = decision.variant;
  return {
    lineId,
    productId: decision.product.id,
    freeText: null,
    name: shownName(decision.product, variant),
    qty: decision.qty,
    unit: decision.unit,
    variant,
    note: asideNote(decision.clause),
    unitPrice: decision.product.price,
    brand: decision.product.brand,
    presentation: decision.product.presentation,
  };
}
