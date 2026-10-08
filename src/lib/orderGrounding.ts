import type { CatalogPriceRow } from "@/lib/catalogQuantities";
import { applyCatalogSpeech, type CatalogSpeechResult } from "@/lib/catalogOrderSpeech";
import { stripBotDecorations } from "@/lib/messageStyle";
import { applyCustomerEdits, planCustomerEdits, wordsAreClose, type AddedLine } from "@/lib/orderEdits";
import { dropItemsNamedInRemoval, groceryNamesClause, rewriteGrocerySlips, waiverNote } from "@/lib/quoteProductClarity";
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

const TRACE_ALIAS: Record<string, string[]> = {
  refresco: ["coca", "coquita", "chesco", "pepsi", "sprite", "mirinda"],
  coca: ["coquita", "chesco"],
  sopa: ["maruchan", "ramen"],
  papa: ["sabrita", "sabritas"],
  papas: ["sabrita", "sabritas"],
  tortilla: ["tortillina", "tortillinas"],
  higienico: ["bano"],
  marinada: ["marinda", "marinado"],
  marinad: ["marinda", "marinado"],
  wings: ["wins", "win"],
  fino: ["firo"],
  arrachera: ["arracera"],
  manzana: ["manzanita", "manzanitas"],
};

function traceTokens(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token));
}

/** Cada línea del pedido tiene que salir de algo que el cliente dijo. */
export function lineTracesToCustomer(item: PedidoItemInput, customerText: string): boolean {
  const said = norm(rewriteGrocerySlips(customerText));
  const tokens = traceTokens(`${item.nombre_producto} ${item.marca ?? ""}`);
  if (!tokens.length) return true;
  return tokens.some((token) => {
    const stem = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
    if (said.includes(token) || said.includes(stem)) return true;
    const aliases = TRACE_ALIAS[token] ?? TRACE_ALIAS[stem] ?? [];
    return aliases.some((alias) => said.includes(alias));
  });
}

export function ungroundedOrderLines(
  items: PedidoItemInput[],
  customerText: string,
  assistedNames: string[] = [],
): string[] {
  return items
    .filter((item) => !lineTracesToCustomer(item, customerText) && !assistedLine(item, assistedNames))
    .map((item) => item.nombre_producto);
}

function assistedLine(item: PedidoItemInput, assistedNames: string[]): boolean {
  const hay = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
  return assistedNames.some((name) => {
    const wanted = norm(name);
    if (!wanted) return false;
    if (hay.includes(wanted) || wanted.includes(norm(item.nombre_producto))) return true;
    return wanted.split(" ").some((token) => token.length >= 5 && hay.split(" ").some((word) => word.startsWith(token.slice(0, 5)) || token.startsWith(word.slice(0, 5))));
  });
}

const CLAUSE_SKIP = new Set([
  "pues", "fijate", "fijese", "oye", "mira", "verdad", "entonces", "tambien", "quiero", "quiere",
  "quisiera", "queria", "dame", "ponme", "para", "como", "esta", "este", "eso", "esa", "ese",
  "solo", "nomas", "porfa", "favor", "gracias", "bueno", "hola", "buenas", "pero", "bien",
  "quita", "quitar", "cambia", "cambiar", "kilo", "kilos", "medio", "media", "gramo", "gramos",
  "peso", "pesos", "pieza", "piezas", "litro", "litros", "lata", "latas", "grande", "grandes",
  "chica", "chico", "chicas", "mediana", "mediano", "blanca", "blanco", "morada", "morado",
  "negra", "negro", "roja", "rojo", "faltaron", "faltan", "faltaba", "unos", "unas",
  "entera", "enteras", "enteros", "quieres", "como", "fijate",
  "seria", "serian", "seran", "fueron", "quieta", "kita",
  "quitame", "quitalo", "quitala", "borrame", "aparte", "error", "equivocaste", "equivocado",
  "mal", "bote", "botes", "reiniciar", "cancelar", "cancela",
]);

const HARD_OFF = new Set(["sushi", "pizza", "pescado", "camaron", "camarones", "combo", "combos", "taco", "tacos", "pollo", "pollos"]);

const DRINK_BRANDS = ["pepsi", "coca", "sprite", "manzana", "manzanita", "mirinda", "seven"];

function menuBlob(catalog: CatalogPriceRow[]): string {
  return norm(catalog.map((row) => row.nombreProducto).join(" "));
}

function menuHas(catalog: CatalogPriceRow[], token: string): boolean {
  const hay = menuBlob(catalog);
  const stem = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
  if (hay.includes(token) || (stem.length >= 4 && hay.includes(stem))) return true;
  return hay.split(" ").some((word) => wordsAreClose(word, token) || wordsAreClose(word, stem));
}

function hardOff(token: string, catalog: CatalogPriceRow[]): boolean {
  if (!catalog.length || !HARD_OFF.has(token)) return false;
  return !menuHas(catalog, token);
}

function clauseTokens(clause: string): string[] {
  return norm(rewriteGrocerySlips(clause))
    .split(" ")
    .filter((token) => token.length >= 4 && !CLAUSE_SKIP.has(token) && !/^\d+$/.test(token));
}

function tokenCovered(token: string, items: PedidoItemInput[]): boolean {
  const stem = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
  const aliases = TRACE_ALIAS[token] ?? TRACE_ALIAS[stem] ?? [];
  return items.some((item) => {
    const hay = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
    if (hay.includes(token) || (stem.length >= 4 && hay.includes(stem))) return true;
    if (aliases.some((alias) => hay.includes(alias))) return true;
    return hay.split(" ").some((word) => wordsAreClose(word, token));
  });
}

function openClauses(message: string, items: PedidoItemInput[]): string[] {
  const plan = planCustomerEdits(message);
  const source = plan.ops.length ? plan.remainder : norm(message);
  if (!source.trim()) return [];
  const open: string[] = [];
  for (const clause of source.split(/,|\by\b|\btambien\b/)) {
    const tokens = clauseTokens(clause);
    if (!tokens.length) continue;
    if (tokens.every((token) => tokenCovered(token, items))) continue;
    open.push(clause.trim());
  }
  return open;
}

function catalogWordSet(catalog: CatalogPriceRow[]): Set<string> {
  const words = new Set<string>();
  for (const row of catalog) {
    for (const word of norm(row.nombreProducto).split(" ")) {
      if (word.length >= 4) words.add(word);
    }
  }
  return words;
}

/**
 * «hawaiana» ya es una palabra del menú. No se usa para meter «Dogo Hawaiano»
 * cuando el cliente dijo la hamburguesa. Una palabra que no está en el menú
 * («gringa», «chesco») sí puede acercarse a una fila y preguntarse.
 */
const MENU_HEADS = new Set(["hamburguesa", "dogo", "hotdog", "refresco", "torta", "papas", "bistec", "costilla", "chorizo", "salsa"]);

/** «hawaiana» ya armó la hamburguesa. No se vuelve también una torta. */
function repeatsAnotherFamily(item: PedidoItemInput, message: string, existing: PedidoItemInput[]): boolean {
  const tokens = norm(item.nombre_producto).split(" ");
  const head = tokens.find((word) => MENU_HEADS.has(word));
  if (!head) return false;
  const saidHead = norm(message)
    .split(" ")
    .some((word) => word === head || (word.endsWith("s") && word.slice(0, -1) === head));
  if (saidHead) return false;
  const distinctive = tokens.filter((word) => word.length >= 4 && !MENU_HEADS.has(word));
  if (!distinctive.length) return false;
  return distinctive.every((token) =>
    existing.some((line) => {
      const lineTokens = norm(line.nombre_producto).split(" ");
      const lineHead = lineTokens.find((word) => MENU_HEADS.has(word));
      return Boolean(lineHead && lineHead !== head && lineTokens.includes(token));
    }),
  );
}

function clashesWithSaidMenuWord(item: PedidoItemInput, message: string, catalog: CatalogPriceRow[]): boolean {
  const said = new Set(norm(message).split(" ").filter((word) => word.length >= 5));
  const known = catalogWordSet(catalog);
  return norm(item.nombre_producto)
    .split(" ")
    .filter((word) => word.length >= 5 && !MENU_HEADS.has(word))
    .some((token) => {
      if (said.has(token)) return false;
      return [...said].some((word) => known.has(word) && wordsAreClose(word, token));
    });
}

function fuzzyMenuRow(clause: string, catalog: CatalogPriceRow[]): CatalogPriceRow | null {
  const known = catalogWordSet(catalog);
  const tokens = clauseTokens(clause).filter((token) => token.length >= 5 && !known.has(token));
  if (!tokens.length) return null;
  const hits: CatalogPriceRow[] = [];
  for (const row of catalog) {
    const words = norm(row.nombreProducto).split(" ").filter((word) => word.length >= 5);
    const close = tokens.some((token) => words.some((word) => word !== token && wordsAreClose(word, token)));
    if (close) hits.push(row);
  }
  const names = [...new Set(hits.map((row) => row.nombreProducto))];
  if (names.length !== 1) return null;
  return hits[0];
}

function compactName(value: string): string {
  return norm(value).replace(/\s+/g, "");
}

function asMenuItem(item: PedidoItemInput, catalog: CatalogPriceRow[]): PedidoItemInput | null {
  if (!item.nombre_producto?.trim()) return null;
  if (!catalog.length) return { ...item };
  if (modifierOnlyName(item)) return null;
  const name = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
  const wanted = compactName(item.nombre_producto);
  const compactRow = wanted.length >= 6
    ? catalog.find((candidate) => {
        const label = compactName(candidate.nombreProducto);
        if (label === wanted) return true;
        if (!label.startsWith(wanted)) return false;
        return /^\d+(?:g|gramos?|piezas?|pzas?)?$/.test(label.slice(wanted.length));
      })
    : null;
  const row = compactRow ?? catalog.find((candidate) => {
    const label = norm(candidate.nombreProducto);
    const said = norm(item.nombre_producto);
    if (label === said || said.includes(label)) return true;
    if (!label.includes(said)) return false;
    // «Hamburguesa Mar y Tierra» no es la chica ni la grande hasta que lo diga.
    const extra = label.replace(said, " ").replace(/\s+/g, " ").trim();
    return !/\b(chica|chico|grande|mediana|mediano|sencilla|sencillo|doble|triple)\b/.test(extra);
  });
  if (row) return { ...item, nombre_producto: row.nombreProducto };
  const brand = DRINK_BRANDS.find((candidate) => name.includes(candidate));
  if (brand && (menuHas(catalog, "refresco") || menuHas(catalog, brand))) {
    const brandRow = catalog.find((candidate) => norm(candidate.nombreProducto).includes(brand));
    if (brandRow) return { ...item, nombre_producto: brandRow.nombreProducto };
    return { nombre_producto: "Refresco", marca: brand === "manzanita" ? "Manzana" : titleWord(brand), cantidad: item.cantidad ?? 1 };
  }
  if (clauseTokens(item.nombre_producto).some((token) => menuHas(catalog, token))) return { ...item };
  return null;
}

function titleWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function catalogAddition(phrase: string, catalog: CatalogPriceRow[]): AddedLine {
  const spoken = applyCatalogSpeech({ base: [], userMessage: phrase, catalog });
  if (spoken.aside && spoken.items.length === 0) return { item: null, aside: spoken.aside };
  if (spoken.applied && spoken.items.length === 1) {
    return { item: spoken.items[0], aside: spoken.missing ? spoken.question : null };
  }
  if (spoken.applied && spoken.items.length > 1) {
    return { item: null, aside: spoken.question ?? `¿Te refieres a ${spoken.items.map((item) => item.nombre_producto).join(" o a ")}?` };
  }
  return { item: null, aside: null };
}

function sameMenuRow(left: PedidoItemInput, right: PedidoItemInput): boolean {
  if (norm(left.nombre_producto) !== norm(right.nombre_producto)) return false;
  return !brandsConflict(left.marca, right.marca);
}

function withoutSizeWords(value: string): string {
  return norm(value)
    .replace(/\b(chica|chico|grande|mediana|mediano|sencilla|sencillo|doble|triple)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** En menú fijo cada línea es una fila real, o un tipo que todavía se pregunta. */
function enforceMenuLines(items: PedidoItemInput[], catalog: CatalogPriceRow[], prior: PedidoItemInput[] = []): PedidoItemInput[] {
  const next: PedidoItemInput[] = [];
  for (const item of items) {
    if (norm(item.notas ?? "") === "falta tipo") {
      next.push(item);
      continue;
    }
    const mapped = asMenuItem(item, catalog);
    if (!mapped) continue;
    const name = norm(mapped.nombre_producto);
    const exact = catalog.some((row) => norm(row.nombreProducto) === name);
    const unsized = catalog.some((row) => withoutSizeWords(row.nombreProducto) === name);
    const alreadyThere = prior.some((line) => norm(line.nombre_producto) === name);
    if (!exact && !unsized && !alreadyThere) continue;
    const prev = next.find((line) => sameMenuRow(line, mapped));
    if (prev) {
      const left = typeof prev.cantidad === "number" ? prev.cantidad : 1;
      const right = typeof mapped.cantidad === "number" ? mapped.cantidad : 1;
      prev.cantidad = Math.max(left, right);
      continue;
    }
    next.push(mapped);
  }
  return next;
}

function dropRefusal(aside: string | null, words: string[]): string | null {
  if (!aside) return null;
  let next = aside;
  for (const word of words) {
    const titled = titleWord(word);
    next = next.replace(new RegExp(`\\b${titled} no lo manejamos\\.?`, "gi"), " ");
  }
  next = next.replace(/\s+/g, " ").trim();
  return next || null;
}

function restatesClause(clause: string, item: PedidoItemInput): boolean {
  const said = norm(rewriteGrocerySlips(clause));
  return norm(`${item.nombre_producto} ${item.marca ?? ""}`)
    .split(" ")
    .filter((token) => token.length >= 4)
    .some((token) => {
      const stem = token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
      return said.includes(token) || said.includes(stem);
    });
}

function slangTokens(clause: string, items: PedidoItemInput[]): string[] {
  return clauseTokens(clause).filter((token) => token.length >= 6 && !tokenCovered(token, items));
}

function absorbModelReading(params: {
  items: PedidoItemInput[];
  incoming: PedidoItemInput[];
  prior: PedidoItemInput[];
  userMessage: string;
  catalog: CatalogPriceRow[];
  aside: string | null;
}): { items: PedidoItemInput[]; note: string | null; assistedNames: string[]; aside: string | null } {
  const items = params.items.map((item) => ({ ...item }));
  const open = openClauses(params.userMessage, items);
  if (!open.length) return { items, note: null, assistedNames: [], aside: params.aside };

  const soft = open.filter((clause) => !clauseTokens(clause).some((token) => hardOff(token, params.catalog)));
  const refusedMarinade = /sin marinar/.test(norm(params.aside ?? ""));
  const lineMatch = (left: PedidoItemInput, right: PedidoItemInput) =>
    params.catalog.length ? sameMenuRow(left, right) : sameLine(left, right);
  const suggestions = params.incoming
    .map((item) => asMenuItem(item, params.catalog))
    .filter((item): item is PedidoItemInput => item != null)
    .filter((item) => !items.some((previous) => lineMatch(previous, item)))
    .filter((item) => !params.prior.some((previous) => lineMatch(previous, item)))
    .filter((item) => !params.catalog.length || !clashesWithSaidMenuWord(item, params.userMessage, params.catalog))
    .filter((item) => !params.catalog.length || !repeatsAnotherFamily(item, params.userMessage, items))
    .filter((item) => !(refusedMarinade && /marinad/.test(norm(item.nombre_producto))))
    .filter((item) => !(soft.length === 1 && restatesClause(soft[0], item)));
  if (!soft.length || !suggestions.length) return { items, note: null, assistedNames: [], aside: params.aside };
  if (!params.catalog.length && soft.every((clause) => groceryNamesClause(clause))) {
    return { items, note: null, assistedNames: [], aside: params.aside };
  }

  const assistedNames: string[] = [];
  const cleared: string[] = [];
  let note: string | null = null;

  const accept = (clause: string, item: PedidoItemInput, certain: boolean) => {
    const next = sanitizeNewItem(item, params.userMessage);
    if (next.cantidad == null) next.cantidad = 1;
    if (params.catalog.length && items.some((previous) => sameMenuRow(previous, next))) return;
    if (params.catalog.length) {
      const generic = items.findIndex((previous) => {
        const short = norm(previous.nombre_producto);
        const long = norm(next.nombre_producto);
        return short !== long && long.startsWith(`${short} `) && short.split(" ").length <= 2;
      });
      if (generic >= 0) items.splice(generic, 1);
    }
    items.push(next);
    assistedNames.push(next.nombre_producto);
    cleared.push(...clauseTokens(clause));
    if (!certain && !lineTracesToCustomer(next, params.userMessage)) {
      const label = [next.nombre_producto, next.marca].filter(Boolean).join(" ");
      note = `¿Te refieres a ${label}?`;
    }
  };

  if (soft.length === 1 && suggestions.length > 1) {
    const labels = [...new Set(suggestions.map((item) => [item.nombre_producto, item.marca].filter(Boolean).join(" ")))];
    return {
      items,
      note: `¿Te refieres a ${labels.slice(0, 3).join(" o a ")}?`,
      assistedNames: [],
      aside: params.aside,
    };
  }

  if (soft.length === 1 && suggestions.length === 1) {
    const slang = slangTokens(soft[0], items);
    const hay = norm(`${suggestions[0].nombre_producto} ${suggestions[0].marca ?? ""}`);
    const related = clauseTokens(soft[0]).some((token) => hay.includes(token) || hay.split(" ").some((word) => wordsAreClose(word, token)));
    if (!related && slang.length !== 1) return { items, note: null, assistedNames: [], aside: params.aside };
    if (!related && !params.catalog.length && groceryNamesClause(soft[0])) {
      return { items, note: null, assistedNames: [], aside: params.aside };
    }
    const fuzzy = params.catalog.length ? fuzzyMenuRow(soft[0], params.catalog) : null;
    const chosen = fuzzy ? { ...suggestions[0], nombre_producto: fuzzy.nombreProducto, marca: null } : suggestions[0];
    accept(soft[0], chosen, fuzzy != null && lineTracesToCustomer({ nombre_producto: fuzzy.nombreProducto }, params.userMessage));
    return { items, note, assistedNames, aside: dropRefusal(params.aside, cleared) };
  }

  const used = new Set<number>();
  for (const clause of soft) {
    const fuzzy = params.catalog.length ? fuzzyMenuRow(clause, params.catalog) : null;
    if (fuzzy) {
      accept(clause, { nombre_producto: fuzzy.nombreProducto, cantidad: 1 }, true);
      continue;
    }
    let best = -1;
    let bestScore = 0;
    suggestions.forEach((item, index) => {
      if (used.has(index)) return;
      const hay = norm(`${item.nombre_producto} ${item.marca ?? ""}`);
      const score = clauseTokens(clause).reduce((sum, token) => sum + (hay.includes(token) || hay.split(" ").some((word) => wordsAreClose(word, token)) ? 1 : 0), 0);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0 && (bestScore > 0 || soft.length === suggestions.length)) {
      used.add(best);
      accept(clause, suggestions[best], bestScore > 0 && lineTracesToCustomer(suggestions[best], params.userMessage));
    }
  }
  return { items, note, assistedNames, aside: dropRefusal(params.aside, cleared) };
}

function listQuestion(note: string | null): string | null {
  const parts = [note?.trim(), "¿Están bien estos productos?"].filter(Boolean);
  return parts.join("\n") || null;
}

export function assembleCapturedItems(params: {
  prior: PedidoItemInput[];
  incoming: PedidoItemInput[];
  userMessage: string;
  catalog?: CatalogPriceRow[] | null;
}): { items: PedidoItemInput[]; catalogSpeech: CatalogSpeechResult | null; assistedNames: string[]; assistNote: string | null } {
  const message = stripBotDecorations(String(params.userMessage ?? ""));
  const prior = params.prior ?? [];
  const incoming = params.incoming ?? [];
  const catalog = params.catalog ?? [];
  const plan = planCustomerEdits(message);

  if (catalog.length && plan.ops.length) {
    const structural = { ...plan, ops: plan.ops.filter((op) => op.kind !== "remove") };
    const removals = { ...plan, ops: plan.ops.filter((op) => op.kind === "remove"), editsOnly: true, remainder: "" };
    const edited = applyCustomerEdits({
      prior,
      working: prior.map((item) => ({ ...item })),
      plan: structural,
      catalog,
      resolveAddition: (phrase) => catalogAddition(phrase, catalog),
    });
    let items = edited.items;
    let spoken: CatalogSpeechResult | null = null;
    if (!plan.editsOnly && plan.remainder.trim()) {
      spoken = applyCatalogSpeech({ base: items.map((item) => ({ ...item })), userMessage: plan.remainder, catalog });
      if (spoken.applied) items = spoken.items.map((item) => ({ ...item }));
    }
    let removeNote: string | null = null;
    if (removals.ops.length) {
      const removed = applyCustomerEdits({ prior: items, working: items, plan: removals, catalog });
      items = removed.items;
      removeNote = removed.note;
    }
    items = dropItemsNamedInRemoval(items, message);
    const asideOnly = spoken?.missing === true && spoken.aside != null && spoken.question === spoken.aside;
    const absorbed = absorbModelReading({
      items,
      incoming,
      prior,
      userMessage: message,
      catalog,
      aside: [edited.note, spoken?.aside].filter(Boolean).join(" ") || null,
    });
    const kept = enforceMenuLines(absorbed.items, catalog, prior);
    const pending = kept.some((item) => norm(item.notas ?? "") === "falta tipo");
    const missing =
      pending ||
      Boolean(removeNote) ||
      (spoken?.missing === true && !(asideOnly && absorbed.aside == null && absorbed.assistedNames.length > 0));
    const note = [removeNote, absorbed.note ?? (absorbed.aside?.trim() ? absorbed.aside : null)].filter(Boolean).join("\n") || null;
    const ask = spoken?.question ?? edited.note ?? note;
    return {
      items: kept,
      assistedNames: absorbed.assistedNames,
      assistNote: absorbed.note,
      catalogSpeech: {
        applied: true,
        missing,
        items: kept,
        reply: missing ? spoken?.reply ?? ask ?? null : null,
        question: missing ? ask : listQuestion(note),
        aside: note,
      },
    };
  }

  if (catalog.length) {
    const spoken = applyCatalogSpeech({ base: prior.map((item) => ({ ...item })), userMessage: message, catalog });
    if (spoken.applied) {
      const dropped = dropItemsNamedInRemoval(spoken.items, message);
      const asideOnly = spoken.missing && spoken.aside != null && spoken.question === spoken.aside;
      const absorbed = absorbModelReading({ items: dropped, incoming, prior, userMessage: message, catalog, aside: spoken.aside });
      const resolved = asideOnly && absorbed.assistedNames.length > 0;
      const kept = enforceMenuLines(absorbed.items, catalog, prior);
      const pending = kept.some((item) => norm(item.notas ?? "") === "falta tipo");
      const missing = pending || (spoken.missing && !resolved);
      const note = [absorbed.note, absorbed.aside].filter(Boolean).join("\n") || null;
      return {
        items: kept,
        assistedNames: absorbed.assistedNames,
        assistNote: absorbed.note,
        catalogSpeech: {
          ...spoken,
          missing,
          items: kept,
          question: missing ? spoken.question ?? note : resolved || absorbed.note ? listQuestion(note) : spoken.question,
          aside: note,
          reply: spoken.reply,
        },
      };
    }
  }

  if (plan.editsOnly) {
    return { items: prior.map((item) => ({ ...item })), catalogSpeech: null, assistedNames: [], assistNote: null };
  }

  const grounded = dropItemsNamedInRemoval(retainPriorPlusGrounded(prior, incoming, message), message);
  const absorbed = absorbModelReading({ items: grounded, incoming, prior, userMessage: message, catalog, aside: null });
  return { items: absorbed.items, catalogSpeech: null, assistedNames: absorbed.assistedNames, assistNote: absorbed.note };
}
