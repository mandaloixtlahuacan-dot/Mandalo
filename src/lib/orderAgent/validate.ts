import { formatMoney } from "@/lib/ordenes";
import { closestAgentProducts, foldAgent, genericDogoProduct, isGenericDogoText, isOrderVerbOnly, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import {
  groceryClarityError,
  groceryFamily,
  normalizeGroceryWords,
  parseGroceryFreeText,
  sameGroceryLine,
} from "@/lib/orderAgent/grocery";
import {
  differKey,
  isPackProduct,
  packInName,
  isPieceCorrection,
  marinadeUnresolved,
  messageSelectsProduct,
  optionsLookDifferent,
  presentationFromName,
  productClause,
  productMentionedStrict,
  replacementLineId,
  uniqueHitMentioned,
  spokenMeasure,
  spokenPackageSize,
  variantFromMessage,
} from "@/lib/orderAgent/match";
import type {
  AgentClarification,
  AgentLine,
  AgentPending,
  AgentProduct,
  AgentStore,
  AgentUnit,
  PendingAxis,
  ToolCall,
} from "@/lib/orderAgent/types";

export type ToolVerdict =
  | { ok: true; line?: AgentLine; removedId?: string; question?: AgentPending; search?: AgentProduct[]; finished?: boolean }
  | { ok: false; error: string; customerNote?: string };

export type AgentSearchHit = { query: string; products: AgentProduct[] };

const UNITS = new Set<AgentUnit>(["pz", "kg", "pesos", "g", "l"]);

function clean(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

export function asAgentUnit(value: unknown): AgentUnit | null {
  const text = foldAgent(String(value ?? ""));
  if (text === "pz" || text === "pieza" || text === "piezas" || text === "pza" || text === "pzas" || text === "pzs") return "pz";
  if (text === "kg" || text === "kilo" || text === "kilos") return "kg";
  if (text === "pesos") return "pesos";
  if (text === "g" || text === "gr" || text === "gramo" || text === "gramos") return "g";
  if (text === "l" || text === "lt" || text === "lts" || text === "litro" || text === "litros") return "l";
  return UNITS.has(text as AgentUnit) ? (text as AgentUnit) : null;
}

function saneQty(unit: AgentUnit, qty: number): boolean {
  if (!Number.isFinite(qty) || qty <= 0) return false;
  if (unit === "pz") return Number.isInteger(qty) && qty <= 40;
  if (unit === "kg") return qty <= 20;
  if (unit === "g") return qty <= 5000;
  if (unit === "l") return qty <= 40;
  return qty >= 10 && qty <= 3000;
}

function unitAllowed(store: AgentStore, product: AgentProduct, unit: AgentUnit): boolean {
  // En abarrotes la tienda cotiza después: el cliente puede pedir piezas, kilos, litros o pesos.
  if (store.catalogMode === "list") return true;
  if (product.unit === "kg") return unit === "kg" || unit === "pesos" || unit === "g";
  return unit === "pz";
}

function matchVariant(product: AgentProduct, variant: string | null): string | null {
  if (!product.variants.length) return null;
  if (!variant) return null;
  return product.variants.find((option) => foldAgent(option) === foldAgent(variant)) ?? null;
}

function axisOf(text: string, explicit: unknown): PendingAxis {
  if (explicit === "number" || explicit === "size" || explicit === "flavor" || explicit === "marinade" || explicit === "brand") {
    return explicit;
  }
  const folded = foldAgent(text);
  if (/\bmarinad|\bnormal\b|\bnatural\b|\bsin marinar\b/.test(folded)) return "marinade";
  if (/\b(chica|grande|tamano)\b/.test(folded)) return "size";
  // "coca" puede ser el producto, no el eje. El sabor se declara con la palabra o con axis.
  if (/\bsabor\b/.test(folded)) return "flavor";
  if (/\bmarca\b/.test(folded)) return "brand";
  return null;
}

export function candidatesDiffer(products: AgentProduct[], ids: number[], axis: PendingAxis): boolean {
  if (!axis) return true;
  const rows = ids.map((id) => products.find((product) => product.id === id)).filter((row): row is AgentProduct => Boolean(row));
  if (!rows.length) return false;
  if (axis === "marinade") {
    const seasoned = rows.map((row) => /marinad|adobad/.test(foldAgent(`${row.name} ${row.presentation ?? ""}`)));
    return seasoned.some(Boolean) && seasoned.some((flag) => !flag);
  }
  if (axis === "size") {
    const sizes = new Set(rows.map((row) => differKey(row)).filter(Boolean));
    if (sizes.size > 1) return true;
    if (rows.some((row) => isPackProduct(row)) && rows.some((row) => !isPackProduct(row))) return true;
    return new Set(rows.map((row) => foldAgent(row.name))).size > 1;
  }
  if (axis === "flavor") {
    const flavors = rows.flatMap((row) => row.variants.map((variant) => foldAgent(variant)));
    return new Set(flavors).size > 1;
  }
  if (axis === "brand") {
    const brands = new Set(rows.map((row) => foldAgent(row.brand ?? "")).filter(Boolean));
    if (brands.size > 1) return true;
    return new Set(rows.map((row) => foldAgent(row.name))).size > 1;
  }
  return ids.length > 1;
}

function sameQuestion(left: string, right: string): boolean {
  return foldAgent(left) === foldAgent(right);
}

function optionLabel(product: AgentProduct): string {
  return [product.brand, product.name, product.presentation].filter((part) => part && String(part).trim()).join(" ");
}

function sizeKey(value: string): string {
  const text = foldAgent(value);
  const ml = text.match(/(\d+)\s*ml\b/);
  if (ml) return `${ml[1]}ml`;
  const liters = text.match(/(\d+)\s*(l|lt|lts|litro|litros)\b/);
  if (liters) return `${liters[1]}l`;
  const kilos = text.match(/(\d+)\s*(kg|kilo|kilos)\b/);
  if (kilos) return `${kilos[1]}kg`;
  return "";
}

function textHasSize(text: string, size: string): boolean {
  const spoken = text
    .replace(/\b(un|una|uno)\b/g, "1")
    .replace(/\bdos\b/g, "2")
    .replace(/\btres\b/g, "3")
    .replace(/\bcuatro\b/g, "4")
    .replace(/\bcinco\b/g, "5");
  if (size.endsWith("ml")) {
    const n = size.slice(0, -2);
    return new RegExp(`\\b${n}\\s*ml\\b`).test(spoken);
  }
  if (size.endsWith("kg")) {
    const n = size.slice(0, -2);
    return new RegExp(`\\b${n}\\s*(kg|kilo|kilos)\\b`).test(spoken);
  }
  if (size.endsWith("l")) {
    const n = size.slice(0, -1);
    return new RegExp(`\\b${n}\\s*(l|lt|lts|litro|litros)\\b`).test(spoken);
  }
  return false;
}

function spokenKilo(text: string): boolean {
  return /\b(kilo|kilos|kg)\b/.test(text);
}

function presentationKg(value: string): { kg: boolean; amount: string | null } {
  const text = foldAgent(value);
  const amount = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilos)\b/);
  const kg = Boolean(amount) || /\b(kg|kilo|kilos)\b/.test(text);
  return { kg, amount: amount ? amount[1].replace(",", ".") : null };
}

function messageSelects(product: AgentProduct, siblings: AgentProduct[], message: string): boolean {
  const text = foldAgent(productClause(message, product.name)).replace(/\b(un|una|uno)\b/g, "1");
  const wantsKg = spokenKilo(text);
  const narrowed = siblings.filter((row) => {
    const present = `${row.presentation ?? ""} ${row.name}`;
    const kg = presentationKg(present);
    if (wantsKg && !kg.kg) return false;
    if (wantsKg && kg.amount && !new RegExp(`\\b${kg.amount}\\s*(kg|kilo|kilos)\\b`).test(text)) return false;
    const size = sizeKey(row.presentation ?? "");
    if (!wantsKg && size && !textHasSize(text, size)) return false;
    return true;
  });
  return messageSelectsProduct(product, narrowed.length ? narrowed : siblings, message);
}

function optionsDiffer(products: AgentProduct[]): boolean {
  return optionsLookDifferent(products);
}

function searchContaining(searches: AgentSearchHit[], productId: number): AgentSearchHit | null {
  for (let index = searches.length - 1; index >= 0; index -= 1) {
    if (searches[index].products.some((product) => product.id === productId)) return searches[index];
  }
  return null;
}

function searchForText(searches: AgentSearchHit[], text: string): AgentSearchHit | null {
  const tokens = foldAgent(normalizeGroceryWords(text))
    .split(" ")
    .filter((token) => token.length >= 3 && !/^(los|las|del|una|uno|con|por|que)$/.test(token));
  if (!tokens.length) return null;
  for (let index = searches.length - 1; index >= 0; index -= 1) {
    const query = foldAgent(searches[index].query);
    if (tokens.some((token) => query.includes(token))) return searches[index];
  }
  return null;
}

function optionPrice(product: AgentProduct): string | null {
  if (product.price == null || !Number.isFinite(Number(product.price))) return null;
  return formatMoney(Number(product.price));
}

export function formatProductOptions(query: string, products: AgentProduct[]): string {
  const rows = products.slice(0, 5);
  const lines = rows.map((product, index) => {
    const label = [product.brand, product.name, product.presentation].filter((part) => part && String(part).trim()).join(" ");
    const price = optionPrice(product);
    return price ? `${index + 1}. ${label} — ${price}` : `${index + 1}. ${label}`;
  });
  const title = query.trim() || rows[0]?.name || "este";
  const priced = rows.filter((product) => optionPrice(product));
  const note =
    rows.length > 0 && priced.length === 0
      ? "\n\nLa tienda confirma el precio. Todavía no es un total cerrado."
      : priced.length < rows.length
        ? "\n\nDonde no hay monto, la tienda confirma el precio."
        : "";
  return `De ${title}, ¿cuál de estos?\n\n${lines.join("\n")}${note}`;
}

function marinadePrompt(products: AgentProduct[], query = ""): string | null {
  const groups = new Map<string, { label: string; plain: boolean; seasoned: boolean }>();
  for (const product of products) {
    const key = foldAgent(product.name).replace(/\bmarinad[oa]s?\b/g, " ").replace(/\s+/g, " ").trim();
    const entry = groups.get(key) ?? { label: product.name.replace(/\s+marinad[oa]s?\b/i, "").trim(), plain: false, seasoned: false };
    if (/\bmarinad/.test(foldAgent(product.name))) entry.seasoned = true;
    else entry.plain = true;
    groups.set(key, entry);
  }
  const pairs = [...groups.entries()].filter(([, entry]) => entry.plain && entry.seasoned);
  if (!pairs.length) return null;
  const text = foldAgent(query);
  const mentioned = text
    ? pairs.filter(([key]) => {
        const tokens = key.split(" ").filter((token) => token.length >= 4);
        return tokens.length > 0 && tokens.every((token) => text.includes(token));
      })
    : pairs;
  if (mentioned.length === 1) return `¿${mentioned[0][1].label} marinada o normal?`;
  if (groups.size === 1) return `¿${pairs[0][1].label} marinada o normal?`;
  return null;
}

function clarificationOf(
  query: string,
  products: AgentProduct[],
  qty: number | null,
  unit: AgentUnit | null,
  axis: PendingAxis,
): AgentClarification {
  const sliced = products.slice(0, 5);
  const brands = new Set(sliced.map((product) => foldAgent(product.brand ?? "")).filter(Boolean));
  const marinade = marinadePrompt(sliced, query);
  return {
    question: marinade ?? formatProductOptions(query, sliced),
    candidateIds: sliced.map((product) => product.id),
    qty,
    unit,
    axis: marinade ? "marinade" : axis ?? (brands.size > 1 ? "brand" : sliced.length > 1 ? "size" : null),
    query,
  };
}

function doubtParts(text: string): string[] {
  return text
    .split(/(?<=[?？])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function queryMentioned(text: string, query: string): boolean {
  const tokens = foldAgent(normalizeGroceryWords(query))
    .split(" ")
    .filter((token) => token.length >= 4);
  if (!tokens.length) return false;
  const folded = foldAgent(text);
  return tokens.every((token) => folded.includes(token));
}

function choiceGroups(searches: AgentSearchHit[], ids: number[]): Array<{ query: string; products: AgentProduct[] }> {
  const groups: Array<{ query: string; products: AgentProduct[] }> = [];
  const seen = new Set<string>();
  for (const hit of searches) {
    const products = hit.products.filter((product) => ids.includes(product.id));
    if (products.length < 2 || !optionsDiffer(products)) continue;
    const key = products
      .map((product) => product.id)
      .sort((left, right) => left - right)
      .join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ query: hit.query, products });
  }
  return groups;
}

/** Varios productos en una sola pregunta. El primero se pregunta; el resto va a la cola. */
function mixedAskGroups(text: string, ids: number[], searches: AgentSearchHit[]): Array<{ query: string; products: AgentProduct[] }> {
  const byIds = ids.length ? choiceGroups(searches, ids) : [];
  if (byIds.length > 1) return byIds;
  const byText = searches
    .filter((hit) => queryMentioned(text, hit.query) && optionsDiffer(hit.products.filter((product) => product.available)))
    .map((hit) => ({ query: hit.query, products: hit.products.filter((product) => product.available) }));
  if (byText.length > 1) return byText;
  return byIds;
}

/** Búsquedas con varias opciones que todavía no están en el carrito. Máximo 5 por producto. */
export function openClarifications(params: {
  searches: AgentSearchHit[];
  cart: AgentLine[];
  coveredIds?: number[];
}): AgentClarification[] {
  const covered = new Set(params.coveredIds ?? []);
  const items: AgentClarification[] = [];
  for (const hit of params.searches) {
    const options = hit.products.filter((product) => product.available);
    if (!optionsDiffer(options)) continue;
    if (options.some((product) => params.cart.some((line) => line.productId === product.id))) continue;
    if (options.some((product) => covered.has(product.id))) continue;
    const item = clarificationOf(hit.query, options, null, null, null);
    items.push(item);
    for (const id of item.candidateIds) covered.add(id);
  }
  return items;
}

function listedChoiceError(products: AgentProduct[]): string {
  const labels = products.slice(0, 5).map(optionLabel).filter(Boolean);
  const brands = new Set(products.map((product) => foldAgent(product.brand ?? "")).filter(Boolean));
  const axis = brands.size > 1 ? "brand" : "size";
  return `Hay varias opciones de verdad. Pregunta con ask_customer (axis ${axis}) y estas opciones: ${labels.join("; ")}. No elijas una tú.`;
}

const MENTION_FILLER = new Set([
  "kilo", "kilos", "litro", "litros", "paquete", "paquetes", "lata", "latas",
  "pieza", "piezas", "gramo", "gramos", "medio", "media", "unos", "unas",
  "caja", "cajas", "bolsa", "bolsas", "botella", "botellas",
]);

function mentionTokens(label: string): string[] {
  return foldAgent(label)
    .split(" ")
    .filter((token) => token.length >= 4 && !MENTION_FILLER.has(token));
}

function tokenMentioned(text: string, token: string): boolean {
  if (text.includes(token)) return true;
  const stem = token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
  if (new RegExp(`\\b${stem}s?\\b`).test(text)) return true;
  return text.split(" ").some((word) => word.length >= 4 && (token.startsWith(word) || word.startsWith(token)));
}

function textMentions(message: string, label: string): boolean {
  const tokens = mentionTokens(label);
  if (!tokens.length) return false;
  const text = foldAgent(message);
  return tokens.every((token) => tokenMentioned(text, token));
}

/** Texto libre: basta una palabra del cliente. El id de catálogo sí exige todas. */
function textMentionsAny(message: string, label: string): boolean {
  const tokens = mentionTokens(label);
  if (!tokens.length) return false;
  const text = foldAgent(message);
  return tokens.some((token) => tokenMentioned(text, token));
}

function productMentioned(message: string, product: AgentProduct): boolean {
  return productMentionedStrict(message, product);
}

function lineMentioned(message: string, line: AgentLine): boolean {
  return [line.name, line.brand ?? "", line.freeText ?? "", line.presentation ?? ""].some((label) => textMentions(message, label));
}

function removalVerb(message: string): boolean {
  return /\b(quita|quitame|quitamelo|quitamela|quitalo|quitala|sin el|sin la|ya no|no pedi|no quiero|borra|elimina)\b/.test(foldAgent(message));
}

function removalAllowed(message: string, line: AgentLine, pending: AgentPending | null): boolean {
  if (!removalVerb(message)) return false;
  if (lineMentioned(message, line)) return true;
  const pronoun = /\b(quitamelo|quitamela|quitalo|quitala)\b/.test(foldAgent(message));
  if (!pronoun || !pending) return false;
  if (line.productId != null && pending.candidateIds.includes(line.productId)) return true;
  return lineMentioned(pending.question, line);
}

function sameCartIdentity(existing: AgentLine, next: { productId: number | null; name: string; qty: number; unit: AgentUnit; freeText: string | null }): boolean {
  if (existing.qty !== next.qty || existing.unit !== next.unit) return false;
  if (next.productId != null && existing.productId === next.productId) return true;
  if (next.freeText && existing.freeText && foldAgent(existing.freeText) === foldAgent(next.freeText)) return true;
  return foldAgent(existing.name) === foldAgent(next.name);
}

function clarifyShortType(name: string, cart: AgentLine[]): { name: string; variant: string | null } | null {
  const folded = foldAgent(name);
  if (!/^(de\s+)?(harina|maiz)$/.test(folded)) return null;
  const tortillas = cart.filter((line) => groceryFamily(`${line.name} ${line.freeText ?? ""}`) === "tortilla");
  if (tortillas.length !== 1) return null;
  if (/\bharina\b/.test(folded)) return { name: "Tortillas de harina", variant: "de harina" };
  return { name: "Tortillas de maíz", variant: "de maíz" };
}

export function validateToolCall(params: {
  call: ToolCall;
  store: AgentStore;
  products: AgentProduct[];
  cart: AgentLine[];
  pending: AgentPending | null;
  nextLineId: string;
  searches?: AgentSearchHit[];
  customerMessage?: string;
  askedThisTurn?: boolean;
}): ToolVerdict {
  const { call, store, products, cart, pending } = params;
  const searches = params.searches ?? [];
  const args = call.arguments ?? {};
  if (args.store_id != null && Number(args.store_id) !== store.id) {
    return { ok: false, error: "No se cambia de tienda en este pedido. Sigue en la tienda actual." };
  }

  if (call.name === "search_products") {
    const query = String(args.query ?? "").trim();
    if (!query || isOrderVerbOnly(query)) {
      return { ok: false, error: "Esa búsqueda no trae un producto. Quita palabras como pedí, quiero o dame." };
    }
    return { ok: true };
  }

  if (call.name === "remove_line") {
    const lineId = String(args.line_id ?? "").trim();
    const productId = Number(args.product_id);
    const freeText = foldAgent(String(args.free_text ?? ""));
    const line = cart.find((item) => {
      if (lineId && item.lineId === lineId) return true;
      if (Number.isFinite(productId) && item.productId === productId) return true;
      return Boolean(freeText) && foldAgent(item.freeText ?? item.name) === freeText;
    });
    if (!line) return { ok: false, error: "Esa línea no está en el carrito." };
    if (params.customerMessage && !removalAllowed(params.customerMessage, line, pending)) {
      return { ok: false, error: "El cliente no pidió quitar esa línea. No la borres." };
    }
    return { ok: true, removedId: line.lineId };
  }

  if (call.name === "ask_customer") {
    let text = String(args.text ?? "").trim();
    if (!text) return { ok: false, error: "La pregunta va con texto." };
    if (pending && sameQuestion(text, pending.question)) {
      return { ok: false, error: "Esa pregunta ya se hizo. Usa la respuesta del cliente, no la repitas." };
    }
    let ids = Array.isArray(args.candidate_ids) ? args.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)) : [];
    let axis = axisOf(text, args.axis);
    const askedQty = Number(args.qty);
    const askedUnit = asAgentUnit(args.unit);
    const qty = Number.isFinite(askedQty) && askedQty > 0 ? askedQty : null;
    let query: string | null = null;
    let queue: AgentClarification[] | undefined;
    const groups = store.hasProductList ? mixedAskGroups(text, ids, searches) : [];
    const parts = doubtParts(text);
    // En tienda con lista, varios productos en el mismo ask_customer no se muestran juntos.
    // Se pregunta el primero, con sus opciones reales, y el resto espera.
    if (store.hasProductList && groups.length > 1) {
      const [first, ...rest] = groups;
      const head = clarificationOf(first.query, first.products, qty, askedUnit, axis);
      text = head.question;
      ids = head.candidateIds;
      axis = head.axis;
      query = head.query ?? null;
      queue = rest.map((group) => clarificationOf(group.query, group.products, null, null, null));
    } else if (store.hasProductList && parts.length > 1) {
      text = parts[0];
      axis = axisOf(text, args.axis);
    }
    if (axis && ids.length && !candidatesDiffer(products, ids, axis)) {
      return {
        ok: false,
        error: "Esas opciones no se diferencian en ese eje. No preguntes. Anota la que sí existe.",
      };
    }
    if (axis === "marinade" && !ids.length) {
      const named = products.filter((product) => foldAgent(text).includes(foldAgent(product.name).split(" ")[0] ?? "___"));
      if (named.length && !candidatesDiffer(products, named.map((product) => product.id), "marinade")) {
        return { ok: false, error: "No hay versión marinada y normal de ese corte. No preguntes eso." };
      }
    }
    return {
      ok: true,
      question: {
        question: text,
        candidateIds: ids,
        qty,
        unit: askedUnit,
        axis,
        query,
        queue,
      },
    };
  }

  if (call.name === "finish_cart") {
    const missingVariant = cart.find((line) => {
      if (line.productId == null) return false;
      const product = products.find((item) => item.id === line.productId);
      return Boolean(product && product.variants.length && !line.variant);
    });
    if (missingVariant) {
      return { ok: false, error: `A ${missingVariant.name} le falta el sabor o la variante. Pregúntalo o anótalo.` };
    }
    if (store.catalogMode === "list" && store.category === "abarrotes" && !store.hasProductList) {
      const vague = cart.find((line) => line.productId == null && groceryClarityError(line));
      if (vague) {
        const detail = groceryClarityError(vague);
        return { ok: false, error: detail ?? `A ${vague.name} le falta marca, tipo o tamaño.` };
      }
    }
    return { ok: true, finished: true };
  }

  if (call.name !== "set_cart_line") {
    return { ok: false, error: "Herramienta desconocida." };
  }

  let qty = Number(args.qty);
  let unit = asAgentUnit(args.unit);
  const variantText = clean(args.variant);
  const noteText = clean(args.note);
  const brandText = clean(args.brand);
  const presentationText = clean(args.presentation);
  const replaceId = clean(args.line_id);
  let productId = args.product_id == null ? null : Number(args.product_id);
  const rawFree = args.free_text == null ? null : String(args.free_text).trim() || null;
  let freeText = rawFree;
  if (freeText && isOrderVerbOnly(freeText)) {
    return { ok: false, error: "«Pedí», «quiero» o «dame» no son un producto." };
  }
  if (freeText) freeText = stripOrderVerbs(freeText) || freeText;

  let parsedName: string | null = null;
  let parsedBrand: string | null = null;
  let parsedPresentation: string | null = null;
  let parsedVariant: string | null = variantText;
  let parsedNote: string | null = noteText;
  if (freeText && store.category === "abarrotes") {
    const parsed = parseGroceryFreeText(freeText);
    const clarified = clarifyShortType(parsed.name, cart);
    parsedName = clarified?.name ?? parsed.name;
    parsedVariant = clarified?.variant ?? parsed.variant ?? variantText;
    parsedBrand = brandText ?? parsed.brand;
    parsedPresentation = presentationText ?? parsed.presentation;
    parsedNote = noteText ?? parsed.note;
    const prior = cart.find(
      (item) => item.productId == null && sameGroceryLine(item, { name: parsedName ?? "", freeText: parsedName }),
    );
    if (parsed.qty != null) qty = parsed.qty;
    else if (prior) qty = prior.qty;
    if (parsed.unit) unit = parsed.unit;
    else if (prior && parsed.qty == null) unit = prior.unit;
    freeText = parsedName || freeText;
  }

  if (!unit) return { ok: false, error: "La unidad tiene que ser pz, kg, pesos, g o l (litros)." };
  if (!saneQty(unit, qty)) return { ok: false, error: "La cantidad no es válida para esa unidad." };

  if (store.category !== "abarrotes" && freeText && isGenericDogoText(freeText)) {
    const clasico = genericDogoProduct(products);
    if (clasico) {
      productId = clasico.id;
      freeText = null;
    }
  }

  if (productId != null && Number.isFinite(productId)) {
    const product = products.find((item) => item.id === productId);
    if (!product || !product.available) {
      return { ok: false, error: `El producto ${productId} no está en esta tienda.` };
    }
    const spoken = params.customerMessage ? spokenMeasure(params.customerMessage, product.name) : null;
    const namedSize = presentationFromName(product.name)?.key ?? "";
    const sizeAlreadyNamed = Boolean(
      spoken && namedSize && (
        (spoken.unit === "l" && (namedSize.endsWith("l") || namedSize.endsWith("ml")))
        || (spoken.unit === "kg" && (namedSize.endsWith("kg") || namedSize.endsWith("g")))
      ),
    );
    if (spoken && unit === "pz" && !sizeAlreadyNamed && (spoken.unit === "kg" || spoken.unit === "l" || spoken.unit === "pesos")) {
      unit = spoken.unit;
      qty = spoken.qty;
      if (!saneQty(unit, qty)) return { ok: false, error: "La cantidad no es válida para esa unidad." };
    }
    if (!unit) return { ok: false, error: "La unidad tiene que ser pz, kg, pesos, g o l (litros)." };
    const settledUnit = unit;
    const mustSearch = store.hasProductList || store.catalogMode === "fixed";
    let siblings: AgentProduct[] = [];
    if (mustSearch) {
      const already = cart.some((line) => line.productId === productId);
      const hit = searchContaining(searches, productId);
      if (!already && !hit) {
        return { ok: false, error: "Busca con search_products antes de anotar ese producto." };
      }
      siblings = hit?.products ?? [];
      if (!already && params.customerMessage && marinadeUnresolved(product, products, params.customerMessage)) {
        return { ok: false, error: "Hay versión marinada y normal. Pregunta con ask_customer (axis marinade). No elijas una tú." };
      }
      if (!already && optionsDiffer(siblings) && !messageSelects(product, siblings, params.customerMessage ?? "")) {
        return { ok: false, error: listedChoiceError(siblings) };
      }
      const piece = Boolean(params.customerMessage && isPieceCorrection(params.customerMessage));
      const clause = params.customerMessage ? foldAgent(productClause(params.customerMessage, product.name)) : "";
      const saidPack = !piece && /\b(cajas?|paquetes?)\b/.test(clause);
      if (!already && packInName(product) && !saidPack) {
        return { ok: false, error: "Es caja o paquete. Pregunta si la quiere así o en pieza." };
      }
      const wanted = clause ? spokenPackageSize(clause) : null;
      const namedKey = presentationFromName(product.name)?.key ?? "";
      if (!already && wanted && namedKey && namedKey !== wanted) {
        return { ok: false, error: "El tamaño no es el que dijo el cliente. Pregunta las presentaciones reales." };
      }
    }
    if (store.catalogMode === "fixed" && !(typeof product.price === "number" && product.price > 0)) {
      return { ok: false, error: `${product.name} no tiene precio. No lo anotes.` };
    }
    if (!unitAllowed(store, product, settledUnit)) {
      return { ok: false, error: `${product.name} no se vende en ${settledUnit}.` };
    }
    const named = parsedVariant ? `${product.name} ${parsedVariant}` : product.name;
    const unchangedProduct = cart.some((item) =>
      sameCartIdentity(item, { productId: product.id, name: named, qty, unit: settledUnit, freeText: null }),
    );
    const lineReplace = replaceId || (params.customerMessage ? replacementLineId(cart, product, params.customerMessage) : null);
    const pieceSwap = Boolean(lineReplace && params.customerMessage && isPieceCorrection(params.customerMessage));
    const onlyHit = siblings.length === 1 && siblings[0].id === product.id;
    if (
      params.customerMessage
      && !unchangedProduct
      && !pieceSwap
      && !productMentioned(params.customerMessage, product)
      && !(onlyHit && uniqueHitMentioned(product, params.customerMessage))
    ) {
      return { ok: false, error: `El cliente no pidió ${optionLabel(product)}. No lo agregues.` };
    }
    if (product.variants.length) {
      const variant = matchVariant(product, parsedVariant ?? (params.customerMessage ? variantFromMessage(product.variants, params.customerMessage) : null));
      if (!variant) {
        return { ok: false, error: `${product.name} necesita una de estas variantes: ${product.variants.join(", ")}.` };
      }
      return {
        ok: true,
        line: lineFromProduct(params.nextLineId, product, qty, settledUnit, variant, parsedNote, lineReplace),
      };
    }
    return {
      ok: true,
      line: lineFromProduct(params.nextLineId, product, qty, settledUnit, null, parsedNote, lineReplace),
    };
  }

  if (!freeText) return { ok: false, error: "Falta product_id o el texto del producto." };
  if (store.catalogMode === "fixed" || store.category !== "abarrotes") {
    const near = closestAgentProducts(products, freeText, 2).map((product) => product.name);
    const suggestion = near.length ? ` Lo más cercano: ${near.join(" o ")}.` : "";
    const customerNote = `*${freeText}* no lo manejamos.${suggestion}`;
    return {
      ok: false,
      error: `No está en el menú: "${freeText}".${suggestion} Dile al cliente que no lo manejamos y ofrece eso. No lo anotes.`,
      customerNote,
    };
  }

  const name = parsedName || freeText.replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (store.hasProductList) {
    const hit = searchForText(searches, `${freeText} ${name}`);
    if (!hit) {
      return { ok: false, error: "Busca con search_products antes de anotar ese producto." };
    }
    if (hit.products.length === 1) {
      return { ok: false, error: `Está en la lista. Anótalo con product_id ${hit.products[0].id} (${optionLabel(hit.products[0])}).` };
    }
    if (hit.products.length > 1) {
      return { ok: false, error: listedChoiceError(hit.products) };
    }
    const alreadyAsked = params.askedThisTurn === true || Boolean(pending);
    if (!alreadyAsked) {
      return {
        ok: false,
        error: "No está en la lista. Pregunta con ask_customer u ofrece lo más cercano. Si el cliente lo quiere así, en el siguiente turno anótalo con free_text.",
      };
    }
  }

  const draft: AgentLine = {
    lineId: replaceId || params.nextLineId,
    productId: null,
    freeText,
    name,
    qty,
    unit,
    variant: parsedVariant,
    note: parsedNote,
    unitPrice: null,
    brand: parsedBrand,
    presentation: parsedPresentation,
  };
  if (!store.hasProductList) {
    const clarity = groceryClarityError(draft);
    if (clarity) return { ok: false, error: clarity };
  }
  const unchangedText = cart.some((item) =>
    sameCartIdentity(item, { productId: null, name, qty, unit, freeText }),
  );
  if (
    params.customerMessage &&
    !unchangedText &&
    !textMentionsAny(params.customerMessage, freeText) &&
    !textMentionsAny(params.customerMessage, name) &&
    !(rawFree && textMentionsAny(params.customerMessage, rawFree))
  ) {
    return { ok: false, error: "El cliente no pidió ese producto. No lo agregues." };
  }
  return { ok: true, line: draft };
}

function lineFromProduct(
  lineId: string,
  product: AgentProduct,
  qty: number,
  unit: AgentUnit,
  variant: string | null,
  note: string | null,
  replaceId: string | null,
): AgentLine {
  return {
    lineId: replaceId || lineId,
    productId: product.id,
    freeText: null,
    name: variant ? `${product.name} ${variant}` : product.name,
    qty,
    unit,
    variant,
    note,
    unitPrice: product.price,
    brand: product.brand,
    presentation: product.presentation,
  };
}

export function upsertLine(cart: AgentLine[], line: AgentLine): AgentLine[] {
  const byId = cart.findIndex((item) => item.lineId === line.lineId);
  const index = byId >= 0
    ? byId
    : cart.findIndex((item) => {
        if (line.productId != null && item.productId === line.productId && (item.variant ?? null) === (line.variant ?? null) && item.unit === line.unit) {
          return true;
        }
        if (line.freeText != null && item.freeText != null && foldAgent(item.freeText) === foldAgent(line.freeText)) return true;
        return line.productId == null && item.productId == null && sameGroceryLine(item, line);
      });
  if (index < 0) return [...cart, line];
  const next = cart.slice();
  next[index] = { ...line, lineId: cart[index].lineId };
  return next;
}
