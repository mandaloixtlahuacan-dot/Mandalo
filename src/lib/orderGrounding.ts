import type { CatalogPriceRow } from "@/lib/catalogQuantities";
import { applyCatalogSpeech, type CatalogSpeechResult } from "@/lib/catalogOrderSpeech";
import { dropItemsNamedInRemoval, waiverNote } from "@/lib/quoteProductClarity";
import type { PedidoItemInput } from "@/lib/services/captureEngine";

/**
 * El modelo devuelve `items` y el merge los suma. Nada comprobaba que una
 * línea nueva saliera de lo que el cliente acaba de decir, así que una
 * Coca, un pollo o una marca inventada se quedaban en el pedido para siempre.
 *
 * Aquí la lista anterior es la base. Una línea nueva entra solo si su nombre
 * o su marca están en este mensaje. Menú fijo: se lee el mensaje contra el
 * catálogo y no se arrastra lo que el modelo haya agregado de más.
 */

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

function rewriteSlips(message: string): string {
  return message.replace(/\barroz\s+higi[eé]nicos?\b/gi, "papel higienico");
}

function messageWords(message: string): Set<string> {
  return new Set(norm(rewriteSlips(message)).split(" ").filter(Boolean));
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokenInMessage(token: string, bag: Set<string>): boolean {
  if (token.length < 3) return false;
  if (bag.has(token)) return true;
  const rooted = stem(token);
  if (rooted.length < 4) return false;
  for (const word of bag) {
    if (stem(word) === rooted) return true;
  }
  return false;
}

function contentTokens(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
}

function nameStem(value: string): string {
  if (value.endsWith("s") && value.length > 3) return value.slice(0, -1);
  return value;
}

function namesAgree(leftName: string, rightName: string): boolean {
  const left = norm(leftName);
  const right = norm(rightName);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftRoot = nameStem(left);
  const rightRoot = nameStem(right);
  if (leftRoot === rightRoot) return true;
  const [shorter, longer] = leftRoot.length <= rightRoot.length ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
  return shorter.length >= 4 && longer.startsWith(`${shorter} `);
}

function brandsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = norm(left ?? "");
  const b = norm(right ?? "");
  if (!a || !b) return false;
  if (a === b) return false;
  return !a.includes(b) && !b.includes(a);
}

function sameLine(left: PedidoItemInput, right: PedidoItemInput): boolean {
  if (!namesAgree(left.nombre_producto, right.nombre_producto)) return false;
  return !brandsConflict(left.marca, right.marca);
}

function detailGrounded(value: string | null | undefined, message: string): boolean {
  const text = norm(value ?? "");
  if (!text) return false;
  const bag = messageWords(message);
  const tokens = text.split(" ").filter((token) => token.length >= 3 || /^\d+$/.test(token));
  if (!tokens.length) return false;
  return tokens.some((token) => (/^\d+$/.test(token) ? bag.has(token) || norm(message).includes(token) : tokenInMessage(token, bag)));
}

function quantityMentioned(qty: number, message: string): boolean {
  if (qty === 0.25 && /1\s*\/\s*4/.test(message)) return true;
  if (qty === 0.5 && (/1\s*\/\s*2/.test(message) || /\bmedio\b/i.test(message))) return true;
  const bag = messageWords(message);
  if (Number.isInteger(qty) && bag.has(String(qty))) return true;
  for (const [word, value] of Object.entries(QTY_WORDS)) {
    if (value === qty && bag.has(word)) return true;
  }
  return false;
}

function sanitizeNewItem(item: PedidoItemInput, message: string): PedidoItemInput {
  const next: PedidoItemInput = { nombre_producto: item.nombre_producto };
  if (item.marca && detailGrounded(item.marca, message)) next.marca = item.marca;
  if (item.presentacion && detailGrounded(item.presentacion, message)) next.presentacion = item.presentacion;
  if (item.unidad && detailGrounded(item.unidad, message)) next.unidad = item.unidad;
  const waived = waiverNote(message);
  if (item.notas && (detailGrounded(item.notas, message) || (waived != null && waiverNote(item.notas) != null))) {
    next.notas = item.notas;
  }
  if (typeof item.cantidad === "number" && Number.isFinite(item.cantidad) && quantityMentioned(item.cantidad, message)) {
    next.cantidad = item.cantidad;
  }
  return next;
}

const MODIFIER_NAME = new Set([
  "blanca", "blanco", "morada", "morado", "negra", "negro", "roja", "rojo",
  "grande", "chica", "chico", "mediana", "mediano", "entera", "deslactosada", "light",
  "jalapeno", "serrano", "nutrioli", "lala", "alpura", "fud", "sabritas",
  "mccormick", "mccormik", "petalo", "sanitas", "sams", "sam", "valle",
]);

function nameGrounded(item: PedidoItemInput, message: string): boolean {
  const bag = messageWords(message);
  const tokens = contentTokens(item.nombre_producto);
  if (!tokens.length) return false;
  return tokens.some((token) => tokenInMessage(token, bag));
}

function modifierOnlyName(item: PedidoItemInput): boolean {
  const tokens = contentTokens(item.nombre_producto);
  if (!tokens.length) return false;
  return tokens.every((token) => MODIFIER_NAME.has(token) || MODIFIER_NAME.has(stem(token)));
}

function retainPriorPlusGrounded(
  prior: PedidoItemInput[],
  incoming: PedidoItemInput[],
  message: string,
): PedidoItemInput[] {
  const kept = prior.map((item) => ({ ...item }));
  for (const item of incoming) {
    if (!item.nombre_producto?.trim()) continue;
    if (kept.some((previous) => sameLine(previous, item))) continue;
    // La marca sola no abre una línea: "Sam's" en el papel no autoriza un arroz.
    // "Blanca" o "Nutrioli" contestan un hueco; no son un producto nuevo.
    if (!nameGrounded(item, message)) continue;
    if (modifierOnlyName(item)) continue;
    kept.push(sanitizeNewItem(item, message));
  }
  return kept;
}

export function assembleCapturedItems(params: {
  prior: PedidoItemInput[];
  incoming: PedidoItemInput[];
  userMessage: string;
  catalog?: CatalogPriceRow[] | null;
}): { items: PedidoItemInput[]; catalogSpeech: CatalogSpeechResult | null } {
  const message = String(params.userMessage ?? "");
  const prior = params.prior ?? [];
  const incoming = params.incoming ?? [];
  const catalog = params.catalog ?? [];

  if (catalog.length) {
    const spoken = applyCatalogSpeech({ base: prior.map((item) => ({ ...item })), userMessage: message, catalog });
    if (spoken.applied) {
      const items = dropItemsNamedInRemoval(spoken.items, message);
      return { items, catalogSpeech: { ...spoken, items } };
    }
  }

  return {
    items: dropItemsNamedInRemoval(retainPriorPlusGrounded(prior, incoming, message), message),
    catalogSpeech: null,
  };
}
