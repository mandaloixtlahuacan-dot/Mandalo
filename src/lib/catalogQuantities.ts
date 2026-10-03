/**
 * Cantidades en tiendas de menú fijo (George).
 *
 * El recibo con precios sale después de la ubicación. En ese turno la IA
 * suele reenviar el producto sin `cantidad`, o con 1, y el ticket cobraba
 * una pieza. Aquí la cantidad dicha ("dos hamburguesas", "y también dos
 * dogos") gana, y una cantidad ya anotada se queda si este mensaje no la
 * cambia. El renglón muestra piezas por precio de línea (precio × cantidad).
 */

import { formatMoney } from "@/lib/ordenes";

type CatalogItem = {
  nombre_producto?: string | null;
  marca?: string | null;
  presentacion?: string | null;
  cantidad?: number | null;
};

export type CatalogPriceRow = {
  nombreProducto: string;
  precio: number;
};

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
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "once", "doce", "y", "o", "e", "con", "sin", "por", "para", "que", "se",
  "al", "lo", "quiero", "dame", "ponme", "tambien", "ademas", "otro", "otra",
  "otros", "otras", "mas", "solo", "nomas", "mejor", "porfa", "favor",
]);

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ces")) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function canon(token: string): string {
  const base = stem(token);
  if (base === "dog" || base === "dogo" || base === "hotdog") return "dogo";
  return base;
}

function contentTokens(value: string): string[] {
  return norm(value)
    .split(" ")
    .map(canon)
    .filter((token) => token.length >= 3 && !STOP.has(token) && !/^\d+$/.test(token));
}

function matchKey(value: string): string {
  return contentTokens(value).join(" ");
}

function overlap(left: string[], right: string[]): number {
  return left.filter((token) => right.includes(token)).length;
}

function numericQty(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function quantityToken(token: string): number | null {
  if (QTY_WORDS[token] != null) return QTY_WORDS[token];
  if (/^\d{1,2}$/.test(token)) {
    const parsed = Number(token);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function quantityIn(clause: string): number | null {
  const text = norm(clause);
  if (!text) return null;
  const word = text.match(/\b(un|una|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\b/);
  if (word) return QTY_WORDS[word[1]] ?? null;
  const digit = text.match(/\b(\d{1,2})\b/);
  if (!digit || digit.index == null) return null;
  const after = text.slice(digit.index + digit[1].length);
  if (/^\s*(ml|l|lt|litro|litros|g|gr|gramo|gramos|kg|kilo|kilos|oz)\b/.test(after)) return null;
  const parsed = Number(digit[1]);
  return parsed > 0 ? parsed : null;
}

function splitClauses(message: string): string[] {
  const text = norm(message);
  if (!text) return [];
  return text
    .split(/\s*(?:,|;|\by tambien\b|\btambien\b|\bademas\b|\by\b)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function spokenQuantities(message: string): Array<{ tokens: string[]; qty: number }> {
  const found: Array<{ tokens: string[]; qty: number }> = [];
  for (const clause of splitClauses(message)) {
    const qty = quantityIn(clause);
    const tokens = contentTokens(clause);
    if (qty == null || !tokens.length) continue;
    found.push({ tokens, qty });
  }
  return found;
}

function quantityFor(itemTokens: string[], spoken: Array<{ tokens: string[]; qty: number }>): number | null {
  let best: { qty: number; score: number } | null = null;
  let tie = false;
  for (const entry of spoken) {
    const score = overlap(itemTokens, entry.tokens);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { qty: entry.qty, score };
      tie = false;
    } else if (score === best.score && entry.qty !== best.qty) {
      tie = true;
    }
  }
  if (!best || tie) return null;
  return best.qty;
}

function itemTokens(item: CatalogItem): string[] {
  return contentTokens([item.nombre_producto, item.marca, item.presentacion].filter(Boolean).join(" "));
}

function namesAlign(left: CatalogItem, right: CatalogItem): boolean {
  const a = matchKey(String(left.nombre_producto ?? ""));
  const b = matchKey(String(right.nombre_producto ?? ""));
  if (!a || !b) return false;
  if (a === b) return true;
  const leftTokens = a.split(" ");
  const rightTokens = b.split(" ");
  const shared = overlap(leftTokens, rightTokens);
  return shared >= Math.min(leftTokens.length, rightTokens.length) && shared >= 1;
}

function findPrevious<T extends CatalogItem>(item: T, previous: T[]): T | null {
  const exact = previous.find((candidate) => matchKey(String(candidate.nombre_producto ?? "")) === matchKey(String(item.nombre_producto ?? "")));
  if (exact) return exact;
  const hits = previous.filter((candidate) => namesAlign(candidate, item));
  return hits.length === 1 ? hits[0] : null;
}

function peelLeadingQty(nombre: string): { qty: number | null; nombre: string } {
  const trimmed = nombre.replace(/\s+/g, " ").trim();
  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return { qty: null, nombre: trimmed };
  const qty = quantityToken(norm(match[1]));
  if (qty == null) return { qty: null, nombre: trimmed };
  const rest = match[2].trim();
  if (rest.length < 3) return { qty: null, nombre: trimmed };
  return { qty, nombre: rest };
}

export function reconcileCatalogQuantities<T extends CatalogItem>(
  previous: T[],
  incoming: T[],
  userMessage: string,
): Array<T & { nombre_producto: string; cantidad?: number | null }> {
  const spoken = spokenQuantities(userMessage);
  const messageTokens = contentTokens(userMessage);
  return incoming.map((item) => {
    const tokens = itemTokens(item);
    const fromSpeech = quantityFor(tokens, spoken);
    const prev = findPrevious(item, previous);
    const incomingQty = numericQty(item.cantidad);
    const prevQty = prev ? numericQty(prev.cantidad) : null;
    const mentioned = overlap(tokens, messageTokens) > 0;
    const peeled = peelLeadingQty(String(item.nombre_producto ?? ""));
    const nameQty = peeled.qty;

    let cantidad: number | null = null;
    if (fromSpeech != null) cantidad = fromSpeech;
    else if (nameQty != null && (incomingQty == null || incomingQty === 1)) cantidad = nameQty;
    else if (prevQty != null && (incomingQty == null || !mentioned || (incomingQty === 1 && prevQty > 1))) cantidad = prevQty;
    else if (incomingQty != null) cantidad = incomingQty;
    else cantidad = nameQty;

    let nombre = String(item.nombre_producto ?? "").trim();
    if (peeled.qty != null && cantidad === peeled.qty) nombre = peeled.nombre;

    if (cantidad == null) return { ...item, nombre_producto: nombre };
    return { ...item, nombre_producto: nombre, cantidad };
  });
}

export function matchCatalogProduct<T extends CatalogPriceRow>(catalog: T[], nombreProducto: string): T | null {
  const needle = nombreProducto.trim().toLowerCase();
  if (!needle) return null;

  const exact = catalog.find((row) => row.nombreProducto.trim().toLowerCase() === needle);
  if (exact) return exact;

  const key = matchKey(nombreProducto);
  if (key) {
    const keyed = catalog.filter((row) => matchKey(row.nombreProducto) === key);
    if (keyed.length === 1) return keyed[0];
    if (keyed.length > 1) {
      return keyed.slice().sort((a, b) => b.nombreProducto.length - a.nombreProducto.length)[0];
    }
  }

  const partial = catalog.find((row) => {
    const nombre = row.nombreProducto.trim().toLowerCase();
    return nombre.includes(needle) || needle.includes(nombre);
  });
  return partial ?? null;
}

function formatCount(qty: number): string {
  if (Number.isInteger(qty)) return String(qty);
  return String(Math.round(qty * 100) / 100);
}

function lineLabel(nombre: string, qty: number): string {
  const cleaned = nombre.replace(new RegExp(`(?:,\\s*)?x\\s*${formatCount(qty).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim();
  const base = cleaned || nombre;
  if (qty === 1) return base;
  return `${formatCount(qty)} ${base}`;
}

export function priceCatalogOrder(
  items: Array<{ nombre_producto?: string | null; cantidad?: number | null }>,
  catalog: CatalogPriceRow[],
): { lines: string[]; subtotal: number | null } {
  let subtotal = 0;
  let complete = items.length > 0;
  const lines = items.map((item) => {
    const nombre = String(item.nombre_producto ?? "").trim();
    const qty = numericQty(item.cantidad) ?? 1;
    const match = matchCatalogProduct(catalog, nombre);
    if (!match) {
      complete = false;
      return `- ${lineLabel(nombre, qty)}`;
    }
    const lineTotal = match.precio * qty;
    subtotal += lineTotal;
    return `- ${lineLabel(nombre, qty)} — ${formatMoney(lineTotal)}`;
  });
  return { lines, subtotal: complete ? subtotal : null };
}
