/**
 * Chequeo local de copy y del ruteo de filtros/menú. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-customer-ux.ts
 */
import { buildCustomerMessage } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import { normalizeWhatsAppText } from "../src/lib/waapi";
import {
  buildGreeting,
  classifyCustomerTurn,
  customerCopySplitsFee,
  formatCatalogCategories,
  formatCatalogMenu,
  formatCustomerQuoteMessage,
  formatNicheStoreList,
  formatPreConfirmFeeNote,
  nicheIdForCategoria,
  replyClaimsMissingMenu,
  type UxStore,
} from "../src/lib/customerUx";
import { CUSTOMER_STORE_NICHES } from "../src/lib/customerUx";
import { MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "../src/lib/ordenes";

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const zagu: UxStore = {
  id: 1,
  nombre: "ZAGU",
  categoria: "Abarrotes",
  telefono: "5213311111111",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const george: UxStore = {
  id: 7,
  nombre: "Hamburguesas Hotdogs George",
  categoria: "Restaurante",
  telefono: "5213322222222",
  abierta: false,
  abreTexto: "abre mañana a las 7pm",
  usaCatalogoFijo: true,
};
const taqueria: UxStore = {
  id: 3,
  nombre: "Tacos el Grillo",
  categoria: "taqueria",
  telefono: "5213333333333",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const stores = [zagu, george, taqueria];

assert(MANDALO_SERVICE_FEE === 10 && MANDALO_DELIVERY_FEE === 25, "el desglose interno sigue 10+25");
assert(CUSTOMER_STORE_NICHES.length === 2, "hoy el cliente solo ve dos nichos");
assert(nicheIdForCategoria("Abarrotes") === "abarrotes", "ZAGU/Abarrotes");
assert(nicheIdForCategoria("Restaurante") === "restaurantes", "George/Restaurante");
assert(nicheIdForCategoria("Hamburguesas y hotdogs") === "restaurantes", "alias hamburguesas");
assert(nicheIdForCategoria("nicho:restaurantes") === "restaurantes", "categoria explícita");
assert(nicheIdForCategoria("taqueria") === null, "taquería queda fuera hasta que exista el nicho");

const greeting = buildGreeting(new Date("2026-10-02T20:00:00Z"));
assert(greeting.includes("1. Tiendas de abarrotes"), "filtro abarrotes");
assert(greeting.includes("2. Restaurantes"), "filtro restaurantes");
assert(greeting.includes("\n"), "el saludo trae saltos de línea");
assert(!customerCopySplitsFee(greeting), "el saludo no parte el cargo");

assert(classifyCustomerTurn({ message: "hola", lastBotText: "", hasBusiness: false, hasItems: false, businessId: null, stores }).type === "greeting", "hola → saludo");
assert(classifyCustomerTurn({ message: "2", lastBotText: greeting, hasBusiness: false, hasItems: false, businessId: null, stores }).type === "show_niche", "2 → restaurantes");
const abarrotesList = formatNicheStoreList(CUSTOMER_STORE_NICHES[0], stores);
assert(abarrotesList.includes("ZAGU"), "abarrotes incluye a ZAGU");
assert(!abarrotesList.includes("George"), "abarrotes no mezcla restaurantes");
assert(abarrotesList.includes("más $35 de envío y servicio"), "abarrotes avisa que la tienda cotiza más $35");

const listed = formatNicheStoreList(CUSTOMER_STORE_NICHES[1], stores);
assert(listed.includes("Hamburguesas Hotdogs George"), "lista de restaurantes incluye a George");
assert(listed.includes("abre mañana a las 7pm"), "la cerrada se puede programar");
assert(!listed.includes("Tacos el Grillo"), "la taquería no se cuela en restaurantes");
assert(listed.includes("$35"), "la lista avisa el cargo junto");
assert(!customerCopySplitsFee(listed), "la lista no parte $10+$25");

const picked = classifyCustomerTurn({
  message: "1",
  lastBotText: listed,
  hasBusiness: false,
  hasItems: false,
  businessId: null,
  stores,
});
assert(picked.type === "pick_store" && picked.type === "pick_store" && picked.store.nombre.includes("George"), "1 en la lista elige a George");

const categories = formatCatalogCategories(george, ["Hamburguesas", "Hotdogs"]);
assert(categories.includes("1. Hamburguesas"), "categorías en líneas");
assert(!replyClaimsMissingMenu(categories), "la plantilla no dice que falta el menú");
assert(replyClaimsMissingMenu("Aún no tengo el menú cargado"), "detecta el texto prohibido");

const menu = formatCatalogMenu("Hamburguesas Hotdogs George", "Hamburguesas", [
  { nombre: "Hamburguesa sencilla", precio: 55 },
  { nombre: "Hamburguesa hawaiana", precio: 70 },
]);
assert(menu.includes("Hamburguesa sencilla — $55"), "precio real");
assert(menu.includes("\n"), "menú con saltos de línea");
assert(normalizeWhatsAppText(menu).includes("\n"), "WhatsApp conserva los saltos");
assert(normalizeWhatsAppText(menu).includes("Hamburguesa hawaiana — $70"), "el precio sobrevive el normalizador");

const afterMenu = classifyCustomerTurn({
  message: "quiero la hamburguesa sencilla",
  lastBotText: menu,
  hasBusiness: true,
  hasItems: false,
  businessId: george.id,
  stores,
});
assert(afterMenu.type === "continue", "con el menú ya en pantalla, el producto sigue al flujo normal");

const hamburguesa = classifyCustomerTurn({
  message: "una hamburguesa",
  lastBotText: listed,
  hasBusiness: false,
  hasItems: false,
  businessId: null,
  stores,
});
assert(hamburguesa.type === "ask_category", "hamburguesa en restaurantes pide el menú de esa categoría");

const quote = formatCustomerQuoteMessage({ tiendaNombre: "ZAGU", pedidoId: 12, subtotal: 80, total: 115 });
assert(quote.includes("Envío y servicio: $35"), "cotización con $35 junto");
assert(quote.includes("Total a pagar: $115"), "total = subtotal + 35");
assert(!quote.includes("$10"), "el cliente no ve $10");
assert(!quote.includes("$25"), "el cliente no ve $25");
assert(!customerCopySplitsFee(quote), "la cotización no parte el cargo");

const abarrotesSnapshot = {
  businessId: 1,
  businessName: "ZAGU",
  addressText: "Calle Hidalgo 12, frente a la tortillería",
  addressZone: "Calle Hidalgo",
  items: [{ nombre_producto: "Takis Fuego", presentacion: "56g", cantidad: 1 }],
};
const receipt = buildCustomerMessage({
  validation: validateCaptureForConfirmation({
    snapshot: abarrotesSnapshot,
    items: abarrotesSnapshot.items,
    knownZoneNames: ["Calle Hidalgo"],
  }),
  snapshot: abarrotesSnapshot,
  items: abarrotesSnapshot.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(receipt.includes("La tienda cotiza tus productos, más $35 de envío y servicio."), "recibo de abarrotes antes del SÍ");
assert(!receipt.includes("$10"), "el recibo no parte el cargo");
assert(receipt.includes("\n"), "el recibo conserva saltos de línea");

const catalogSnapshot = {
  businessId: 7,
  businessName: "Hamburguesas Hotdogs George",
  addressText: "Calle Hidalgo 12, frente a la tortillería",
  addressZone: "Calle Hidalgo",
  items: [{ nombre_producto: "Hamburguesa sencilla", cantidad: 1 }],
};
const catalogReceipt = buildCustomerMessage({
  validation: validateCaptureForConfirmation({
    snapshot: catalogSnapshot,
    items: catalogSnapshot.items,
    knownZoneNames: ["Calle Hidalgo"],
  }),
  snapshot: catalogSnapshot,
  items: catalogSnapshot.items,
  feeNote: formatPreConfirmFeeNote("catalogo"),
});
assert(catalogReceipt.includes("Envío y servicio: $35"), "recibo de catálogo con $35");
assert(catalogReceipt.includes("Hamburguesa sencilla"), "el recibo trae el producto");

console.log("\n--- Transcripción de ejemplo ---\n");
console.log("CLIENTE: hola\n");
console.log("MÁNDALO:\n" + greeting + "\n");
console.log("CLIENTE: 2\n");
console.log("MÁNDALO:\n" + listed + "\n");
console.log("CLIENTE: George\n");
console.log("MÁNDALO:\n" + categories + "\n");
console.log("CLIENTE: hamburguesas\n");
console.log("MÁNDALO:\n" + menu + "\n");
console.log("CLIENTE: (después de cotizar)\n");
console.log("MÁNDALO:\n" + quote + "\n");
console.log("RECIBO ANTES DEL PRIMER SÍ:\n" + receipt + "\n");
console.log("check-customer-ux: ok");
