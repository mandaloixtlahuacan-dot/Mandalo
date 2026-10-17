/**
 * Arma el pedido directo contra el catálogo de la tienda.
 * Una cláusula se anota, se pregunta o se dice que no la tienen.
 * No inventa productos ni deja una línea en silencio.
 */
import { foldAgent, genericDogoProduct, isGenericDogoText, searchAgentProducts } from "@/lib/orderAgent/catalog";
import { listaRankTokens } from "@/lib/storeProductSearch";
import {
  contentTokens,
  isPackProduct,
  packInName,
  orderClauses,
  presentationFromName,
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
  return /\b(cajas?|paquetes?)\b/.test(foldAgent(clause));
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
  if (!word || !token) return false;
  if (word === token) return true;
  const gap = Math.abs(word.length - token.length);
  if (gap > prefixLimit(token)) return false;
  if (word.startsWith(token) || token.startsWith(word)) return true;
  return false;
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
  return contentTokens(clause).filter((token) => !SIZE_WORD.test(token) && token !== "litro" && token !== "litros");
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
  const key = presentationFromName(`${product.name} ${product.presentation ?? ""}`)?.key ?? "";
  if (!key) return false;
  if (wanted.endsWith("l")) {
    const n = wanted.slice(0, -1);
    return key === wanted || key === `${Number(n) * 1000}ml`;
  }
  return key === wanted;
}

function lineQty(clause: string, product: AgentProduct, store: AgentStore): { qty: number; unit: AgentUnit } {
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
  const tokens = clauseTokens(clause);
  const name = tokens.slice(0, 4).join(" ");
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

function namedCut(clause: string): boolean {
  return /\b(pollo|res|puerco|cuban|hawaian|camaron|arrachera|pastor)\b/.test(foldAgent(clause));
}

function pickStandardSize(clause: string, products: AgentProduct[]): AgentProduct | null {
  if (products.length < 2) return products[0] ?? null;
  const stems = new Set(products.map((product) => stemOf(product.name)));
  if (stems.size !== 1) return null;
  const sizes = products.map((product) => sizeWordOf(product.name));
  if (!sizes.every((size) => size === "chica" || size === "grande")) return null;
  const asked = saidSize(clause);
  if (asked) return products.find((product) => sizeWordOf(product.name) === asked) ?? null;
  // «una hamburguesa» sigue preguntando. «de pollo» ya dice el tipo: se anota la chica.
  if (!namedCut(clause)) return null;
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
  for (const word of words) {
    for (const form of forms) {
      // «maria» no cuenta como «marias»: si no, el mole gana a las galletas.
      if (form !== token && token.startsWith(form) && token.length - form.length <= 2) continue;
      if (word === form) best = Math.max(best, 2);
      else if (word === `${form}s` || form === `${word}s` || word === `${form}es` || form === `${word}es`) best = Math.max(best, 1);
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

export function decideClause(clause: string, pool: AgentProduct[], store: AgentStore): ClauseDecision {
  const text = cleanClause(clause);
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

  const wanted = spokenPackageSize(text);
  if (wanted) {
    const sized = hits.filter((product) => matchesPackage(product, wanted));
    if (sized.length) hits = sized;
  }
  if (saidPack(text)) {
    const packs = hits.filter((product) => isPackProduct(product));
    if (packs.length) hits = packs;
  } else if (hits.some((product) => isPackProduct(product)) && hits.some((product) => !isPackProduct(product))) {
    const pieces = hits.filter((product) => !isPackProduct(product));
    if (store.category === "abarrotes" || pieces.length === 1) hits = pieces;
  }
  hits = uniqueProducts(hits);
  const named = hits.filter((product) => !falseFriend(text, product));
  if (!named.length) return { kind: "missing", clause: text, label: labelOf(text) };
  hits = preferBareName(withoutFlavors(text, named));
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
    const pieces = available.filter((product) => !packInName(product));
    const namedPieces = narrowToNamedProduct(text, pieces);
    if (namedPieces?.length) {
      hits = standardPresentation(text, namedPieces);
    } else {
      // En la ventana cruda de SQL a veces solo cabe la caja. Se pregunta, no se anota.
      const namedPacks = narrowToNamedProduct(text, available.filter((product) => packInName(product)));
      if (!namedPacks?.length) return { kind: "missing", clause: text, label: labelOf(text) };
      hits = namedPacks;
    }
  }
  if (!saidPack(text)) hits = piecesFirst(hits);

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
  const text = foldAgent(message);
  if (!text || META.test(text) || POINTER.test(text)) return true;
  if (/^(?:cual|cuales|que)\b/.test(text) && text.split(" ").length <= 6) return true;
  if (/\b(ninguno|ninguna|ningunos|ningunas)\b/.test(text)) return true;
  if (/^(?:seguimos|sigue|continua|continuemos|es todo|nada mas)$/.test(text)) return true;
  if (/\b(quita|quiteme|borra|elimina|cancela|ya no)\b/.test(text)) return true;
  return false;
}

export async function composeMessage(params: {
  message: string;
  store: AgentStore;
  pool: AgentProduct[];
  search?: (query: string) => Promise<AgentProduct[]> | AgentProduct[];
}): Promise<ClauseDecision[]> {
  if (messageIsNotAnOrder(params.message)) return [];
  const out: ClauseDecision[] = [];
  for (const clause of orderClauses(params.message)) {
    let pool = params.pool;
    if (params.search) {
      const found = (await params.search(clause)).filter((product) => product.available);
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
    note: null,
    unitPrice: decision.product.price,
    brand: decision.product.brand,
    presentation: decision.product.presentation,
  };
}
