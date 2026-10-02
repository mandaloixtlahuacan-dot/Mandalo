/**
 * Copy y decisiones deterministas del cliente (filtros, listas, menú, $35).
 *
 * WhatsApp se lleva mal con listas armadas por la IA: el modelo aplana saltos
 * de línea y, un turno después de elegir tienda, el catálogo a veces todavía
 * no está inyectado en el prompt. Estas plantillas salen del backend con
 * newlines reales y con datos de `tiendas` / `productos_tienda`.
 *
 * Nichos nuevos (farmacia, ferretería, taquería): agrega un objeto a
 * CUSTOMER_STORE_NICHES y etiqueta la tienda en `tiendas.categoria` con un
 * alias de ese nicho, o con el valor exacto `nicho:<id>`. No hace falta
 * hardcodear el nombre del negocio.
 */

import { formatMoney, MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "@/lib/ordenes";

export const CUSTOMER_FACING_FEE = MANDALO_SERVICE_FEE + MANDALO_DELIVERY_FEE;

export type StoreNicheId = string;

export type StoreNiche = {
  id: StoreNicheId;
  /** Texto que ve el cliente en el filtro. */
  label: string;
  /**
   * Frases cortas con las que elige este nicho. No incluyas palabras sueltas
   * que también sean productos ("papas", "agua").
   */
  choicePhrases: string[];
  /**
   * Valores normalizados de `tiendas.categoria` que caen aquí. Se comparan
   * por texto completo o por palabra, de la frase más larga a la más corta.
   */
  categoriaAliases: string[];
};

export const CUSTOMER_STORE_NICHES: StoreNiche[] = [
  {
    id: "abarrotes",
    label: "Tiendas de abarrotes",
    choicePhrases: [
      "tiendas de abarrotes",
      "tienda de abarrotes",
      "abarrotes",
      "abarrote",
      "de la tienda",
      "algo de la tienda",
    ],
    categoriaAliases: [
      "tiendas de abarrotes",
      "tienda de abarrotes",
      "abarrotes",
      "abarrote",
      "minisuper",
      "mini super",
    ],
  },
  {
    id: "restaurantes",
    label: "Restaurantes",
    choicePhrases: ["restaurantes", "restaurante", "comida preparada", "antojo de comida", "para comer"],
    categoriaAliases: [
      "comida preparada",
      "restaurantes",
      "restaurante",
      "hamburguesas",
      "hamburguesa",
      "hot dogs",
      "hotdogs",
      "hotdog",
    ],
  },
];

export const UX_STORE_LIST_MARKER = "¿De cuál te hago el mandado?";
export const UX_CATEGORY_MARKER = "¿Cuál categoría te late?";
export const UX_MENU_MARKER = "¿Cuál te encargo?";

export type UxStore = {
  id: number;
  nombre: string;
  categoria: string | null;
  telefono: string;
  abierta: boolean;
  /** "abre mañana a las 8am" cuando está cerrada; vacío si está abierta. */
  abreTexto: string;
  usaCatalogoFijo: boolean;
};

export type CustomerTurn =
  | { type: "greeting" }
  | { type: "show_niche"; nicheId: StoreNicheId }
  | { type: "pick_store"; store: UxStore }
  | { type: "ask_menu"; store: UxStore | null }
  | { type: "ask_category"; store: UxStore | null; hint: string }
  | { type: "continue" };

export function normalizeUxText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[¿?¡!.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatCustomerFeeLine(): string {
  return `Envío y servicio: ${formatMoney(CUSTOMER_FACING_FEE)}`;
}

export function formatPreConfirmFeeNote(mode: "catalogo" | "cotiza_tienda"): string {
  if (mode === "catalogo") return formatCustomerFeeLine();
  return `La tienda cotiza tus productos, más ${formatMoney(CUSTOMER_FACING_FEE)} de envío y servicio.`;
}

export function formatCustomerQuoteMessage(params: {
  tiendaNombre: string;
  pedidoId: number;
  subtotal: number;
  total: number;
}): string {
  const tienda = params.tiendaNombre.trim() || "la tienda";
  return (
    `Este es el total de tu pedido en *${tienda}*:\n\n` +
    `Pedido #${params.pedidoId}\n` +
    `Subtotal: ${formatMoney(params.subtotal)}\n` +
    `${formatCustomerFeeLine()}\n` +
    `*Total a pagar: ${formatMoney(params.total)}*\n\n` +
    `¿Confirmas tu pedido? Responde *SÍ* ✅`
  );
}

export function customerCopySplitsFee(text: string): boolean {
  const t = normalizeUxText(text);
  const mentionsServiceSlice = t.includes("servicio mandalo") || /\$\s*10\b/.test(text);
  const mentionsDeliverySlice = /\benvio\b/.test(t) && /\$\s*25\b/.test(text);
  return mentionsServiceSlice && mentionsDeliverySlice;
}

function hourInMexico(now: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/Mexico_City" }).format(now),
  );
}

export function buildGreeting(now = new Date()): string {
  const hour = hourInMexico(now);
  const franja = hour >= 6 && hour < 12 ? "¡Buenos días!" : hour >= 12 && hour < 19 ? "¡Buenas tardes!" : "¡Buenas noches!";
  const options = CUSTOMER_STORE_NICHES.map((niche, index) => `${index + 1}. ${niche.label}`).join("\n");
  return (
    `${franja} Soy Mándalo, yo te hago el mandado. 🛵\n\n` +
    `¿Qué se te antoja?\n\n` +
    `${options}\n\n` +
    `Responde con el número o el nombre.`
  );
}

export function nicheById(id: string): StoreNiche | null {
  return CUSTOMER_STORE_NICHES.find((niche) => niche.id === id) ?? null;
}

export function nicheIdForCategoria(categoria: string | null | undefined): StoreNicheId | null {
  const normalized = normalizeUxText(categoria ?? "");
  if (!normalized) return null;

  const explicit = normalized.match(/^nicho:([a-z0-9_-]+)$/);
  if (explicit) {
    return CUSTOMER_STORE_NICHES.some((niche) => niche.id === explicit[1]) ? explicit[1] : null;
  }

  const ranked = CUSTOMER_STORE_NICHES.flatMap((niche) =>
    niche.categoriaAliases.map((alias) => ({ nicheId: niche.id, alias: normalizeUxText(alias) })),
  ).sort((a, b) => b.alias.length - a.alias.length);

  for (const { nicheId, alias } of ranked) {
    if (!alias) continue;
    if (normalized === alias) return nicheId;
    const pattern = new RegExp(`(?:^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
    if (pattern.test(normalized)) return nicheId;
  }
  return null;
}

export function storesInNiche(stores: UxStore[], nicheId: StoreNicheId): UxStore[] {
  return stores
    .filter((store) => nicheIdForCategoria(store.categoria) === nicheId)
    .sort((a, b) => Number(b.abierta) - Number(a.abierta) || a.nombre.localeCompare(b.nombre, "es"));
}

export function formatNicheStoreList(niche: StoreNiche, stores: UxStore[]): string {
  const mine = storesInNiche(stores, niche.id);
  if (!mine.length) {
    return (
      `Ahorita no tengo ${niche.label.toLowerCase()} activas.\n\n` +
      `Si quieres, prueba el otro. Responde con el número o el nombre.`
    );
  }

  const lines = mine.map((store, index) => {
    if (store.abierta) return `${index + 1}. ${store.nombre}`;
    const when = store.abreTexto ? `, ${store.abreTexto}` : "";
    return `${index + 1}. ${store.nombre} (cerrada${when})`;
  });

  const fee =
    niche.id === "abarrotes"
      ? `La tienda cotiza tus productos, más ${formatMoney(CUSTOMER_FACING_FEE)} de envío y servicio.`
      : `El menú trae precio, más ${formatMoney(CUSTOMER_FACING_FEE)} de envío y servicio.`;

  return `${niche.label}:\n\n${lines.join("\n")}\n\n${fee}\n\n${UX_STORE_LIST_MARKER}`;
}

export function formatAbarrotesStoreAck(store: UxStore): string {
  const closed = store.abierta
    ? ""
    : `\n\nOjo: está cerrada ahora${store.abreTexto ? ` (${store.abreTexto})` : ""}. Lo armamos igual y se manda en cuanto abra.`;
  return (
    `Va, de ${store.nombre}. Dime qué se te antoja, con marca y tamaño si puedes.${closed}\n\n` +
    `La tienda cotiza y se suman ${formatMoney(CUSTOMER_FACING_FEE)} de envío y servicio.`
  );
}

export function formatCatalogCategories(store: UxStore, categories: string[]): string {
  const closed = store.abierta
    ? ""
    : `\n\nOjo: está cerrada ahora${store.abreTexto ? ` (${store.abreTexto})` : ""}. Lo armamos igual y se manda en cuanto abra.`;
  const lines = categories.map((category, index) => `${index + 1}. ${category}`).join("\n");
  return (
    `Va, de ${store.nombre}. Te armo el mandado.${closed}\n\n` +
    `${UX_CATEGORY_MARKER}\n\n` +
    `${lines}\n\n` +
    `${formatCustomerFeeLine()}, aparte del menú.`
  );
}

export function formatCatalogMenu(storeName: string, category: string, items: Array<{ nombre: string; precio: number }>): string {
  const lines = items.map((item) => `- ${item.nombre} — ${formatMoney(item.precio)}`).join("\n");
  return `${category} en ${storeName}:\n\n${lines}\n\n${formatCustomerFeeLine()}, aparte.\n\n${UX_MENU_MARKER}`;
}

export function formatNoFixedMenu(storeName: string): string {
  return (
    `${storeName} no trae menú fijo. Dime el producto, la marca y el tamaño, y la tienda lo cotiza.\n\n` +
    `${formatCustomerFeeLine()}.`
  );
}

export function replyClaimsMissingMenu(text: string): boolean {
  const t = normalizeUxText(text);
  if (!t) return false;
  return (
    /no tengo (el |su )?(menu|catalogo)/.test(t) ||
    /menu (aun |todavia )?no (esta |lo tengo )?(cargado|listo)/.test(t) ||
    /aun no (tengo|cargo) (el |su )?(menu|catalogo)/.test(t) ||
    /todavia no (tengo|cargo) (el |su )?(menu|catalogo)/.test(t) ||
    t.includes("no tiene categorias de catalogo") ||
    t.includes("no tiene categorias") ||
    t.includes("menu no cargado") ||
    t.includes("catalogo no cargado")
  );
}

const GREETING_ONLY =
  /^(hola+|hey|buenas( tardes| noches| dias)?|buenos dias|buen dia|que onda|quiubo|kiubo|q onda|mandalo|epa|que tal)( mandalo)?$/;

const BARE_START =
  /^(quiero pedir|quiero hacer un pedido|hacer un pedido|un mandado|se me antoja( algo)?|que me recomiendas|a ver)$/;

const MENU_QUESTION =
  /^(que tienes|que venden|que hay|que me ofreces|que traes|menu|ver menu|cual es el menu|pasame el menu)\b/;

const CATEGORY_HINTS: Array<{ hint: string; pattern: RegExp }> = [
  { hint: "hamburguesa", pattern: /\bhamburguesas?\b/ },
  { hint: "hotdog", pattern: /\bhot\s*dogs?\b|\bhotdogs?\b|\bdogos?\b|\bdogo\b/ },
];

function parseLeadingNumber(message: string): number | null {
  const match = normalizeUxText(message).match(/^(?:opcion|la|el|numero)?\s*(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function matchNicheChoice(message: string): StoreNiche | null {
  const text = normalizeUxText(message);
  if (!text) return null;

  const asNumber = parseLeadingNumber(message);
  if (asNumber != null) return CUSTOMER_STORE_NICHES[asNumber - 1] ?? null;

  if (text.length > 48) return null;
  const ranked = CUSTOMER_STORE_NICHES.flatMap((niche) =>
    niche.choicePhrases.map((phrase) => ({ niche, phrase: normalizeUxText(phrase) })),
  ).sort((a, b) => b.phrase.length - a.phrase.length);

  for (const { niche, phrase } of ranked) {
    if (text === phrase || text.endsWith(` ${phrase}`) || text.startsWith(`${phrase} `) || text.includes(phrase)) {
      return niche;
    }
  }
  return null;
}

export function lastBotAskedForNiche(lastBot: string): boolean {
  return CUSTOMER_STORE_NICHES.every((niche) => lastBot.includes(niche.label)) && lastBot.includes("Responde con el número o el nombre.");
}

export function nicheListedInLastBot(lastBot: string): StoreNiche | null {
  if (!lastBot.includes(UX_STORE_LIST_MARKER)) return null;
  return CUSTOMER_STORE_NICHES.find((niche) => lastBot.includes(`${niche.label}:`)) ?? null;
}

function textMentionsStore(text: string, nombre: string): boolean {
  const haystack = normalizeUxText(text);
  const needle = normalizeUxText(nombre);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  const tokens = needle.split(" ").filter((word) => word.length >= 4);
  return tokens.some((word) => new RegExp(`(?:^|\\s)${word}(?:\\s|$)`).test(haystack));
}

export function singleStoreMentioned(text: string, stores: UxStore[]): UxStore | null {
  const hits = stores.filter((store) => textMentionsStore(text, store.nombre));
  if (hits.length !== 1) return null;
  return hits[0];
}

function messageIsStorePickOnly(message: string, store: UxStore): boolean {
  let rest = normalizeUxText(message);
  const nombre = normalizeUxText(store.nombre);
  if (nombre) rest = rest.replace(nombre, " ");
  for (const token of nombre.split(" ").filter((word) => word.length >= 4)) {
    rest = rest.replace(new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, "g"), " ");
  }
  rest = rest
    .replace(/\b(de|del|la|el|en|quiero|pedir|manda|mandado|porfa|por favor|va)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return rest.length < 3;
}

function categoryHintIn(message: string): string | null {
  const text = normalizeUxText(message);
  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(text)) return hint.hint;
  }
  return null;
}

export function categoryChosenFromLastBot(lastBot: string, message: string): string | null {
  if (!lastBot.includes(UX_CATEGORY_MARKER)) return null;
  const asNumber = parseLeadingNumber(message);
  if (asNumber == null) return null;
  const line = lastBot.split("\n").find((row) => row.startsWith(`${asNumber}. `));
  if (!line) return null;
  return line.slice(`${asNumber}. `.length).trim() || null;
}

export function matchCategoriasEnTexto(categorias: string[], texto: string): string[] {
  const t = normalizeUxText(texto);
  const compactText = t.replace(/\s+/g, "");
  return categorias.filter((cat) => {
    const c = normalizeUxText(cat);
    if (!c || c === "otros") return false;
    if (t.includes(c)) return true;
    const singular = c.endsWith("s") ? c.slice(0, -1) : c;
    if (singular.length > 3 && t.includes(singular)) return true;
    const compactCategory = c.replace(/\s+/g, "");
    const compactSingular = singular.replace(/\s+/g, "");
    return (
      (compactCategory.length > 3 && compactText.includes(compactCategory)) ||
      (compactSingular.length > 3 && compactText.includes(compactSingular))
    );
  });
}

function isGreetingMessage(message: string): boolean {
  return GREETING_ONLY.test(normalizeUxText(message));
}

function isMenuQuestion(message: string): boolean {
  const text = normalizeUxText(message);
  if (MENU_QUESTION.test(text)) return true;
  return text.length <= 80 && /\b(menu|que tienes|que venden|que traes)\b/.test(text);
}

export function classifyCustomerTurn(params: {
  message: string;
  lastBotText: string;
  hasBusiness: boolean;
  hasItems: boolean;
  businessId: number | null;
  stores: UxStore[];
}): CustomerTurn {
  const { message, lastBotText, hasItems, businessId, stores } = params;
  const hasBusiness = params.hasBusiness || (businessId != null && businessId > 0);

  const storeFromMessage = singleStoreMentioned(message, stores);
  const storeFromId = businessId != null ? (stores.find((store) => store.id === businessId) ?? null) : null;
  const storeFromLastBot = singleStoreMentioned(lastBotText, stores);
  const focusedStore = storeFromMessage ?? storeFromId ?? storeFromLastBot;

  const listedNiche = nicheListedInLastBot(lastBotText);
  if (!hasItems && listedNiche) {
    const asNumber = parseLeadingNumber(message);
    if (asNumber != null) {
      const picked = storesInNiche(stores, listedNiche.id)[asNumber - 1];
      if (picked) return { type: "pick_store", store: picked };
    }
    if (storeFromMessage && messageIsStorePickOnly(message, storeFromMessage)) {
      return { type: "pick_store", store: storeFromMessage };
    }
  }

  const numberedCategory = categoryChosenFromLastBot(lastBotText, message);
  if (numberedCategory) {
    return { type: "ask_category", store: focusedStore, hint: numberedCategory };
  }

  const hint = categoryHintIn(message);
  const restaurantContext =
    focusedStore?.usaCatalogoFijo === true ||
    listedNiche?.id === "restaurantes" ||
    (!hasBusiness && !hasItems);
  // Si ya le mostramos el menú con precios, lo que sigue es el producto, no otra lista.
  const alreadyShowingMenu = lastBotText.includes(UX_MENU_MARKER);
  if (hint && restaurantContext && !alreadyShowingMenu) {
    return { type: "ask_category", store: focusedStore, hint };
  }

  if (isMenuQuestion(message)) {
    return { type: "ask_menu", store: focusedStore };
  }

  if (!hasItems && !hasBusiness && lastBotAskedForNiche(lastBotText)) {
    const niche = matchNicheChoice(message);
    if (niche) return { type: "show_niche", nicheId: niche.id };
    if (storeFromMessage && messageIsStorePickOnly(message, storeFromMessage)) {
      return { type: "pick_store", store: storeFromMessage };
    }
    if (normalizeUxText(message).length <= 16) return { type: "greeting" };
  }

  if (!hasItems && !hasBusiness && (isGreetingMessage(message) || BARE_START.test(normalizeUxText(message)))) {
    return { type: "greeting" };
  }

  if (!hasItems && !hasBusiness) {
    const niche = matchNicheChoice(message);
    if (niche && normalizeUxText(message).length <= 40) return { type: "show_niche", nicheId: niche.id };
    if (storeFromMessage && messageIsStorePickOnly(message, storeFromMessage)) {
      return { type: "pick_store", store: storeFromMessage };
    }
  }

  return { type: "continue" };
}

export function uniqueCatalogCategories(categorias: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of categorias) {
    const clean = String(raw ?? "").trim();
    const key = normalizeUxText(clean);
    if (!key || key === "otros" || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result.sort((a, b) => a.localeCompare(b, "es"));
}
