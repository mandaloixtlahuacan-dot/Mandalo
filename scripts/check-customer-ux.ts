/**
 * Chequeo local de copy y del ruteo de filtros/menú. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-customer-ux.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { buildMandaloSystemPrompt } from "../src/lib/mandaloPrompt";
import { priceCatalogOrder, reconcileCatalogQuantities } from "../src/lib/catalogQuantities";
import { applyCatalogSpeech } from "../src/lib/catalogOrderSpeech";
import { CARNICERIA_LA_CENTRAL_MENU_PNG, CARNICERIA_LA_CENTRAL_PRODUCTOS, CARNICERIA_MENU_IMAGE_ENV } from "../src/lib/carniceriaLaCentralCatalog";
import { catalogMenuPngRelative } from "../src/lib/catalogMenuImage";
import { ADDRESS_ASK_MESSAGE, buildCustomerMessage, dispatchItemAlreadyShowsQty, formatProductListConfirm, formatSpecificItemLine, mergeSnapshot, type PedidoItemInput } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import { confirmationCustomerMessage, planConfirmationAmendment } from "../src/lib/confirmationAmendment";
import { classifyProductListReply, isBareOrderRejection, isComplaintMessage, isNoConfirmation, isProductListRequest, isYesConfirmation, shouldEscalateComplaint } from "../src/lib/messages";
import { normalizeWhatsAppText } from "../src/lib/waapi";
import {
  buildGreeting,
  classifyCustomerTurn,
  formatAbarrotesStoreAck,
  customerCopySplitsFee,
  formatCatalogCategories,
  formatCatalogMenu,
  catalogMenuImageKind,
  catalogUsesMenuImage,
  formatCatalogMenuCaption,
  formatCatalogOrderRegistered,
  formatCatalogReceiptFee,
  formatCourierCancelNotice,
  formatCustomerQuoteMessage,
  formatQuoteOrderRegistered,
  formatNicheStoreList,
  formatPreConfirmFeeNote,
  nicheIdForCategoria,
  renderCustomerTurn,
  replyBlamesStoreForMissingMenu,
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
const laCentral: UxStore = {
  id: 11,
  nombre: "Carnicería La Central",
  categoria: "Carnicerías",
  telefono: "5213344444444",
  abierta: false,
  abreTexto: "abre mañana a las 9am",
  usaCatalogoFijo: true,
};
const stores = [zagu, george, taqueria, laCentral];

assert(MANDALO_SERVICE_FEE === 0 && MANDALO_DELIVERY_FEE === 25, "el desglose interno es 0 de Mándalo y 25 del repartidor");
assert(MANDALO_SERVICE_FEE + MANDALO_DELIVERY_FEE === 25, "servicio y envío suman el $25 del cliente");
assert(CUSTOMER_STORE_NICHES.length === 3, "el cliente ve abarrotes, restaurantes y carnicerías");
assert(nicheIdForCategoria("Abarrotes") === "abarrotes", "ZAGU/Abarrotes");
assert(nicheIdForCategoria("Restaurante") === "restaurantes", "George/Restaurante");
assert(nicheIdForCategoria("Hamburguesas y hotdogs") === "restaurantes", "alias hamburguesas");
assert(nicheIdForCategoria("nicho:restaurantes") === "restaurantes", "categoria explícita");
assert(nicheIdForCategoria("Carnicerías") === "carnicerias", "La Central/Carnicerías");
assert(nicheIdForCategoria("carniceria") === "carnicerias", "alias carniceria");
assert(nicheIdForCategoria("nicho:carnicerias") === "carnicerias", "categoria explícita de carnicería");
assert(nicheIdForCategoria("taqueria") === null, "taquería queda fuera hasta que exista el nicho");

const greeting = buildGreeting(new Date("2026-10-02T20:00:00Z"));
assert(
  greeting ===
    `👋 *¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.*

Con gusto pido en la tienda, el restaurante o la carnicería que me digas y te lo llevo a la puerta.

*¿De dónde quieres?*

1. *Abarrotes*

2. *Restaurantes*

3. *Carnicerías*`,
  "el saludo es el texto aprobado",
);
assert(buildGreeting(new Date("2026-10-02T15:00:00Z")) === greeting, "de mañana el saludo no cambia");
assert(buildGreeting(new Date("2026-10-03T05:00:00Z")) === greeting, "de noche el saludo no cambia");
assert(!greeting.includes("Tiendas de abarrotes"), "el saludo ya no lista Tiendas de abarrotes");
assert(!greeting.includes("Tú dime el antojo y yo lo consigo."), "ya no usa el saludo de mandadero por hora");
assert(!greeting.includes("$35") && !greeting.includes("$25") && !greeting.includes("efectivo") && !greeting.includes("Abro de"), "el saludo no trae precio, horario ni pago");
assert(greeting.replace(/\*/g, "").trimEnd().endsWith("3. Carnicerías"), "el saludo termina en las tres opciones");
assert(!greeting.includes("Pícale al número o al nombre."), "ya no pide picarle al número");
assert(greeting.includes("\n"), "el saludo trae saltos de línea");
assert(!customerCopySplitsFee(greeting), "el saludo no parte el cargo");

function nicheFromGreeting(message: string) {
  const turn = classifyCustomerTurn({ message, lastBotText: greeting, hasBusiness: false, hasItems: false, businessId: null, stores });
  return turn.type === "show_niche" ? turn.nicheId : "";
}

assert(classifyCustomerTurn({ message: "hola", lastBotText: "", hasBusiness: false, hasItems: false, businessId: null, stores }).type === "greeting", "hola → saludo");
assert(nicheFromGreeting("1") === "abarrotes", "1 → abarrotes");
assert(nicheFromGreeting("2") === "restaurantes", "2 → restaurantes");
assert(nicheFromGreeting("3") === "carnicerias", "3 → carnicerías");
assert(nicheFromGreeting("Abarrotes") === "abarrotes", "Abarrotes elige abarrotes");
assert(nicheFromGreeting("Restaurantes") === "restaurantes", "Restaurantes elige restaurantes");
assert(nicheFromGreeting("Carnicerías") === "carnicerias", "Carnicerías elige carnicerías");
assert(nicheFromGreeting("carniceria") === "carnicerias", "carniceria elige carnicerías");
const oldGreeting =
  "¡Buenas tardes! Soy Mándalo, yo te hago el mandado. 🛵\n\n¿Qué se te antoja?\n\n1. Tiendas de abarrotes\n2. Restaurantes\n\nPícale al número o al nombre.";
assert(classifyCustomerTurn({ message: "1", lastBotText: oldGreeting, hasBusiness: false, hasItems: false, businessId: null, stores }).type === "show_niche", "un saludo viejo todavía acepta el 1");
const abarrotesList = formatNicheStoreList(CUSTOMER_STORE_NICHES[0], stores);
assert(abarrotesList.includes("ZAGU"), "abarrotes incluye a ZAGU");
assert(!abarrotesList.includes("George"), "abarrotes no mezcla restaurantes");
assert(abarrotesList.includes("más $25 de envío y servicio"), "abarrotes avisa que la tienda cotiza más $25");

const listed = formatNicheStoreList(CUSTOMER_STORE_NICHES[1], stores);
assert(listed.includes("Hamburguesas Hotdogs George"), "lista de restaurantes incluye a George");
assert(listed.includes("abre mañana a las 7pm"), "la cerrada se puede programar");
assert(!listed.includes("Tacos el Grillo"), "la taquería no se cuela en restaurantes");
assert(!listed.includes("Carnicería"), "restaurantes no mezcla carnicerías");
assert(!abarrotesList.includes("Carnicería"), "abarrotes no mezcla carnicerías");
assert(listed.includes("$25"), "la lista avisa el cargo junto");
assert(!customerCopySplitsFee(listed), "la lista no parte $10+$25");

const carniceriaNiche = CUSTOMER_STORE_NICHES.find((niche) => niche.id === "carnicerias");
assert(carniceriaNiche != null, "existe el nicho carnicerías");
const carniceriasList = formatNicheStoreList(carniceriaNiche!, stores);
assert(carniceriasList.includes("Carnicería La Central"), "carnicerías lista solo a La Central");
assert(carniceriasList.includes("abre mañana a las 9am"), "La Central cerrada se puede programar");
assert(!carniceriasList.includes("George"), "carnicerías no mezcla a George");
assert(!carniceriasList.includes("ZAGU"), "carnicerías no mezcla abarrotes");
assert(carniceriasList.includes("más $25 de envío y servicio") || carniceriasList.includes("$25"), "carnicerías avisa el cargo junto");
assert(!customerCopySplitsFee(carniceriasList), "carnicerías no parte $10+$25");
assert((carniceriasList.match(/^\d+\. /gm) ?? []).length === 1, "en carnicerías solo aparece La Central");
const carniceriaAbierta = formatNicheStoreList(carniceriaNiche!, [{ ...laCentral, abierta: true, abreTexto: "" }]);
assert(carniceriaAbierta.includes("Carnicería La Central") && !carniceriaAbierta.includes("cerrada"), "abierta no dice cerrada");
const pickedCentral = classifyCustomerTurn({
  message: "1",
  lastBotText: carniceriasList,
  hasBusiness: false,
  hasItems: false,
  businessId: null,
  stores,
});
assert(
  pickedCentral.type === "pick_store" && pickedCentral.store.id === laCentral.id,
  "1 en carnicerías elige a La Central",
);
const centralMenu = renderCustomerTurn(pickedCentral, stores, carniceriasList);
assert(centralMenu?.kind === "menu" && centralMenu.store.id === laCentral.id, "elegir La Central manda el menú como George");
assert(
  centralMenu != null && centralMenu.kind === "menu" && centralMenu.text.includes("$25") && !centralMenu.text.includes("$35") && !customerCopySplitsFee(centralMenu.text),
  "el menú de La Central cobra $25 junto",
);
assert(catalogUsesMenuImage(laCentral) && catalogMenuImageKind(laCentral) === "carniceria-la-central", "La Central usa el mismo camino de foto que George");
assert(catalogMenuPngRelative("carniceria-la-central") === CARNICERIA_LA_CENTRAL_MENU_PNG, "la foto espera el PNG de Víctor");
assert(CARNICERIA_MENU_IMAGE_ENV === "CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL", "la URL de la foto es opcional");
assert(existsSync(CARNICERIA_LA_CENTRAL_MENU_PNG) && statSync(CARNICERIA_LA_CENTRAL_MENU_PNG).size > 20_000, "está la foto del menú de La Central");
const centralPng = readFileSync(CARNICERIA_LA_CENTRAL_MENU_PNG);
assert(
  centralPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "la foto de La Central es un PNG",
);
const centralSinFoto = formatCatalogMenuCaption(laCentral, { photo: false });
assert(!/foto/i.test(centralSinFoto) && centralSinFoto.includes("nombre del menú"), "sin foto no promete la imagen");
assert(centralSinFoto.includes("cerrada"), "sin foto también avisa si está cerrada");
const centralMenuText = centralMenu != null && centralMenu.kind === "menu" ? centralMenu.text : "";

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
assert(categories.includes("1. *Hamburguesas*"), "categorías en líneas");
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
assert(hamburguesa.type === "ask_menu", "hamburguesa ya no pide categoría: manda el menú");

const locationAsk =
  "🏠 ¿Me compartes tu ubicación por GPS? Es lo más fácil y rápido.\n\n" +
  "Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara.";
const dogosExtra = classifyCustomerTurn({
  message: "Y también dos dogos clásicos",
  lastBotText: locationAsk,
  hasBusiness: true,
  hasItems: true,
  businessId: george.id,
  stores,
});
assert(dogosExtra.type === "continue", "con productos en el carrito, dos dogos no reenvían el menú");

const anotoMarYTierra =
  "Anoto:\n• Hamburguesa Mar y Tierra Chica — 1 pieza\n\n¿Quieres grande o chica? ¿Solo una o más?";
const sumaGeorge =
  "Quiero una hamburguesa, mar y tierra chica También me gustaría un refresco, una Pepsi y un dogo de Arrachera";
const sumaConCarrito = classifyCustomerTurn({
  message: sumaGeorge,
  lastBotText: anotoMarYTierra,
  hasBusiness: true,
  hasItems: true,
  businessId: george.id,
  stores,
});
assert(sumaConCarrito.type === "continue", "con productos, repetir la hamburguesa y sumar Pepsi y dogo no reenvía la foto");
const sumaSinGuardar = classifyCustomerTurn({
  message: sumaGeorge,
  lastBotText: anotoMarYTierra,
  hasBusiness: true,
  hasItems: false,
  businessId: george.id,
  stores,
});
assert(
  sumaSinGuardar.type === "continue",
  "si el anoto no se guardó, Pepsi y el dogo de arrachera tampoco reenvían la foto",
);
assert(renderCustomerTurn(sumaConCarrito, stores, anotoMarYTierra) == null, "ese turno no arma la foto del menú");

const pideMenu = classifyCustomerTurn({
  message: "pásame el menú",
  lastBotText: locationAsk,
  hasBusiness: true,
  hasItems: true,
  businessId: george.id,
  stores,
});
assert(pideMenu.type === "ask_menu", "pásame el menú sigue mandando la foto aunque ya haya productos");

const queVenden = classifyCustomerTurn({
  message: "qué venden",
  lastBotText: locationAsk,
  hasBusiness: true,
  hasItems: true,
  businessId: george.id,
  stores,
});
assert(queVenden.type === "ask_menu", "qué venden sigue mandando la foto aunque ya haya productos");

const dogosSinCarrito = classifyCustomerTurn({
  message: "dos dogos",
  lastBotText: listed,
  hasBusiness: false,
  hasItems: false,
  businessId: null,
  stores,
});
assert(dogosSinCarrito.type === "ask_menu", "sin productos, dogos sigue abriendo el menú");

const caption = formatCatalogMenuCaption(george);
assert(/te paso el menú/i.test(caption), "al elegir el restaurante se avisa que va el menú");
assert(caption.includes("Te paso el menú de"), "la foto se anuncia, no se lista");
assert(!/quieres que te pase el menú/i.test(caption), "no pregunta antes de mandar el menú");
assert(!caption.toLowerCase().includes("categoría"), "el pie de la foto no pide categoría");
assert(caption.includes("$25") && !caption.includes("$35"), "el pie avisa el envío de $25");
assert(
  (existsSync("public/menus/george.png") && statSync("public/menus/george.png").size > 20_000) ||
    (existsSync("public/menus/george.png.b64") && statSync("public/menus/george.png.b64").size > 20_000) ||
    existsSync("public/menus/george.b64.00"),
  "existe la foto del menú de George",
);
const georgeChunks = readdirSync("public/menus")
  .filter((name) => /^george\.b64\.\d{2}$/.test(name))
  .sort();
if (georgeChunks.length) {
  const encoded = georgeChunks.map((name) => readFileSync(`public/menus/${name}`, "utf8")).join("");
  const png = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
  assert(
    png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "los trozos del menú de George arman un PNG",
  );
  assert(png.length > 100_000, "la foto del menú de George no está vacía");
}

const switched = classifyCustomerTurn({
  message: "George",
  lastBotText: "Va, de ZAGU. Dime qué se te antoja.",
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores,
});
assert(switched.type === "pick_store" && switched.type === "pick_store" && switched.store.id === george.id, "decir George suelta a ZAGU");

const menuAfterSwitch = classifyCustomerTurn({
  message: "¿tienes menú?",
  lastBotText: caption,
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores,
});
assert(
  menuAfterSwitch.type === "ask_menu" && menuAfterSwitch.type === "ask_menu" && menuAfterSwitch.store?.id === george.id,
  "después de la foto, el menú es de George aunque el pedido viejo diga ZAGU",
);

const stillZagu = classifyCustomerTurn({
  message: "¿tienes menú?",
  lastBotText: "Va, de ZAGU. Dime qué se te antoja.",
  hasBusiness: true,
  hasItems: false,
  businessId: zagu.id,
  stores,
});
assert(stillZagu.type === "ask_menu" && stillZagu.type === "ask_menu" && stillZagu.store?.id === zagu.id, "sin cambio de tienda, el menú sigue en ZAGU");

function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}
function blamesZagu(text: string): boolean {
  return replyBlamesStoreForMissingMenu(text, "ZAGU") || /zagu no tiene men/i.test(text) || /la tienda zagu no tiene men/i.test(text);
}

const zaguAck = formatAbarrotesStoreAck(zagu);
assert(zaguAck.includes("Va, de ZAGU"), "el aviso de abarrotes sigue anclando la tienda");
function emojisPerLine(text: string): number {
  return Math.max(0, ...text.split("\n").map((line) => (line.match(/\p{Extended_Pictographic}/gu) ?? []).length));
}
assert(emojiCount(greeting) === 1, "el saludo lleva un emoji");
assert(emojisPerLine(zaguAck) <= 2, "cada línea del aviso lleva a lo mucho la palomita y un emoji");
assert(emojisPerLine(listed) <= 1 && emojiCount(caption) >= 1 && emojisPerLine(caption) <= 2, "la lista y el menú no amontonan emojis");

const pickedMenu = renderCustomerTurn(picked, stores, listed);
assert(pickedMenu?.kind === "menu" && pickedMenu.store.id === george.id, "elegir el restaurante de la lista manda el menú al momento");
assert(pickedMenu?.kind === "menu" && /te paso el menú/i.test(pickedMenu.text), "al elegirlo dice que pasa el menú");
assert(pickedMenu?.kind === "menu" && !/quieres que te pase/i.test(pickedMenu.text), "elegirlo no pregunta si quiere el menú");

const namedFromZagu = classifyCustomerTurn({
  message: "quiero de George",
  lastBotText: zaguAck,
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores,
});
assert(namedFromZagu.type === "pick_store" && namedFromZagu.store.id === george.id, "nombrar a George suelta a ZAGU");
const namedMenu = renderCustomerTurn(namedFromZagu, stores, zaguAck);
assert(namedMenu?.kind === "menu" && namedMenu.store.id === george.id, "nombrar el restaurante manda su menú al momento");
assert(namedMenu?.kind === "menu" && /te paso el menú/i.test(namedMenu.text), "al nombrarlo dice que pasa el menú");
assert(namedMenu?.kind === "menu" && !blamesZagu(namedMenu.text), "nombrar a George no contesta que Zagu no tiene menú");
const namedSnapshot = mergeSnapshot({
  currentSnapshot: {
    businessId: zagu.id,
    businessName: "ZAGU",
    businessPhone: zagu.telefono,
    items: [{ nombre_producto: "Takis Fuego", cantidad: 1 }],
  },
  llmOrderState: {
    business_id: namedFromZagu.type === "pick_store" ? namedFromZagu.store.id : 0,
    business_name: namedFromZagu.type === "pick_store" ? namedFromZagu.store.nombre : "",
    business_phone: namedFromZagu.type === "pick_store" ? namedFromZagu.store.telefono : "",
    items: [],
  },
  forceBusiness: true,
  forceReplaceItems: true,
});
assert(namedSnapshot.businessId === george.id, "la tienda activa pasa de ZAGU a George");
assert((namedSnapshot.items ?? []).length === 0, "los productos de ZAGU no se quedan al nombrar el restaurante");

const antojoGeorge = classifyCustomerTurn({
  message: "una hamburguesa en George",
  lastBotText: zaguAck,
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores,
});
assert(antojoGeorge.type === "pick_store" && antojoGeorge.store.id === george.id, "nombrar a George con el antojo también cambia la tienda");
const antojoMenu = renderCustomerTurn(antojoGeorge, stores, zaguAck);
assert(antojoMenu?.kind === "menu" && !blamesZagu(antojoMenu.text), "el antojo con nombre de restaurante manda el menú y no culpa a Zagu");

const acceptedRestaurant = classifyCustomerTurn({
  message: "quiero un restaurante",
  lastBotText: zaguAck,
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores,
});
assert(
  acceptedRestaurant.type === "pick_store" && acceptedRestaurant.store.id === george.id,
  "si solo hay un restaurante, aceptar la categoría lo elige sin escribir el nombre",
);
const acceptedMenu = renderCustomerTurn(acceptedRestaurant, stores, zaguAck);
assert(acceptedMenu?.kind === "menu" && acceptedMenu.rememberStore.id === george.id, "aceptar restaurantes con una sola tienda manda ese menú");
assert(acceptedMenu?.kind === "menu" && !blamesZagu(acceptedMenu.text), "el cambio de categoría no contesta que Zagu no tiene menú");
const acceptedSnapshot = mergeSnapshot({
  currentSnapshot: {
    businessId: zagu.id,
    businessName: "ZAGU",
    businessPhone: zagu.telefono,
    items: [{ nombre_producto: "Mayonesa", cantidad: 1 }],
  },
  llmOrderState: {
    business_id: george.id,
    business_name: george.nombre,
    business_phone: george.telefono,
    items: [],
  },
  forceBusiness: true,
  forceReplaceItems: true,
});
assert(acceptedSnapshot.businessId === george.id, "aceptar la categoría reemplaza la tienda activa");
assert((acceptedSnapshot.items ?? []).length === 0, "aceptar la categoría limpia el carrito de ZAGU");

const bareNumber = classifyCustomerTurn({
  message: "2",
  lastBotText: zaguAck,
  hasBusiness: true,
  hasItems: false,
  businessId: zagu.id,
  stores,
});
assert(bareNumber.type === "continue", "un 2 suelto en ZAGU no cambia de categoría");

const pizza: UxStore = {
  id: 8,
  nombre: "Pizza Lucía",
  categoria: "Restaurante",
  telefono: "5213344444444",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: true,
};
const several = [zagu, george, pizza];
const toSeveral = classifyCustomerTurn({
  message: "restaurantes",
  lastBotText: zaguAck,
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores: several,
});
assert(toSeveral.type === "switch_niche" && toSeveral.nicheId === "restaurantes", "con varios restaurantes se ofrece la lista");
const severalReply = renderCustomerTurn(toSeveral, several, zaguAck);
assert(severalReply?.kind === "text" && severalReply.clearActiveStore, "la lista suelta la tienda anterior");
assert(severalReply?.kind === "text" && severalReply.text.includes("Pizza Lucía") && severalReply.text.includes("George"), "la lista trae los restaurantes");
assert(severalReply?.kind === "text" && !blamesZagu(severalReply.text) && !severalReply.text.includes("ZAGU"), "la lista no contesta como si siguieran en ZAGU");
const cleared = mergeSnapshot({
  currentSnapshot: {
    businessId: zagu.id,
    businessName: "ZAGU",
    businessPhone: zagu.telefono,
    items: [{ nombre_producto: "Takis Fuego", cantidad: 1 }],
    raw: { businessId: zagu.id, business_name: "ZAGU" },
  },
  llmOrderState: { items: [] },
  clearBusiness: true,
  forceReplaceItems: true,
});
assert(cleared.businessId == null && cleared.businessName == null, "soltar la categoría deja la tienda activa vacía");
assert((cleared.items ?? []).length === 0, "soltar la categoría no conserva productos de ZAGU");
assert(cleared.raw?.businessId == null, "el raw tampoco sigue diciendo ZAGU");

const pickFromSeveral = classifyCustomerTurn({
  message: "1",
  lastBotText: severalReply?.kind === "text" ? severalReply.text : "",
  hasBusiness: true,
  hasItems: true,
  businessId: zagu.id,
  stores: several,
});
assert(pickFromSeveral.type === "pick_store" && pickFromSeveral.store.id === pizza.id, "el número de la lista nueva elige ese restaurante");
const pickSeveralMenu = renderCustomerTurn(pickFromSeveral, several, severalReply?.kind === "text" ? severalReply.text : "");
assert(pickSeveralMenu?.kind === "menu" && pickSeveralMenu.store.id === pizza.id, "elegir de la lista manda ese menú al momento");
assert(pickSeveralMenu?.kind === "menu" && /te paso el menú/i.test(pickSeveralMenu.text) && !blamesZagu(pickSeveralMenu.text), "ese menú no habla de ZAGU");
const pickedSnapshot = mergeSnapshot({
  currentSnapshot: cleared,
  llmOrderState: {
    business_id: pizza.id,
    business_name: pizza.nombre,
    business_phone: pizza.telefono,
    items: [],
  },
  forceBusiness: true,
  forceReplaceItems: true,
});
assert(pickedSnapshot.businessId === pizza.id, "al elegir el restaurante la tienda activa ya no es ZAGU");
assert(replyClaimsMissingMenu("No veo el menú de hamburguesas cargado"), "detecta el menú que la IA dice no ver");
assert(replyClaimsMissingMenu("el menú fijo pero no me diste categoría"), "detecta el filtro de categoría");

const switchedSnapshot = mergeSnapshot({
  currentSnapshot: {
    businessId: zagu.id,
    businessName: "ZAGU",
    businessPhone: "5213311111111",
    items: [{ nombre_producto: "Takis Fuego", cantidad: 1 }],
  },
  llmOrderState: {
    business_id: george.id,
    business_name: george.nombre,
    business_phone: george.telefono,
    items: [],
  },
  forceBusiness: true,
  forceReplaceItems: true,
});
assert(switchedSnapshot.businessId === george.id, "el snapshot cambia a George");
assert(String(switchedSnapshot.businessName).includes("George"), "el nombre largo de George gana");
assert((switchedSnapshot.items ?? []).length === 0, "los productos de ZAGU no se quedan");

const quote = formatCustomerQuoteMessage({ tiendaNombre: "ZAGU", pedidoId: 12, subtotal: 80, total: 105 });
assert(quote.includes("Envío y servicio: $25"), "cotización con $25 junto");
assert(quote.includes("Total a pagar: $105"), "total = subtotal + 25");
assert(!/\$10\b/.test(quote), "el cliente no ve $10");
assert(!/\$35\b/.test(quote), "el cliente no ve el cargo viejo");
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
    quoteStore: true,
  }),
  snapshot: abarrotesSnapshot,
  items: abarrotesSnapshot.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(receipt.includes("La tienda cotiza tus productos, más $25 de envío y servicio."), "recibo de abarrotes antes del SÍ");
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
  feeNote: formatCatalogReceiptFee(60),
  pricedLines: "- Hamburguesa sencilla — $60",
});
assert(catalogReceipt.includes("Envío y servicio: $25") && !catalogReceipt.includes("$35"), "recibo de catálogo con $25");
assert(catalogReceipt.includes("Hamburguesa sencilla — $60"), "el recibo trae el precio del producto");
assert(catalogReceipt.includes("Total: $85"), "el recibo suma producto + envío");

const quoteBase = {
  businessId: 1,
  businessName: "ZAGU",
  addressText: "Calle Hidalgo 12, frente a la tortillería",
  addressZone: "Calle Hidalgo",
};
const zones = ["Calle Hidalgo"];

function quoteCheck(items: PedidoItemInput[], userMessage: string) {
  return validateCaptureForConfirmation({
    snapshot: { ...quoteBase, items },
    items,
    knownZoneNames: zones,
    quoteStore: true,
    userMessage,
  });
}

function questionOf(userMessage: string, items: PedidoItemInput[] = []) {
  const result = quoteCheck(items, userMessage);
  const question = result.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
  return { result, question };
}

const leche = questionOf("dos litros de leche");
assert(!leche.result.readyForConfirmation, "dos litros de leche no se cierra");
assert(leche.question.includes("Lala") && leche.question.includes("Alpura") && leche.question.includes("Santa Clara"), "la leche ofrece marcas de ejemplo");
assert(leche.question.includes("entera") && leche.question.includes("deslactosada") && leche.question.includes("light"), "la leche pide el tipo");
assert(!leche.question.includes("cuántos litros"), "si ya dijo los litros, no se vuelven a pedir");
assert(leche.question.includes("mandado"), "la pregunta sigue el mandado");
assert(!leche.question.includes("Tiendas de abarrotes") && !leche.question.toLowerCase().includes("menú"), "no reenvía menú ni filtros");
assert((leche.question.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 2, "la pregunta no se llena de emojis");
assert(leche.result.validatedItems.items[0]?.nombre_producto === "Leche", "guarda la leche parcial");
assert(leche.result.validatedItems.items[0]?.marca == null, "todavía no inventa marca");

const zaguNoEsMarca = questionOf("de zagu dos litros de leche");
assert(zaguNoEsMarca.question.includes("Lala"), "el nombre de la tienda no cuenta como marca");
assert(zaguNoEsMarca.result.validatedItems.items[0]?.marca == null, "ZAGU no se guarda como marca");

const lecheLista = quoteCheck([{ nombre_producto: "Leche", cantidad: 2, unidad: "litros" }], "Lala entera");
assert(lecheLista.validatedItems.allItemsSpecific, "Lala entera completa la leche");
assert(lecheLista.readyForConfirmation, "con tienda y dirección, la leche lista pasa a confirmar");
assert(/lala/i.test(String(lecheLista.validatedItems.items[0]?.marca)), "guarda la marca que dijo");
assert(/entera/i.test(String(lecheLista.validatedItems.items[0]?.presentacion)), "guarda el tipo");

const santaClara = quoteCheck([], "dos litros de leche Santa Clara deslactosada");
assert(santaClara.validatedItems.allItemsSpecific, "Santa Clara deslactosada no es lista cerrada: vale");
assert(/santa clara/i.test(String(santaClara.validatedItems.items[0]?.marca)), "junta la marca de dos palabras");

const cualquierLeche = quoteCheck([{ nombre_producto: "Leche", cantidad: 2, unidad: "litros" }], "del que sea");
assert(cualquierLeche.readyForConfirmation, "del que sea no sigue preguntando");
assert(cualquierLeche.validatedItems.items[0]?.notas === "la que sea", "anota que la tienda escoge");
assert(cualquierLeche.validatedItems.items[0]?.cantidad === 2, "del que sea conserva los litros que ya dijo");
const lecheDelQueSea = quoteCheck([], "dos litros de leche del que sea");
assert(lecheDelQueSea.readyForConfirmation, "leche del que sea no sigue preguntando");
assert(lecheDelQueSea.validatedItems.items[0]?.cantidad === 2, "del que sea no tira el tamaño");
assert(lecheDelQueSea.validatedItems.items[0]?.notas === "la que sea", "del que sea queda en la nota");
assert(!cualquierLeche.issues.some((issue) => issue.customerQuestion), "del que sea no trae otra pregunta");

const laQueSea = quoteCheck([{ nombre_producto: "Leche", cantidad: 2, unidad: "litros" }], "la que sea");
assert(laQueSea.validatedItems.items[0]?.notas === "la que sea", "la que sea se anota");
const cualquiera = quoteCheck([{ nombre_producto: "Leche", cantidad: 2, unidad: "litros" }], "cualquiera");
assert(cualquiera.validatedItems.items[0]?.notas === "la que sea", "cualquiera se anota como la que sea");
const barata = quoteCheck([{ nombre_producto: "Leche", cantidad: 2, unidad: "litros" }], "la más barata");
assert(barata.readyForConfirmation, "la más barata cierra la línea");
assert(barata.validatedItems.items[0]?.notas === "la más barata", "la más barata se anota tal cual");

const papel = questionOf("un paquete de papel higiénico");
assert(!papel.result.readyForConfirmation, "un paquete de papel no alcanza");
assert(papel.question.includes("Pétalo"), "el paquete sin marca pide la marca");
assert(!/rollos/i.test(papel.question), "si ya dijo paquete, no pide rollos");
const papelSinCorte = questionOf("papel higiénico Pétalo");
assert(!papelSinCorte.result.readyForConfirmation, "Pétalo sin caja ni rollos todavía pide la presentación");
assert(/caja/i.test(papelSinCorte.question) && /rollos/i.test(papelSinCorte.question), "sin presentación pregunta caja, paquete o rollos una vez");
assert(!/de qué marca/i.test(papelSinCorte.question), "Pétalo ya es la marca");

const papelMarca = questionOf("Pétalo de 18", [{ nombre_producto: "Papel higiénico", cantidad: 1, unidad: "paquete" }]);
assert(papelMarca.result.validatedItems.allItemsSpecific, "Pétalo de 18 cierra el papel");
assert(/18 rollos/i.test(String(papelMarca.result.validatedItems.items[0]?.presentacion)), "guarda los rollos");

const agua = questionOf("un agua natural de litro");
assert(!agua.result.readyForConfirmation, "el agua de litro pide marca");
assert(agua.question.includes("Ciel") && agua.question.includes("Bonafont") && agua.question.includes("Epura"), "el agua ofrece marcas de ejemplo");
assert(!agua.question.includes("garrafón"), "si ya dijo litro, no pregunta garrafón");
assert(!agua.question.includes("entera"), "el agua no pide tipo de leche");

const aguaLista = quoteCheck([{ nombre_producto: "Agua", presentacion: "natural", cantidad: 1, unidad: "litro" }], "Ciel");
assert(aguaLista.validatedItems.allItemsSpecific, "Ciel cierra el agua");

const coca = questionOf("una coca");
assert(coca.question.includes("lata") && coca.question.includes("litros"), "la coca pide tamaño");
assert(!coca.question.includes("de qué marca"), "si ya dijo Coca, no pide otra marca");
const cocaLista = quoteCheck([], "una coca de 600");
assert(cocaLista.validatedItems.allItemsSpecific, "coca de 600 ya se puede cotizar");

const juntos = quoteCheck([], "dos litros de leche y un paquete de papel higiénico");
assert(juntos.validatedItems.items.length === 2, "leche y papel se anotan los dos");
assert(juntos.validatedItems.items[0]?.cantidad === 2, "los dos litros no se vuelven uno");
assert(juntos.validatedItems.items[0]?.nombre_producto === "Leche", "pregunta primero la leche");
const preguntaJuntos = juntos.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(preguntaJuntos.includes("Lala") && !preguntaJuntos.includes("Pétalo"), "un mensaje pregunta solo el primer producto");

const tresAbarrotes =
  "una caja de Sanitas, también un paquete de arroz higiénico de la marca Sam's, y un litro de Pinol.";
function assertTresProductos(seed: PedidoItemInput[], etiqueta: string) {
  const separado = quoteCheck(seed, tresAbarrotes);
  const lineas = separado.validatedItems.items;
  assert(lineas.length === 3, `${etiqueta}: el mensaje queda en tres productos`);
  const sanitas = lineas.find((item) => /sanitas/i.test(String(item.marca)));
  const sams = lineas.find((item) => /sam/i.test(String(item.marca)));
  const pinol = lineas.find((item) => /pinol/i.test(`${item.nombre_producto} ${item.marca ?? ""}`));
  assert(Boolean(sanitas && sams && pinol), `${etiqueta}: Sanitas, Sam's y Pinol van aparte`);
  assert(/papel/i.test(sanitas?.nombre_producto ?? ""), `${etiqueta}: Sanitas es papel higiénico`);
  assert(sanitas?.cantidad === 1 && /caja/i.test(String(sanitas?.unidad)), `${etiqueta}: Sanitas queda en una caja`);
  assert(!/arroz/i.test(sams?.nombre_producto ?? ""), `${etiqueta}: arroz higiénico no se guarda como arroz`);
  assert(/papel/i.test(sams?.nombre_producto ?? ""), `${etiqueta}: el de Sam's es papel higiénico`);
  assert(sams?.cantidad === 1 && /paquete/i.test(String(sams?.unidad)), `${etiqueta}: el de Sam's queda en un paquete`);
  assert(
    !/sanitas|pinol/i.test(`${sams?.nombre_producto ?? ""} ${sams?.marca ?? ""}`),
    `${etiqueta}: el papel de Sam's no hereda las otras marcas`,
  );
  assert(/limpiador/i.test(pinol?.nombre_producto ?? ""), `${etiqueta}: Pinol es limpiador`);
  assert(/pinol/i.test(String(pinol?.marca)), `${etiqueta}: Pinol queda como marca`);
  assert(
    pinol?.cantidad === 1 && /litro/i.test(`${pinol?.unidad ?? ""} ${pinol?.presentacion ?? ""}`),
    `${etiqueta}: Pinol queda en un litro`,
  );
  assert(
    !/sanitas|arroz|sam/i.test(`${pinol?.nombre_producto ?? ""} ${pinol?.marca ?? ""}`),
    `${etiqueta}: Pinol no se pega al resto`,
  );
  const pregunta = separado.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
  assert(separado.readyForConfirmation, `${etiqueta}: caja, paquete y litro ya se pueden cotizar`);
  assert(pregunta === "", `${etiqueta}: no pide rollos si ya dijo caja y paquete`);
  const lineaSanitas = formatSpecificItemLine(sanitas ?? { nombre_producto: "Papel" });
  const lineaSams = formatSpecificItemLine(sams ?? { nombre_producto: "Papel" });
  const lineaPinol = formatSpecificItemLine(pinol ?? { nombre_producto: "Limpiador" });
  assert(/sanitas/i.test(lineaSanitas) && /caja/i.test(lineaSanitas), `${etiqueta}: la tienda ve Sanitas en caja`);
  assert(/sam/i.test(lineaSams) && /paquete/i.test(lineaSams) && !/arroz/i.test(lineaSams), `${etiqueta}: la tienda ve el paquete de Sam's`);
  assert(/pinol/i.test(lineaPinol) && /litro/i.test(lineaPinol), `${etiqueta}: la tienda ve Pinol de un litro`);
  return separado;
}
assertTresProductos(
  [{ nombre_producto: "Papel higiénico", marca: "Sanitas Sam's Pinol" }],
  "la IA lo mandó como un solo papel",
);
assertTresProductos([{ nombre_producto: "Sanitas Sam's Pinol" }], "la IA juntó el nombre");

const tresConCoca = quoteCheck(
  [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
  tresAbarrotes,
);
assert(tresConCoca.validatedItems.items.length === 4, "los tres productos se suman a la Coca que ya estaba");
assert(
  tresConCoca.validatedItems.items.some(
    (item) => /coca/i.test(item.nombre_producto) && /2 litros/i.test(String(item.presentacion)),
  ),
  "la Coca de antes conserva los 2 litros",
);

const catalogoNoParte = validateCaptureForConfirmation({
  snapshot: {
    ...quoteBase,
    businessId: 5,
    businessName: "Hamburguesas Hotdogs George",
    items: [{ nombre_producto: "Sanitas Sam's Pinol" }],
  },
  items: [{ nombre_producto: "Sanitas Sam's Pinol" }],
  knownZoneNames: zones,
  quoteStore: false,
  userMessage: tresAbarrotes,
});
assert(catalogoNoParte.validatedItems.items.length === 1, "el menú fijo no parte el nombre en abarrotes");
assert(
  catalogoNoParte.validatedItems.items[0]?.nombre_producto === "Sanitas Sam's Pinol",
  "George conserva el texto que ya traía",
);
assert(!catalogoNoParte.issues.some((issue) => issue.customerQuestion), "George no pregunta rollos ni marca de tiendita");

const tresGuardados = assertTresProductos([], "sin items de la IA");
const sanitasLuego = quoteCheck(tresGuardados.validatedItems.items, "12");
assert(sanitasLuego.validatedItems.items.length === 3, "un 12 suelto no abre otra línea ni parte el mandado");
assert(sanitasLuego.readyForConfirmation, "caja y paquete siguen listos para cotizar");
const papelSoloMarca = quoteCheck([{ nombre_producto: "Papel higiénico", marca: "Pétalo" }], "18");
assert(/18 rollos/i.test(String(papelSoloMarca.validatedItems.items[0]?.presentacion)), "18 cierra el papel cuando todavía no había caja ni paquete");
assert(papelSoloMarca.validatedItems.allItemsSpecific, "con los rollos el Pétalo ya se cotiza");

const arrozYPapel = quoteCheck([], "un kilo de arroz SOS y un paquete de papel higiénico");
assert(arrozYPapel.validatedItems.items.length === 2, "arroz y papel higiénico por separado son dos");
const arrozSuelto = arrozYPapel.validatedItems.items.find((item) => /arroz/i.test(item.nombre_producto));
const papelSuelto = arrozYPapel.validatedItems.items.find((item) => /papel/i.test(item.nombre_producto));
assert(/arroz/i.test(arrozSuelto?.nombre_producto ?? "") && /sos/i.test(String(arrozSuelto?.marca)), "el arroz SOS se queda arroz");
assert(Boolean(papelSuelto) && !/arroz/i.test(papelSuelto?.nombre_producto ?? ""), "el papel no se vuelve arroz");
const preguntaArroz = arrozYPapel.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/pétalo/i.test(preguntaArroz) && !/rollos|arroz|sos/i.test(preguntaArroz), "el arroz ya está completo; el paquete de papel solo pide marca");

const arrozSams = quoteCheck([], "un kilo de arroz Sam's");
assert(/arroz/i.test(arrozSams.validatedItems.items[0]?.nombre_producto ?? ""), "arroz Sam's sigue siendo arroz");
assert(!/papel/i.test(arrozSams.validatedItems.items[0]?.nombre_producto ?? ""), "Sam's no convierte el arroz en papel");
assert(/sam/i.test(String(arrozSams.validatedItems.items[0]?.marca)), "Sam's queda en el arroz cuando sí es arroz");

const aliento =
  "dos litros de leche Lala entera, unas galletas Emperador grandes, un nutrioli de 1 litro, un zote de barra, un litro de cloralex y una pepsi de lata";
const deUnJalón = quoteCheck([], aliento);
assert(deUnJalón.validatedItems.items.length === 6, "un jalón de abarrotes anota las seis líneas");
assert(deUnJalón.readyForConfirmation, "con marca y tamaño en cada línea ya se puede confirmar");
assert(!deUnJalón.issues.some((issue) => issue.customerQuestion), "no pregunta un dato que ya vino en el mensaje");
const porNombre = (re: RegExp) => deUnJalón.validatedItems.items.find((item) => re.test(item.nombre_producto));
const lecheLala = porNombre(/leche/i);
const galletaEmperador = porNombre(/galleta/i);
const aceiteNutrioli = porNombre(/aceite/i);
const jabonZote = porNombre(/jab[oó]n/i);
const cloroCloralex = porNombre(/cloro/i);
const pepsiLata = porNombre(/refresco|pepsi/i);
assert(/lala/i.test(String(lecheLala?.marca)) && lecheLala?.cantidad === 2, "la leche queda Lala de 2 litros");
assert(/entera/i.test(String(lecheLala?.presentacion)), "la leche queda entera");
assert(/emperador/i.test(String(galletaEmperador?.marca)) && /grande/i.test(String(galletaEmperador?.presentacion)), "las galletas quedan Emperador grandes");
assert(/nutrioli/i.test(String(aceiteNutrioli?.marca)) && /litro/i.test(`${aceiteNutrioli?.unidad ?? ""} ${aceiteNutrioli?.presentacion ?? ""}`), "el Nutrioli queda aceite de 1 litro");
assert(/zote/i.test(String(jabonZote?.marca)) && /barra/i.test(String(jabonZote?.presentacion)), "el Zote queda jabón de barra");
assert(/cloralex/i.test(String(cloroCloralex?.marca)) && /litro/i.test(`${cloroCloralex?.unidad ?? ""} ${cloroCloralex?.presentacion ?? ""}`), "el Cloralex queda cloro de 1 litro");
assert(cloroCloralex?.cantidad === 1, "un litro de Cloralex ya es un bote");
assert(/pepsi/i.test(String(pepsiLata?.marca)) && /lata/i.test(String(pepsiLata?.presentacion)), "la Pepsi queda de lata");
assert(
  [lecheLala, galletaEmperador, aceiteNutrioli, jabonZote, cloroCloralex, pepsiLata].every(Boolean),
  "ninguna marca conocida se queda como producto desconocido",
);

const faltaSoloGalletas = quoteCheck([], "dos litros de leche Lala entera y unas galletas Emperador");
const preguntaGalletas = faltaSoloGalletas.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/emperador|galleta|paquete|grande|gramos/i.test(preguntaGalletas), "si a las galletas les falta el tamaño, se pregunta eso");
assert(!/de qué marca/i.test(preguntaGalletas), "Emperador ya es la marca de las galletas");
assert(!/lala|leche|litros/i.test(preguntaGalletas), "la leche completa no se vuelve a preguntar");

const aceiteCinco = quoteCheck([], "aceite 1-2-3 de 5 litros");
assert(aceiteCinco.validatedItems.allItemsSpecific, "aceite 1-2-3 de 5 litros ya se cotiza");
assert(aceiteCinco.validatedItems.items[0]?.cantidad === 5, "el 1 de 1-2-3 no se come los litros");
assert(aceiteCinco.validatedItems.items[0]?.marca === "1-2-3", "guarda la marca 1-2-3");

const frijol = quoteCheck([], "un kilo de frijol negro");
assert(frijol.validatedItems.allItemsSpecific, "kilo de frijol negro ya se puede cotizar");
assert(/negro/i.test(String(frijol.validatedItems.items[0]?.presentacion)), "guarda el tipo de frijol");

const corona = questionOf("una corona");
assert(corona.question.includes("caguama") && corona.question.includes("lata"), "una corona pide la presentación");
assert(!corona.question.includes("de qué marca"), "corona ya es la marca");
const marlboro = quoteCheck([], "un marlboro");
assert(marlboro.validatedItems.allItemsSpecific, "un marlboro se anota como cajetilla");
assert(/marlboro/i.test(String(marlboro.validatedItems.items[0]?.marca)), "guarda Marlboro");

const suelta = quoteCheck([], "huevo, pan, tortillas, aceite, arroz, frijol, detergente, jabón, cerveza y cigarros");
assert(!suelta.readyForConfirmation, "la lista vaga de abarrotes no se cierra de un jalón");
assert(suelta.issues.filter((issue) => issue.code === "GENERIC_ITEM_NEEDS_SPEC").length >= 8, "cada categoría vaga se queda pendiente");
const primera = suelta.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(primera.includes("huevo") || primera.includes("blanco"), "pregunta uno por uno, empezando por el primero");
assert(!primera.includes("Marlboro") && !primera.includes("Nutrioli"), "un solo mensaje no revuelve todas las categorías");

const catalogoSuelto = validateCaptureForConfirmation({
  snapshot: { ...quoteBase, businessId: 5, businessName: "Hamburguesas Hotdogs George", items: [{ nombre_producto: "Leche", presentacion: "2 litros", cantidad: 2 }] },
  items: [{ nombre_producto: "Leche", presentacion: "2 litros", cantidad: 2 }],
  knownZoneNames: zones,
  quoteStore: false,
  userMessage: "dos litros de leche",
});
assert(catalogoSuelto.validatedItems.allItemsSpecific, "en catálogo no se aprieta la regla de abarrotes");
assert(!catalogoSuelto.issues.some((issue) => issue.customerQuestion), "George no recibe la pregunta de marca de tiendita");

const georgeHotdog = validateCaptureForConfirmation({
  snapshot: {
    ...quoteBase,
    businessId: 5,
    businessName: "Hamburguesas Hotdogs George",
    items: [{ nombre_producto: "Hot dog clásico", cantidad: 1 }],
  },
  items: [{ nombre_producto: "Hot dog clásico", cantidad: 1 }],
  knownZoneNames: zones,
  quoteStore: false,
  userMessage: "un hot dog",
});
assert(georgeHotdog.validatedItems.allItemsSpecific, "el menú de George no pide marca de abarrotes");
assert(!georgeHotdog.issues.some((issue) => issue.customerQuestion), "George no pregunta frasco ni marca de tiendita");
assert(!String(georgeHotdog.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "").toLowerCase().includes("mccormick"), "George no usa ejemplo de mayonesa");

const lecheSinTamano = questionOf("leche Lala entera");
assert(!lecheSinTamano.result.readyForConfirmation, "leche sin tamaño no se cierra");
assert(/litro/i.test(lecheSinTamano.question), "leche sin tamaño pide los litros");
assert(!lecheSinTamano.question.includes("de qué marca"), "la marca ya dicha no se vuelve a pedir");
assert(!lecheSinTamano.question.includes("deslactosada"), "el tipo ya dicho no se vuelve a pedir");

const lecheConMarcaYTipo = [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera" }];
for (const dicho of ["1 l", "de 1 l", "de un litro", "de 1 litro", "1"]) {
  const cerrada = quoteCheck(lecheConMarcaYTipo, dicho);
  assert(cerrada.validatedItems.allItemsSpecific, `la leche cierra con "${dicho}"`);
  assert(!cerrada.issues.some((issue) => issue.customerQuestion), `"${dicho}" no vuelve a preguntar los litros`);
  const guardada = cerrada.validatedItems.items[0];
  assert(/litro/i.test(`${guardada?.unidad ?? ""} ${guardada?.presentacion ?? ""}`), `"${dicho}" guarda litros`);
  assert(guardada?.cantidad === 1, `"${dicho}" deja 1 litro`);
}

const lecheUnidadAbreviada = quoteCheck(
  [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 1, unidad: "l" }],
  "de un litro",
);
assert(lecheUnidadAbreviada.validatedItems.allItemsSpecific, "un litro cierra aunque la unidad guardada sea l");
assert(lecheUnidadAbreviada.validatedItems.items[0]?.unidad !== "l", "de un litro reemplaza la abreviatura l");
assert(/litro/i.test(String(lecheUnidadAbreviada.validatedItems.items[0]?.unidad)), "la unidad queda en litros");
const lecheUnLitro = quoteCheck(
  [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 1, unidad: "l" }],
  "un litro",
);
assert(lecheUnLitro.validatedItems.allItemsSpecific, "un litro también reemplaza la l guardada");
assert(/litro/i.test(String(lecheUnLitro.validatedItems.items[0]?.unidad)), "un litro deja la palabra litro");

const lecheEnteraYLitros = quoteCheck(
  [{ nombre_producto: "Leche", marca: "Lala", cantidad: 1, unidad: "l" }],
  "La leche es entera y sería 1 l",
);
assert(/entera/i.test(String(lecheEnteraYLitros.validatedItems.items[0]?.presentacion)), "entera se sigue anotando");
assert(/litro/i.test(String(lecheEnteraYLitros.validatedItems.items[0]?.unidad)), "1 l junto con entera guarda los litros");
assert(lecheEnteraYLitros.validatedItems.allItemsSpecific, "entera y 1 l cierran la leche");

const lecheSoloEntera = quoteCheck([{ nombre_producto: "Leche", marca: "Lala" }], "entera");
assert(/entera/i.test(String(lecheSoloEntera.validatedItems.items[0]?.presentacion)), "entera sola se guarda");
assert(!lecheSoloEntera.validatedItems.allItemsSpecific, "entera sola no inventa los litros");
const lecheDeslactosada = quoteCheck([{ nombre_producto: "Leche", marca: "Lala" }], "deslactosada");
assert(/deslactosada/i.test(String(lecheDeslactosada.validatedItems.items[0]?.presentacion)), "deslactosada se guarda");
const lecheLight = quoteCheck([{ nombre_producto: "Leche", marca: "Lala" }], "light");
assert(/light/i.test(String(lecheLight.validatedItems.items[0]?.presentacion)), "light se guarda");

const unoNoEsLitrosDeMarca = quoteCheck([{ nombre_producto: "Leche" }], "1");
assert(!unoNoEsLitrosDeMarca.validatedItems.allItemsSpecific, "un 1 no cierra la leche si falta la marca");
assert(unoNoEsLitrosDeMarca.validatedItems.items[0]?.unidad !== "litro", "un 1 no se vuelve litros si la pregunta es la marca");
assert(/marca|Lala/i.test(unoNoEsLitrosDeMarca.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "el 1 no tapa la pregunta de marca");

const unoNoEsLitrosDeTipo = quoteCheck([{ nombre_producto: "Leche", marca: "Lala" }], "1");
assert(unoNoEsLitrosDeTipo.validatedItems.items[0]?.unidad !== "litro", "un 1 no es litros si también falta el tipo");
assert(/entera|litros/i.test(unoNoEsLitrosDeTipo.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "sigue pidiendo el tipo o los litros");

const unoNoEsLitrosDeCoca = quoteCheck([{ nombre_producto: "Coca", marca: "Coca", cantidad: 1 }], "1");
assert(!/litro/i.test(String(unoNoEsLitrosDeCoca.validatedItems.items[0]?.presentacion ?? "")), "un 1 no se vuelve litros de la coca");
assert(/ml|tamaño|lata/i.test(unoNoEsLitrosDeCoca.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "la coca sigue pidiendo el tamaño en ml");

const unoEsPiezaDeGalleta = quoteCheck(
  [{ nombre_producto: "Galletas", marca: "Emperador", presentacion: "grande" }],
  "1",
);
assert(unoEsPiezaDeGalleta.validatedItems.items[0]?.unidad !== "litro", "un 1 de galletas no es un litro");
assert(!/litro/i.test(String(unoEsPiezaDeGalleta.validatedItems.items[0]?.presentacion ?? "")), "el paquete no se reescribe como litro");

const aceiteUnLitro = quoteCheck([{ nombre_producto: "Aceite", marca: "1-2-3" }], "1");
assert(aceiteUnLitro.validatedItems.allItemsSpecific, "el aceite cierra con un 1 cuando solo faltan litros");
assert(aceiteUnLitro.validatedItems.items[0]?.cantidad === 1, "el 1 del aceite es 1 litro");
assert(/litro/i.test(String(aceiteUnLitro.validatedItems.items[0]?.unidad)), "el aceite guarda litro");

const cocaSinCantidad = questionOf("coca de 2 litros");
assert(!cocaSinCantidad.result.readyForConfirmation, "coca con tamaño y sin cantidad no se cierra");
assert(!cocaSinCantidad.question.includes("de qué marca"), "Coca ya es la marca");
assert(/cuánt/i.test(cocaSinCantidad.question), "coca sin cantidad pide cuántas");
assert(/coca/i.test(String(cocaSinCantidad.result.validatedItems.items[0]?.marca)), "guarda Coca");
assert(/2 litros/i.test(String(cocaSinCantidad.result.validatedItems.items[0]?.presentacion)), "guarda el tamaño de la Coca");
assert(cocaSinCantidad.result.validatedItems.items[0]?.cantidad == null, "el 2 de 2 litros no se vuelve la cantidad");

const redBull = questionOf("un red bull");
assert(!redBull.question.includes("de qué marca"), "Red Bull ya es la marca");
assert(/tamaño|lata|ml|litros/i.test(redBull.question), "Red Bull pide el tamaño que falta");

const jitomate = questionOf("jitomate");
assert(!jitomate.result.readyForConfirmation, "jitomate solo no se cierra");
assert(/kilo/i.test(jitomate.question), "jitomate pide kilos");
assert(!/marca/i.test(jitomate.question), "jitomate no inventa marca");
assert(!/blanca|morada/i.test(jitomate.question), "jitomate no pide tipo");
const jitomateListo = quoteCheck([], "2 kilos de jitomate");
assert(jitomateListo.validatedItems.allItemsSpecific, "2 kilos de jitomate ya se cotizan");
assert(jitomateListo.validatedItems.items[0]?.cantidad === 2, "jitomate guarda los kilos");
assert(jitomateListo.validatedItems.items[0]?.marca == null, "jitomate no guarda marca inventada");
assert(/jitomate/i.test(String(jitomateListo.validatedItems.items[0]?.nombre_producto)), "la línea se llama jitomate");

const cebolla = questionOf("cebolla");
assert(/blanca/i.test(cebolla.question) && /morada/i.test(cebolla.question), "cebolla pide el tipo que cambia el producto");
assert(/kilo/i.test(cebolla.question), "cebolla pide kilos");
assert(!/marca/i.test(cebolla.question), "cebolla no pide marca");
const cebollaLista = quoteCheck([], "un kilo de cebolla morada");
assert(cebollaLista.validatedItems.allItemsSpecific, "kilo de cebolla morada ya se cotiza");
assert(/morada/i.test(String(cebollaLista.validatedItems.items[0]?.presentacion)), "guarda cebolla morada");

const mayo = questionOf("mayonesa");
assert(!mayo.result.readyForConfirmation, "mayonesa sola no se cierra");
assert(/marca/i.test(mayo.question), "mayonesa pide marca");
assert(/McCormick/i.test(mayo.question), "mayonesa da un ejemplo de México");
assert(/frasco|190/i.test(mayo.question), "mayonesa pide el tamaño del frasco");
assert(/cuánt/i.test(mayo.question), "mayonesa pide cuántos");
assert((mayo.question.match(/\?/g) ?? []).length === 1, "mayonesa pregunta los huecos en un solo mensaje");

const emperador = questionOf("emperador");
assert(!emperador.result.readyForConfirmation, "emperador sin paquete no se cierra");
assert(!emperador.question.includes("de qué marca"), "Emperador ya es la marca");
assert(/chico|grande|gramos/i.test(emperador.question), "Emperador pide el tamaño del paquete");
assert(/cuánt/i.test(emperador.question), "Emperador sin cantidad pide cuántos");
assert(/emperador/i.test(String(emperador.result.validatedItems.items[0]?.marca)), "guarda Emperador");

const mayoSea = quoteCheck(mayo.result.validatedItems.items, "del que sea");
assert(mayoSea.readyForConfirmation, "del que sea cierra la mayonesa y no se vuelve a preguntar");
assert(!mayoSea.issues.some((issue) => issue.customerQuestion), "del que sea no trae otra pregunta");
assert(mayoSea.validatedItems.items[0]?.notas === "la que sea", "del que sea queda anotado en la mayonesa");
const mayoOtraVez = quoteCheck(mayoSea.validatedItems.items, "sí la misma");
assert(mayoOtraVez.readyForConfirmation, "la que sea no se re-pregunta en el turno siguiente");
assert(!mayoOtraVez.issues.some((issue) => issue.customerQuestion), "un turno después sigue sin pedir marca");

const mayoLista = quoteCheck([], "dos mayonesas McCormick frasco de 190 g");
assert(mayoLista.validatedItems.allItemsSpecific, "mayonesa con marca, frasco y cantidad ya se cotiza");
assert(/mccormick/i.test(String(mayoLista.validatedItems.items[0]?.marca)), "guarda McCormick");
assert(mayoLista.validatedItems.items[0]?.cantidad === 2, "guarda las dos mayonesas");
const mayoLine = formatSpecificItemLine(mayoLista.validatedItems.items[0]);
assert(/mccormick/i.test(mayoLine), "la línea lleva la marca");
assert(/190/.test(mayoLine), "la línea lleva el tamaño del frasco");
assert(/\b2\b/.test(mayoLine), "la línea lleva la cantidad");
assert(dispatchItemAlreadyShowsQty(mayoLine, 2), "la tienda no duplica la cantidad");
const mayoReceipt = buildCustomerMessage({
  validation: mayoLista,
  snapshot: { ...quoteBase, items: mayoLista.validatedItems.items },
  items: mayoLista.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
const listaMezclada = "dos mayonesas, un kilo de papas y 2 kilos de jitomate";
const mezclada = quoteCheck([], listaMezclada);
const mayoMezcla = mezclada.validatedItems.items.find((item) => /mayonesa/i.test(item.nombre_producto));
const papaMezcla = mezclada.validatedItems.items.find((item) => /^papas?$/i.test(item.nombre_producto));
const jitomateMezcla = mezclada.validatedItems.items.find((item) => /jitomate/i.test(item.nombre_producto));
assert(mezclada.validatedItems.items.length === 3, "un mensaje con tres productos anota tres");
assert(mayoMezcla?.cantidad === 2, "las dos mayonesas no se quedan en otra cantidad");
assert(mayoMezcla?.marca == null && mayoMezcla?.presentacion == null, "la mayonesa no hereda el kilo de las papas");
assert(!mezclada.readyForConfirmation, "la mayonesa sin marca ni frasco no cierra el pedido");
const preguntaMezcla = mezclada.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/marca/i.test(preguntaMezcla) && /frasco|190/i.test(preguntaMezcla), "solo se pregunta marca y frasco de la mayonesa");
assert(!/cuánt/i.test(preguntaMezcla), "la cantidad de la mayonesa ya está");
assert(!/sabritas|barcel|pringles/i.test(preguntaMezcla), "las papas por kilo no piden marca de bolsa");
assert(papaMezcla?.cantidad === 1 && /kilo/i.test(String(papaMezcla?.unidad)), "las papas quedan en 1 kilo");
assert(papaMezcla?.marca == null, "la papa por kilo no guarda marca");
assert(jitomateMezcla?.cantidad === 2 && /kilo/i.test(String(jitomateMezcla?.unidad)), "el jitomate queda en 2 kilos");
assert(jitomateMezcla?.marca == null, "el jitomate no pide marca");

const listaCompleta = "dos mayonesas McCormick frasco de 190 g, un kilo de papas y 2 kilos de jitomate";
const completa = quoteCheck([], listaCompleta);
assert(completa.readyForConfirmation, "mayonesa con frasco, papas y jitomate ya se pueden confirmar");
const mayoCompleta = completa.validatedItems.items.find((item) => /mayonesa/i.test(item.nombre_producto));
const papaCompleta = completa.validatedItems.items.find((item) => /^papas?$/i.test(item.nombre_producto));
const jitomateCompleta = completa.validatedItems.items.find((item) => /jitomate/i.test(item.nombre_producto));
assert(mayoCompleta?.cantidad === 2, "la mayonesa completa sigue en 2");
assert(/mccormick/i.test(String(mayoCompleta?.marca)), "guarda McCormick en el mensaje junto");
assert(/190/.test(String(mayoCompleta?.presentacion)), "no se pierde el frasco de 190 g");
assert(/frasco/i.test(`${mayoCompleta?.presentacion ?? ""} ${mayoCompleta?.unidad ?? ""}`), "el frasco sigue en la mayonesa");
assert(papaCompleta?.cantidad === 1, "las papas del mensaje junto siguen en 1 kilo");
assert(jitomateCompleta?.cantidad === 2, "el jitomate del mensaje junto sigue en 2 kilos");
const ticketJunto = buildCustomerMessage({
  validation: completa,
  snapshot: { ...quoteBase, items: completa.validatedItems.items },
  items: completa.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
const lineaMayo = formatSpecificItemLine(mayoCompleta ?? { nombre_producto: "Mayonesa" });
const lineaPapa = formatSpecificItemLine(papaCompleta ?? { nombre_producto: "Papa" });
const lineaJitomate = formatSpecificItemLine(jitomateCompleta ?? { nombre_producto: "Jitomate" });
assert(ticketJunto.includes(lineaMayo) && /190/.test(lineaMayo) && /McCormick/.test(ticketJunto), "el ticket junto muestra la mayonesa de 190 g");
assert(ticketJunto.includes(lineaPapa) && /1 kilo/i.test(lineaPapa), "el ticket junto muestra 1 kilo de papa");
assert(ticketJunto.includes(lineaJitomate) && /2 kilos/i.test(lineaJitomate), "el ticket junto muestra 2 kilos de jitomate");
assert(ticketJunto.includes("$25") && !ticketJunto.includes("$10") && !ticketJunto.includes("$35"), "el ticket junto es un solo $25");
assert(!/sabritas|barcel|pringles/i.test(ticketJunto), "el ticket junto no pide bolsa de papas");

const sucio = quoteCheck(
  [
    { nombre_producto: "Mayonesa", presentacion: "1 kilo", cantidad: 2 },
    { nombre_producto: "Papa", cantidad: 2 },
    { nombre_producto: "Jitomate", cantidad: 1, unidad: "kilo" },
  ],
  listaMezclada,
);
const mayoSucia = sucio.validatedItems.items.find((item) => /mayonesa/i.test(item.nombre_producto));
const papaSucia = sucio.validatedItems.items.find((item) => /^papas?$/i.test(item.nombre_producto));
const jitomateSucio = sucio.validatedItems.items.find((item) => /jitomate/i.test(item.nombre_producto));
assert(sucio.validatedItems.items.length === 3, "no se duplica la papa cuando la IA ya la mandó");
assert(mayoSucia?.presentacion == null && mayoSucia?.cantidad === 2, "se le quita a la mayonesa el kilo que no es suyo");
assert(papaSucia?.cantidad === 1, "la papa que la IA dejó en 2 vuelve a 1 kilo");
assert(jitomateSucio?.cantidad === 2, "el jitomate que la IA dejó en 1 vuelve a 2 kilos");

assert(mayoReceipt.includes("McCormick") && mayoReceipt.includes("190"), "el cliente ve marca y presentación antes del SÍ");
assert(mayoReceipt.includes("SÍ"), "el cierre sigue pidiendo SÍ");
assert(mayoReceipt.includes("$25") && !mayoReceipt.includes("$10") && !mayoReceipt.includes("$35"), "abarrotes siguen en un solo $25");

const papasKilo = quoteCheck([], "kilo de papas");
assert(papasKilo.validatedItems.allItemsSpecific, "kilo de papas es papa suelta, no Sabritas");
assert(papasKilo.readyForConfirmation, "kilo de papas ya se puede cotizar");
assert(!/sabritas|marca/i.test(papasKilo.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "la papa por kilo no pide marca");
assert(papasKilo.validatedItems.items[0]?.cantidad === 1, "kilo de papas cuenta como 1 kilo");

const unasPapas = questionOf("unas papas");
assert(/Sabritas/i.test(unasPapas.question), "papas de bolsa piden marca");
assert(!/cuánt/i.test(unasPapas.question), "unas ya es la cantidad");

const cloro = questionOf("cloro", [{ nombre_producto: "Cloro" }]);
assert(!cloro.result.readyForConfirmation, "un producto suelto que no está en la lista también se aclara");
assert(/marca/i.test(cloro.question) && /presentación|chico|litros/i.test(cloro.question), "cloro pide marca y presentación");
assert(/cuánt/i.test(cloro.question), "cloro pide cantidad");
assert((cloro.question.match(/\?/g) ?? []).length === 1, "cloro se pregunta en un solo mensaje");

const jitomateLine = formatSpecificItemLine(jitomateListo.validatedItems.items[0]);
assert(/jitomate/i.test(jitomateLine) && /2/.test(jitomateLine) && /kilo/i.test(jitomateLine), "la tienda ve jitomate y kilos");
assert(!/marca|sabritas|lala/i.test(jitomateLine), "la línea de jitomate no trae marca falsa");

const waivableReceipt = buildCustomerMessage({
  validation: cualquierLeche,
  snapshot: { ...quoteBase, items: cualquierLeche.validatedItems.items },
  items: cualquierLeche.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(waivableReceipt.includes("la que sea"), "el recibo lleva la nota de que la tienda escoge");
assert(waivableReceipt.includes("$25"), "el recibo de cotización es de $25");
assert(!waivableReceipt.includes("$10") && !waivableReceipt.includes("$35"), "el recibo no parte el cargo ni usa el monto viejo");

const georgeCatalog = [
  { nombreProducto: "Hamburguesa de pollo", precio: 55 },
  { nombreProducto: "Dogo clásico", precio: 40 },
];
const enElNombre = reconcileCatalogQuantities([], [{ nombre_producto: "dos hamburguesas de pollo" }], "dos hamburguesas de pollo");
assert(enElNombre[0]?.cantidad === 2, "si la cantidad viene pegada al nombre, se separa");
assert(!/^dos\b/i.test(String(enElNombre[0]?.nombre_producto ?? "")), "el nombre del menú ya no empieza con dos");
assert(priceCatalogOrder(enElNombre, georgeCatalog).subtotal === 110, "el nombre en plural sigue costando dos");

const dosPollo = reconcileCatalogQuantities(
  [],
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 1 }],
  "dos hamburguesas de pollo",
);
assert(dosPollo[0]?.cantidad === 2, "dos hamburguesas de pollo se quedan en 2");
const pricedDos = priceCatalogOrder(dosPollo, georgeCatalog);
assert(pricedDos.subtotal === 110, "dos hamburguesas de pollo cuestan el precio de dos");
assert(pricedDos.lines[0]?.includes("2 "), "el ticket muestra la cantidad 2");
assert(pricedDos.lines[0]?.includes("$110"), "el renglón muestra el precio de dos");
assert(!pricedDos.lines[0]?.includes("$55"), "el renglón no se queda en el precio de una");
const ticketDos = buildCustomerMessage({
  validation: georgeHotdog,
  snapshot: { ...quoteBase, businessId: 5, businessName: "Hamburguesas Hotdogs George", items: dosPollo },
  items: dosPollo,
  pricedLines: pricedDos.lines.join("\n"),
  feeNote: formatCatalogReceiptFee(pricedDos.subtotal),
});
assert(ticketDos.includes("$110"), "el ticket final trae el precio de dos hamburguesas");
assert(ticketDos.includes("Envío y servicio: $25"), "el ticket de catálogo trae un solo $25");
assert(ticketDos.includes("$135"), "el total suma las dos hamburguesas más $25");
assert(!/\$10\b/.test(ticketDos) && !/\$35\b/.test(ticketDos), "el ticket de catálogo no parte el cargo ni usa el monto viejo");

const trasUbicacion = reconcileCatalogQuantities(
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 2 }],
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 1 }],
  "",
);
assert(trasUbicacion[0]?.cantidad === 2, "la ubicación no baja la cantidad a 1");
assert(priceCatalogOrder(trasUbicacion, georgeCatalog).subtotal === 110, "después de la ubicación se siguen cobrando dos");

const conDogos = reconcileCatalogQuantities(
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 2 }],
  [
    { nombre_producto: "Hamburguesa de pollo", cantidad: 1 },
    { nombre_producto: "Dogo clásico", cantidad: 1 },
  ],
  "y también dos dogos",
);
assert(conDogos[0]?.cantidad === 2, "agregar dogos no aplasta las hamburguesas");
assert(conDogos[1]?.cantidad === 2, "dos dogos se quedan en 2");
const pricedMixto = priceCatalogOrder(conDogos, georgeCatalog);
assert(pricedMixto.subtotal === 190, "dos hamburguesas y dos dogos suman las cuatro piezas");
assert(pricedMixto.lines[1]?.includes("$80"), "los dos dogos se cobran a precio de dos");

const unaSola = reconcileCatalogQuantities(
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 2 }],
  [{ nombre_producto: "Hamburguesa de pollo", cantidad: 2 }],
  "mejor una hamburguesa de pollo",
);
assert(unaSola[0]?.cantidad === 1, "si pide una, la cantidad baja a 1");
assert(priceCatalogOrder(unaSola, georgeCatalog).lines[0]?.includes("1 Hamburguesa de pollo"), "una pieza muestra la cantidad 1");
assert(priceCatalogOrder(unaSola, georgeCatalog).lines[0]?.includes("$55"), "una hamburguesa se cobra a precio de una");
const kiloChorizo = priceCatalogOrder(
  [{ nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" }],
  [{ nombreProducto: "Chorizo", precio: 115 }],
);
assert(kiloChorizo.lines[0]?.includes("1 kg Chorizo — $115"), "un kilo muestra 1 kg y el precio");
const mediaArrachera = priceCatalogOrder(
  [{ nombre_producto: "Arrachera Marinada", cantidad: 0.5, unidad: "kilo" }],
  [{ nombreProducto: "Arrachera Marinada", precio: 280 }],
);
assert(mediaArrachera.lines[0]?.includes("0.5 kg Arrachera Marinada — $140"), "medio kilo muestra 0.5 kg y el precio");

const plural = priceCatalogOrder([{ nombre_producto: "Hamburguesas de pollo", cantidad: 2 }], georgeCatalog);
assert(plural.subtotal === 110, "el plural del menú sigue encontrando el precio de dos");

const storeLine = formatSpecificItemLine({ nombre_producto: "Hamburguesa de pollo", cantidad: 2 });
assert(/x2/.test(storeLine), "la tienda y el repartidor ven las dos piezas");
assert(dispatchItemAlreadyShowsQty(storeLine, 2), "no se duplica el 2 en el mensaje de la tienda");

const registrado = formatCatalogOrderRegistered(9, "Hamburguesas Hotdogs George");
assert(registrado.includes("SÍ"), "en catálogo el primer SÍ avisa que sigue el total");
assert(!registrado.toLowerCase().includes("confirme el precio"), "en catálogo no se dice que la tienda va a cotizar");
const cotiza = formatQuoteOrderRegistered(9, "ZAGU");
assert(cotiza.toLowerCase().includes("confirme el precio"), "en abarrotes sí se espera la cotización de la tienda");
const quoteDos = formatCustomerQuoteMessage({
  tiendaNombre: "Hamburguesas Hotdogs George",
  pedidoId: 9,
  subtotal: 110,
  total: 135,
  itemLines: pricedDos.lines,
});
assert(quoteDos.includes("2 ") && quoteDos.includes("$110") && quoteDos.includes("$135"), "el SÍ del precio repite cantidad y precio de dos");
assert(quoteDos.includes("Envío y servicio: $25") && !/\$10\b/.test(quoteDos) && !/\$35\b/.test(quoteDos), "ese SÍ es un solo $25");
assert(formatCourierCancelNotice(9).includes("#9"), "si el repartidor ya tenía el pedido, el aviso de cancelación lo nombra");

const menuGeorge = [
  { nombreProducto: "Hamburguesa Mar y Tierra Chica", precio: 90 },
  { nombreProducto: "Hamburguesa Mar y Tierra Grande", precio: 140 },
  { nombreProducto: "Hamburguesa Arrachera Chica", precio: 70 },
  { nombreProducto: "Hamburguesa Arrachera Grande", precio: 100 },
  { nombreProducto: "Dogo arrachera", precio: 45 },
  { nombreProducto: "Dogo clásico", precio: 35 },
  { nombreProducto: "Refresco", precio: 20 },
];
const marYTierra = applyCatalogSpeech({
  base: [{ nombre_producto: "Hamburguesa Mar y Tierra Chica", cantidad: 1 }],
  userMessage: "Ok quiero una de mar y tierra",
  catalog: menuGeorge,
});
assert(marYTierra.applied && marYTierra.missing, "mar y tierra se anota y sigue faltando el tamaño");
assert(!/chica|grande/i.test(marYTierra.items[0]?.nombre_producto ?? ""), "no guarda chica si el cliente no la dijo");
assert(marYTierra.items[0]?.cantidad === 1, "una cuenta como 1 pieza");
const lineaMar = marYTierra.reply?.split("\n").find((line) => line.startsWith("✅")) ?? "";
assert(/1 pieza/.test(lineaMar) && !/chica|grande/i.test(lineaMar), "la línea anota la pieza y no el tamaño");
assert(/¿La quieres chica o grande\?/.test(marYTierra.reply ?? ""), "pregunta solo el tamaño");
assert(!/solo una|cuánt|de qué marca/i.test(marYTierra.reply ?? ""), "no vuelve a preguntar la cantidad que ya dijo");

const conPepsi = applyCatalogSpeech({
  base: marYTierra.items,
  userMessage: sumaGeorge,
  catalog: menuGeorge,
});
assert(conPepsi.applied && !conPepsi.missing, "chica, Pepsi y dogo de arrachera cierran el menú");
assert(conPepsi.items.length === 3, "suma la hamburguesa, el refresco y el dogo");
assert(/mar y tierra chica/i.test(conPepsi.items[0]?.nombre_producto ?? ""), "ahora sí guarda chica, porque la dijo");
assert(conPepsi.items[0]?.cantidad === 1, "la hamburguesa sigue en 1");
assert(/refresco/i.test(conPepsi.items[1]?.nombre_producto ?? "") && /pepsi/i.test(String(conPepsi.items[1]?.marca)), "la Pepsi queda en el refresco");
assert(/dogo arrachera/i.test(conPepsi.items[2]?.nombre_producto ?? ""), "el dogo de arrachera entra al pedido");
assert(conPepsi.items.every((item) => item.cantidad === 1), "una Pepsi y un dogo quedan en 1");
assert(!/la quieres|cuánt|de qué marca|solo una/i.test(conPepsi.reply ?? ""), "no repregunta tamaño, marca ni cantidad ya dichos");
assert(!/te paso el menú|te dejo el menú/i.test(conPepsi.reply ?? ""), "sumar productos no arma el pie de la foto");

const dogoNoAplasta = applyCatalogSpeech({
  base: [{ nombre_producto: "Hamburguesa de pollo", cantidad: 2 }],
  userMessage: "y también un dogo de arrachera",
  catalog: [{ nombreProducto: "Hamburguesa de pollo", precio: 70 }, ...menuGeorge],
});
assert(dogoNoAplasta.items[0]?.cantidad === 2, "sumar un dogo no baja las dos hamburguesas");
assert(/dogo arrachera/i.test(dogoNoAplasta.items[1]?.nombre_producto ?? ""), "el dogo nuevo sí se anota");

const dogosVagos = applyCatalogSpeech({
  base: [],
  userMessage: "dos dogos",
  catalog: menuGeorge,
});
assert(!dogosVagos.applied, "dos dogos sin sabor no eligen uno al azar");

const pedido83 =
  "una hamburguesa hawaiana, una hamburguesa cubana, Salchi locos, 3 Dogos clásicos y 3 refrescos: 1 Pepsi y 2 manzanitas";
const menuMarcas = [
  { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
  { nombreProducto: "Hamburguesa Cubana", precio: 80 },
  { nombreProducto: "Salchilocos", precio: 65 },
  { nombreProducto: "Dogo Clásico", precio: 35 },
  { nombreProducto: "Refresco Pepsi Coca Seven Sprite Mirinda Manzana", precio: 20 },
];
const menuSimple = [
  { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
  { nombreProducto: "Hamburguesa Cubana", precio: 80 },
  { nombreProducto: "Salchi locos", precio: 65 },
  { nombreProducto: "Dogo Clásico", precio: 35 },
  { nombreProducto: "Refresco", precio: 20 },
];
function assertPedido83(catalog: Array<{ nombreProducto: string; precio: number }>, etiqueta: string) {
  const parsed = applyCatalogSpeech({ base: [], userMessage: pedido83, catalog });
  assert(parsed.applied && !parsed.missing, `${etiqueta}: el mensaje completo no deja huecos`);
  const find = (re: RegExp) => parsed.items.find((item) => re.test(`${item.nombre_producto} ${item.marca ?? ""}`));
  const hawaiana = find(/hawaiana/i);
  const cubana = find(/cubana/i);
  const salchi = find(/salchi/i);
  const dogo = find(/dogo/i);
  const pepsi = find(/pepsi/i);
  const manzana = find(/manzana/i);
  assert(hawaiana?.cantidad === 1, `${etiqueta}: hawaiana es 1`);
  assert(cubana?.cantidad === 1, `${etiqueta}: cubana es 1`);
  assert(Boolean(salchi) && salchi?.cantidad === 1, `${etiqueta}: salchi locos entra en 1`);
  assert(/cl[aá]sico/i.test(dogo?.nombre_producto ?? "") && dogo?.cantidad === 3, `${etiqueta}: 3 dogos clásicos`);
  assert(/pepsi/i.test(`${pepsi?.nombre_producto ?? ""} ${pepsi?.marca ?? ""}`) && pepsi?.cantidad === 1, `${etiqueta}: 1 Pepsi`);
  assert(/manzana/i.test(`${manzana?.nombre_producto ?? ""} ${manzana?.marca ?? ""}`) && manzana?.cantidad === 2, `${etiqueta}: 2 manzanitas`);
  assert(parsed.items.length === 6, `${etiqueta}: son seis líneas, no solo las dos hamburguesas`);
  assert(!/cuánt|de qué marca|la quieres/i.test(parsed.reply ?? ""), `${etiqueta}: no re-pregunta lo que ya dijo`);
  const lista = formatProductListConfirm(parsed.items);
  assert(lista.includes("¿Están bien estos productos?"), `${etiqueta}: la lista pide confirmación`);
  assert(!lista.includes("ubicación por GPS"), `${etiqueta}: la lista no pide GPS`);
  assert(!lista.includes("$35") && !lista.includes("$10") && !lista.includes("$25"), `${etiqueta}: la lista no cambia el cargo`);
  for (const pieza of [hawaiana, cubana, salchi, dogo, pepsi, manzana]) {
    assert(lista.toLowerCase().includes((pieza?.nombre_producto ?? "no-esta").toLowerCase()), `${etiqueta}: la lista trae ${pieza?.nombre_producto}`);
  }
}
assertPedido83(menuMarcas, "menú con marcas en el refresco");
assertPedido83(menuSimple, "menú con refresco suelto y salchi locos");
assertPedido83(
  [
    { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
    { nombreProducto: "Hamburguesa Cubana", precio: 80 },
    { nombreProducto: "Salchilocos", precio: 65 },
    { nombreProducto: "Dogo Clásico", precio: 35 },
    { nombreProducto: "Refresco Pepsi", precio: 20 },
    { nombreProducto: "Refresco Manzana", precio: 20 },
  ],
  "menú con un refresco por marca",
);
assertPedido83(
  [
    { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
    { nombreProducto: "Hamburguesa Cubana", precio: 80 },
    { nombreProducto: "Salchilocos", precio: 65 },
    { nombreProducto: "Dogo Clásico", precio: 35 },
    { nombreProducto: "Pepsi", precio: 20 },
    { nombreProducto: "Manzana", precio: 20 },
  ],
  "menú con Pepsi y Manzana como productos",
);

const hawaianaConTamaño = applyCatalogSpeech({
  base: [],
  userMessage: "una hamburguesa hawaiana",
  catalog: [
    { nombreProducto: "Hamburguesa Hawaiana Chica", precio: 70 },
    { nombreProducto: "Hamburguesa Hawaiana Grande", precio: 95 },
  ],
});
assert(hawaianaConTamaño.applied && hawaianaConTamaño.missing, "si el menú tiene dos tamaños, se pregunta el tamaño");
assert(hawaianaConTamaño.items[0]?.cantidad === 1, "una hawaiana ya trae la cantidad");
assert(!/chica|grande/i.test(hawaianaConTamaño.items[0]?.nombre_producto ?? ""), "no inventa el tamaño");
assert(/chica o grande/i.test(hawaianaConTamaño.reply ?? ""), "pregunta el tamaño que falta");
assert(!/cuánt/i.test(hawaianaConTamaño.reply ?? ""), "no vuelve a preguntar cuántas");

const otraCubana = applyCatalogSpeech({
  base: [],
  userMessage: "otra cubana",
  catalog: menuSimple,
});
assert(otraCubana.items[0]?.cantidad === 1 && /cubana/i.test(otraCubana.items[0]?.nombre_producto ?? ""), "otra cuenta como 1");

const unosClasicos = applyCatalogSpeech({
  base: [],
  userMessage: "unos dogos clásicos",
  catalog: menuSimple,
});
assert(unosClasicos.items[0]?.cantidad === 1 && /cl[aá]sico/i.test(unosClasicos.items[0]?.nombre_producto ?? ""), "unos cuenta como 1");

const soloDos = applyCatalogSpeech({
  base: [],
  userMessage: pedido83,
  catalog: menuSimple,
});
const faltaron = "Sí, pero te faltaron los demás";
assert(classifyProductListReply(faltaron) === "revise", "te faltaron en la lista se revisa");
assert(!isYesConfirmation(faltaron), "te faltaron no es el sí del GPS");
assert(isComplaintMessage(faltaron), "faltaron sigue siendo frase de queja fuera de la captura");
assert(!shouldEscalateComplaint(faltaron, { editingOrder: true }), "durante la lista, te faltaron no avisa al admin");
assert(shouldEscalateComplaint(faltaron, { editingOrder: false }), "sin pedido en captura, te faltaron sí avisa al admin");
assert(shouldEscalateComplaint("quiero hablar con alguien, te faltaron cosas", { editingOrder: true }), "pedir una persona sí se escala");
assert(shouldEscalateComplaint("no me llego el pedido", { editingOrder: true }), "no llegó sigue siendo queja");
assert(!shouldEscalateComplaint("hola", { editingOrder: true }), "un saludo no es queja");
const corregido83 = applyCatalogSpeech({
  base: soloDos.items.filter((item) => /hawaiana|cubana/i.test(item.nombre_producto)),
  userMessage: "Sí, pero te faltaron Salchi locos, 3 dogos clásicos, 1 pepsi y 2 manzanitas",
  catalog: menuSimple,
});
assert(corregido83.applied && !corregido83.missing, "nombrar lo que faltó completa el menú");
assert(corregido83.items.length === 6, "la corrección no tira las hamburguesas");
const listaCorregida83 = formatProductListConfirm(corregido83.items);
assert(listaCorregida83.includes("¿Están bien estos productos?") && !listaCorregida83.includes("ubicación por GPS"), "después de faltó se vuelve a listar, sin GPS");
assert(/salchi/i.test(listaCorregida83) && /cl[aá]sico/i.test(listaCorregida83) && /pepsi/i.test(listaCorregida83) && /manzana/i.test(listaCorregida83), "la lista nueva trae lo que faltaba");

assertPedido83(
  [
    { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
    { nombreProducto: "Hamburguesa Cubana", precio: 80 },
    { nombreProducto: "Salchi locos 1 pieza", precio: 65 },
    { nombreProducto: "Dogo Clásico", precio: 35 },
    { nombreProducto: "Refresco", precio: 20 },
  ],
  "salchi locos con sufijo de pieza",
);
assertPedido83(
  [
    { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
    { nombreProducto: "Hamburguesa Cubana", precio: 80 },
    { nombreProducto: "Salchilocos 315g", precio: 65 },
    { nombreProducto: "Dogo Clásico", precio: 35 },
    { nombreProducto: "Refresco", precio: 20 },
  ],
  "salchi locos con sufijo de gramos",
);

const menu85 = [
  { nombreProducto: "Hamburguesa de Res Chica", precio: 75 },
  { nombreProducto: "Hamburguesa de Res Grande", precio: 100 },
  { nombreProducto: "Papas Gajo 315g", precio: 45 },
  { nombreProducto: "Pepsi", precio: 22 },
  { nombreProducto: "Manzana", precio: 22 },
];
const pedido85 = "Quiero una hamburguesa de res, quiero unas papas, gajo, una Pepsi y una manzanita";
const anotado85 = applyCatalogSpeech({ base: [], userMessage: pedido85, catalog: menu85 });
assert(anotado85.applied, "el pedido #85 se anota desde el menú");
assert(anotado85.items.length === 4, "el pedido #85 son cuatro líneas, no solo res y pepsi");
const linea85 = (re: RegExp) => anotado85.items.find((item) => re.test(`${item.nombre_producto} ${item.marca ?? ""}`));
const res85 = linea85(/res/i);
const papas85 = linea85(/papas gajo/i);
const pepsi85 = linea85(/pepsi/i);
const manzana85 = linea85(/manzana/i);
assert(res85?.cantidad === 1 && !/chica|grande/i.test(res85?.nombre_producto ?? ""), "res es 1 y no inventa el tamaño");
assert(papas85?.nombre_producto === "Papas Gajo 315g" && papas85.cantidad === 1, "papas gajo entra con el nombre del menú");
assert(pepsi85?.cantidad === 1 && /pepsi/i.test(pepsi85?.nombre_producto ?? ""), "pepsi es 1");
assert(manzana85?.cantidad === 1 && /manzana/i.test(manzana85?.nombre_producto ?? ""), "manzanita es la manzana del menú");
assert(anotado85.question === "¿Hamburguesa de Res, la quieres chica o grande?", "si el menú tiene dos tamaños, se pregunta solo el de la hamburguesa");
assert((anotado85.reply ?? "").includes("Papas Gajo 315g") && (anotado85.reply ?? "").includes("Pepsi") && (anotado85.reply ?? "").includes("Manzana"), "la lista del #85 trae las cuatro líneas");
const menu85SinTamano = [
  { nombreProducto: "Hamburguesa de Res", precio: 80 },
  { nombreProducto: "Papas Gajo 315g", precio: 45 },
  { nombreProducto: "Pepsi", precio: 22 },
  { nombreProducto: "Manzana", precio: 22 },
];
const anotado85Cerrado = applyCatalogSpeech({ base: [], userMessage: pedido85, catalog: menu85SinTamano });
assert(anotado85Cerrado.applied && !anotado85Cerrado.missing && anotado85Cerrado.items.length === 4, "sin tamaños en el menú no se pregunta tamaño");
assert(!/la quieres|chica|grande/i.test(anotado85Cerrado.reply ?? ""), "el #85 cerrado no pregunta tamaño");
const lista85 = formatProductListConfirm(anotado85Cerrado.items);
assert(lista85.includes("¿Están bien estos productos?"), "el #85 cerrado vuelve a listar completo");
assert(/papas gajo 315g/i.test(lista85) && /manzana/i.test(lista85) && /pepsi/i.test(lista85) && /res/i.test(lista85), "la re-lista trae res, papas gajo, pepsi y manzana");
assert(!lista85.includes("$35") && !lista85.includes("$10") && !lista85.includes("$25"), "la re-lista del #85 no toca el cargo");

const dosRefrescos = applyCatalogSpeech({
  base: [],
  userMessage: "una Pepsi y una manzanita",
  catalog: [{ nombreProducto: "Refresco Pepsi Coca Seven Sprite Mirinda Manzana", precio: 20 }],
});
assert(dosRefrescos.applied && !dosRefrescos.missing && dosRefrescos.items.length === 2, "una pepsi y una manzanita son dos refrescos");
assert(dosRefrescos.items.every((item) => /refresco/i.test(item.nombre_producto) && item.cantidad === 1), "cada refresco queda en 1");
assert(dosRefrescos.items.some((item) => /pepsi/i.test(String(item.marca))) && dosRefrescos.items.some((item) => /manzana/i.test(String(item.marca))), "pepsi y manzana no se funden");

const papasConGramos = applyCatalogSpeech({
  base: [],
  userMessage: "unas papas gajo",
  catalog: [{ nombreProducto: "Papas Gajo 315 gramos", precio: 45 }],
});
assert(papasConGramos.items[0]?.nombre_producto === "Papas Gajo 315 gramos" && papasConGramos.items[0]?.cantidad === 1, "315 gramos no impide anotar papas gajo");
const salchiConPieza = applyCatalogSpeech({
  base: [],
  userMessage: "Salchi locos",
  catalog: [{ nombreProducto: "Salchi locos 1 pieza", precio: 65 }],
});
assert(/salchi locos/i.test(salchiConPieza.items[0]?.nombre_producto ?? "") && salchiConPieza.items[0]?.cantidad === 1, "1 pieza no impide anotar salchi locos");

const faltaronPapas = "Y te faltaron unas papas gajo";
assert(classifyProductListReply(faltaronPapas) === "revise", "y te faltaron en la lista se revisa");
assert(!isYesConfirmation(faltaronPapas), "y te faltaron no es el sí del GPS");
assert(isComplaintMessage(faltaronPapas), "faltaron sigue siendo queja fuera de la captura");
assert(!shouldEscalateComplaint(faltaronPapas, { editingOrder: true }), "durante la lista, y te faltaron no avisa al admin");
assert(shouldEscalateComplaint(faltaronPapas, { editingOrder: false }), "sin pedido en captura, y te faltaron sí avisa al admin");
const papasEnLaLista = applyCatalogSpeech({
  base: [
    { nombre_producto: "Hamburguesa de Res", cantidad: 1 },
    { nombre_producto: "Pepsi", cantidad: 1 },
    { nombre_producto: "Manzana", cantidad: 1 },
  ],
  userMessage: faltaronPapas,
  catalog: menu85SinTamano,
});
assert(papasEnLaLista.applied && papasEnLaLista.items.length === 4, "y te faltaron unas papas gajo suma la línea y no tira lo demás");
assert(papasEnLaLista.items.some((item) => item.nombre_producto === "Papas Gajo 315g" && item.cantidad === 1), "las papas gajo entran al pedido");
const listaConPapas = formatProductListConfirm(papasEnLaLista.items);
assert(/papas gajo 315g/i.test(listaConPapas) && listaConPapas.includes("¿Están bien estos productos?"), "después de te faltaron se vuelve a listar con las papas");

const menuCentral = CARNICERIA_LA_CENTRAL_PRODUCTOS.map(({ nombreProducto, precio }) => ({ nombreProducto, precio }));
assert(menuCentral.length === 19, "La Central tiene los 19 productos del menú impreso");
assert(!menuCentral.some((row) => /pollo|pechuga|alitas/i.test(row.nombreProducto)), "La Central no vende pollo");
assert(menuCentral.some((row) => row.nombreProducto === "Pulpa de puerco" && row.precio === 115), "el menú incluye Pulpa de puerco a $115");
assert(menuCentral.some((row) => row.nombreProducto === "Carne de puerco al pastor" && row.precio === 120), "el pastor se llama Carne de puerco al pastor");
assert(menuCentral.some((row) => row.nombreProducto === "Carbón fino" && row.precio === 75), "el carbón del menú es Carbón fino, a $75");
assert(!menuCentral.some((row) => /firo/i.test(row.nombreProducto)), "el nombre guardado no es Firo");
const pedidoCentral =
  "Quiero una arrachera marinada, un bistec de puerco marinado, peinesillo, un diezmillo, chamberete, un ribeye y carbón firo, y una salsa hot wins";
const anotadoCentral = applyCatalogSpeech({ base: [], userMessage: pedidoCentral, catalog: menuCentral });
assert(anotadoCentral.applied && !anotadoCentral.missing, "el pedido de La Central se anota sin huecos inventados");
const lineaCentral = (re: RegExp) => anotadoCentral.items.find((item) => re.test(item.nombre_producto));
assert(lineaCentral(/^Arrachera Marinada$/)?.cantidad === 1, "arrachera marinada queda en 1");
assert(lineaCentral(/^Bistec de puerco marinado$/)?.cantidad === 1, "bistec de puerco marinado no cae en el de res ni en el sin marinar");
assert(lineaCentral(/^Peinesillo$/)?.cantidad === 1, "peinesillo se anota");
assert(lineaCentral(/^Diezmillo$/)?.cantidad === 1, "diezmillo se anota");
assert(lineaCentral(/^Chamberete$/)?.cantidad === 1, "chamberete se anota");
assert(lineaCentral(/^Ribeye de res con hueso$/)?.cantidad === 1, "ribeye se anota con el nombre del menú");
assert(lineaCentral(/^Carbón fino$/)?.cantidad === 1, "carbón firo se guarda como Carbón fino");
assert(lineaCentral(/^Salsa Hot Wings$/)?.cantidad === 1, "hot wins es Salsa Hot Wings");
assert(anotadoCentral.items.length === 8, "el pedido de La Central son ocho líneas");
assert(!anotadoCentral.items.some((item) => /pollo/i.test(item.nombre_producto)), "hablar de la carnicería no inventa pollo");
const precioCentral = priceCatalogOrder(anotadoCentral.items, menuCentral);
assert(precioCentral.subtotal === 280 + 120 + 215 + 215 + 155 + 210 + 75 + 55, "los precios del menú se suman");
const ticketCentral = formatCatalogReceiptFee(precioCentral.subtotal);
assert(ticketCentral.includes("$25") && !ticketCentral.includes("$35") && !customerCopySplitsFee(ticketCentral), "el ticket de La Central es un solo $25");
const listaCentral = formatProductListConfirm(anotadoCentral.items);
assert(listaCentral.includes("¿Están bien estos productos?"), "antes del GPS se vuelve a listar");
assert(/arrachera marinada/i.test(listaCentral) && /carb[oó]n fino/i.test(listaCentral) && /hot wings/i.test(listaCentral), "la lista trae arrachera, carbón fino y hot wings");
const enLaCentral = classifyCustomerTurn({
  message: pedidoCentral,
  lastBotText: centralMenuText,
  hasBusiness: true,
  hasItems: false,
  businessId: laCentral.id,
  stores,
});
assert(enLaCentral.type === "continue", "el pedido de La Central no vuelve a pedir el filtro ni la foto");
assert(classifyProductListReply("SÍ") === "confirm" && isYesConfirmation("SÍ"), "un SÍ limpio sigue a la dirección");
const faltaronDiezmillo = "Sí, te faltó el diezmillo";
assert(classifyProductListReply(faltaronDiezmillo) === "revise", "te faltó en La Central se revisa");
assert(!isYesConfirmation(faltaronDiezmillo), "te faltó no es el SÍ del GPS");
assert(!shouldEscalateComplaint(faltaronDiezmillo, { editingOrder: true }), "te faltó en la lista no avisa al admin");
const agregaChamberete = "agrega chamberete";
assert(classifyProductListReply(agregaChamberete) === "revise", "agrega en La Central se revisa");
assert(!shouldEscalateComplaint("y te faltaron el peinesillo", { editingOrder: true }), "te faltaron en la lista no avisa al admin");
assert(shouldEscalateComplaint("y te faltaron el peinesillo", { editingOrder: false }), "faltaron fuera de la captura sigue siendo queja");
const sumadoCentral = applyCatalogSpeech({
  base: anotadoCentral.items.filter((item) => !/diezmillo|chamberete/i.test(item.nombre_producto)),
  userMessage: "te faltaron el diezmillo y agrega chamberete",
  catalog: menuCentral,
});
assert(sumadoCentral.applied, "faltaron y agrega se anotan en el menú fijo");
assert(sumadoCentral.items.some((item) => item.nombre_producto === "Diezmillo"), "el diezmillo que faltó entra");
assert(sumadoCentral.items.some((item) => item.nombre_producto === "Chamberete"), "el chamberete agregado entra");
assert(formatProductListConfirm(sumadoCentral.items).includes("¿Están bien estos productos?"), "después de corregir se vuelve a listar");
const marinado = applyCatalogSpeech({
  base: [],
  userMessage: "bistec de puerco marinada",
  catalog: menuCentral,
});
assert(marinado.items[0]?.nombre_producto === "Bistec de puerco marinado", "marinada y marinado son el mismo corte");
const costillaSola = applyCatalogSpeech({
  base: [],
  userMessage: "una costilla de puerco",
  catalog: menuCentral,
});
assert(costillaSola.items[0]?.nombre_producto === "Costilla de puerco" && costillaSola.items[0]?.cantidad === 1, "costilla de puerco no se va a la marinada");
const conPeso = applyCatalogSpeech({
  base: [],
  userMessage: "2 kilos de arrachera marinada",
  catalog: menuCentral.map((row) =>
    row.nombreProducto === "Arrachera Marinada" ? { ...row, nombreProducto: "Arrachera Marinada 1kg" } : row,
  ),
});
assert(
  conPeso.items[0]?.nombre_producto === "Arrachera Marinada 1kg" && conPeso.items[0]?.cantidad === 2,
  "2 kilos no se pierden y el 1kg del nombre no estorba",
);
const kiloSuelto = applyCatalogSpeech({
  base: [],
  userMessage: "1 kg de diezmillo",
  catalog: menuCentral,
});
assert(kiloSuelto.items[0]?.nombre_producto === "Diezmillo" && kiloSuelto.items[0]?.cantidad === 1, "1 kg de diezmillo es una unidad");
const medio = applyCatalogSpeech({
  base: [],
  userMessage: "medio kilo de chorizo",
  catalog: menuCentral,
});
assert(medio.items[0]?.nombre_producto === "Chorizo" && medio.items[0]?.cantidad === 0.5, "medio kilo de chorizo no es el argentino ni un kilo");
const fino = applyCatalogSpeech({
  base: [],
  userMessage: "un carbón fino",
  catalog: menuCentral,
});
assert(fino.items[0]?.nombre_producto === "Carbón fino", "carbón fino se anota con el nombre del menú");
for (const phrase of ["carbón firo", "fino", "firo", "carbón"]) {
  const carbon = applyCatalogSpeech({ base: [], userMessage: phrase, catalog: menuCentral });
  assert(carbon.items[0]?.nombre_producto === "Carbón fino", `${phrase} también es Carbón fino`);
}
const pulpa = applyCatalogSpeech({
  base: [],
  userMessage: "una pulpa de puerco",
  catalog: menuCentral,
});
assert(pulpa.items[0]?.nombre_producto === "Pulpa de puerco" && pulpa.items[0]?.cantidad === 1, "pulpa de puerco se anota");
const pulpaSola = applyCatalogSpeech({ base: [], userMessage: "pulpa", catalog: menuCentral });
assert(pulpaSola.items[0]?.nombre_producto === "Pulpa de puerco", "pulpa sola es Pulpa de puerco");
const pastorViejo = applyCatalogSpeech({ base: [], userMessage: "carne al pastor", catalog: menuCentral });
assert(pastorViejo.items[0]?.nombre_producto === "Carne de puerco al pastor", "carne al pastor usa el nombre del menú");
const pollo = applyCatalogSpeech({
  base: [],
  userMessage: "un pollo",
  catalog: menuCentral,
});
assert(!pollo.applied || !pollo.items.some((item) => /pollo/i.test(item.nombre_producto)), "pollo no matchea el menú");
const bistecVago = applyCatalogSpeech({ base: [], userMessage: "un bistec", catalog: menuCentral });
assert(!bistecVago.applied, "bistec solo no escoge un corte");
const desdeZagu = classifyCustomerTurn({
  message: "Carnicerías",
  lastBotText: "Va, de ZAGU. Dime qué se te antoja.",
  hasBusiness: true,
  hasItems: false,
  businessId: zagu.id,
  stores,
});
assert(desdeZagu.type === "pick_store" && desdeZagu.store.id === laCentral.id, "aceptar carnicerías con una sola tienda suelta a ZAGU");

const pedidoEnGeorge = classifyCustomerTurn({
  message: pedido83,
  lastBotText: "Menú de Hamburguesas Hotdogs George",
  hasBusiness: true,
  hasItems: false,
  businessId: george.id,
  stores,
});
assert(pedidoEnGeorge.type === "continue", "el pedido completo de George no vuelve a pedir el menú");

const pedido73 = {
  businessId: 1,
  businessName: "Abarrotes ZAGU",
  businessPhone: "5213311111111",
  addressText: "Ubicación compartida por WhatsApp",
  latitud: 20.8658,
  longitud: -103.24,
  items: [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
};
const galletasEnConfirmacion = planConfirmationAmendment({
  pedidoId: 73,
  message: "Quiero unas galletas",
  snapshot: pedido73,
  quoteStore: true,
  knownZoneNames: ["Centro"],
});
assert(galletasEnConfirmacion.kind === "amend", "agregar galletas durante la confirmación no repite el resumen viejo");
if (galletasEnConfirmacion.kind === "amend") {
  assert(galletasEnConfirmacion.pedidoId === 73, "se queda el pedido #73");
  assert(
    galletasEnConfirmacion.items.some((item) => /coca/i.test(item.nombre_producto)),
    "la Coca que ya estaba sigue en el pedido",
  );
  assert(
    galletasEnConfirmacion.items.some((item) => /galleta/i.test(item.nombre_producto)),
    "las galletas entran al mismo pedido",
  );
  assert(galletasEnConfirmacion.items.length === 2, "no se abre otro pedido ni se duplica la Coca");
  const resumen = confirmationCustomerMessage({
    pedidoId: galletasEnConfirmacion.pedidoId,
    snapshot: { ...pedido73, items: galletasEnConfirmacion.items },
    items: galletasEnConfirmacion.items,
    readyForConfirmation: galletasEnConfirmacion.readyForConfirmation,
    question: galletasEnConfirmacion.question,
    feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
  });
  assert(resumen.includes("Pedido #73"), "el resumen sigue siendo el pedido #73");
  assert(/coca/i.test(resumen) && /galleta/i.test(resumen), "el resumen trae la Coca y las galletas");
  assert(resumen.includes("$25") && !resumen.includes("$35"), "el cargo del resumen es $25");
  assert(!customerCopySplitsFee(resumen), "el resumen no parte el cargo");
}
for (const si of ["SÍ", "sí", "ok", "va", "confirmo"]) {
  const plan = planConfirmationAmendment({
    pedidoId: 73,
    message: si,
    snapshot: pedido73,
    quoteStore: true,
  });
  assert(plan.kind === "confirm", `"${si}" sigue confirmando`);
}
assert(
  planConfirmationAmendment({ pedidoId: 73, message: "cancela", snapshot: pedido73, quoteStore: true }).kind === "keep",
  "cancelar no se mezcla con agregar productos",
);
assert(
  planConfirmationAmendment({ pedidoId: 73, message: "pedido nuevo", snapshot: pedido73, quoteStore: true }).kind === "keep",
  "pedido nuevo no se mezcla con agregar productos",
);
assert(
  planConfirmationAmendment({ pedidoId: 73, message: "", snapshot: pedido73, quoteStore: true }).kind === "keep",
  "un pin sin texto no cambia los productos",
);
assert(
  planConfirmationAmendment({ pedidoId: 73, message: "Quiero unas galletas", snapshot: pedido73, quoteStore: false }).kind === "keep",
  "sin catálogo, el menú fijo no dispara preguntas de abarrotes",
);
for (const sucio of ["OK, pero te equivocaste", "sí, pero quítale el frijol", "ok cambia la coca", "va, no es eso", "confirmo, era lentejas no frijol"]) {
  assert(!isYesConfirmation(sucio), `"${sucio}" no confirma`);
  assert(
    planConfirmationAmendment({ pedidoId: 73, message: sucio, snapshot: pedido73, quoteStore: true }).kind !== "confirm",
    `"${sucio}" no despacha el pedido`,
  );
}
for (const limpio of ["SÍ", "ok", "va", "confirmo"]) {
  assert(isYesConfirmation(limpio), `"${limpio}" sigue siendo un sí limpio`);
}

const vistosCinco: PedidoItemInput[] = [
  { nombre_producto: "Frijol", marca: "Lentejas", presentacion: "negro", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Lentejas", marca: "genéricas", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Limpiador", marca: "Fabuloso", presentacion: "1 litro", cantidad: 1, unidad: "litro" },
  { nombre_producto: "Refresco", marca: "Fusi", cantidad: 1, unidad: "pieza" },
  { nombre_producto: "Frutos Rojos Fusi", cantidad: 1, unidad: "pieza" },
  { nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
];
const correccionFusi =
  "OK, pero te equivocaste: las lentejas son genéricas y el Fusi no es refresco, es frutos rojos";
const corregido = quoteCheck(vistosCinco, correccionFusi);
assert(corregido.validatedItems.items.length === 5, "la corrección deja las 5 líneas, no 6");
const frijolCorregido = corregido.validatedItems.items.find((item) => /frijol/i.test(item.nombre_producto));
const lentejasCorregidas = corregido.validatedItems.items.find((item) => /lenteja/i.test(item.nombre_producto));
const fabulosoCorregido = corregido.validatedItems.items.find((item) => /fabuloso/i.test(`${item.nombre_producto} ${item.marca ?? ""}`));
const fusiLineas = corregido.validatedItems.items.filter((item) => /fusi/i.test(`${item.nombre_producto} ${item.marca ?? ""}`));
assert(Boolean(frijolCorregido) && !/lenteja/i.test(String(frijolCorregido?.marca ?? "")), "lentejas no se quedan como marca del frijol");
assert(/negro/i.test(String(frijolCorregido?.presentacion)) && frijolCorregido?.cantidad === 1, "el frijol sigue negro de 1 kilo");
assert(Boolean(lentejasCorregidas) && !/generic/i.test(String(lentejasCorregidas?.marca ?? "")), "genéricas no se guarda como marca");
assert(/gen[eé]ricas/i.test(String(lentejasCorregidas?.notas ?? "")), "son genéricas queda en la nota");
assert(Boolean(fabulosoCorregido) && /litro/i.test(`${fabulosoCorregido?.unidad ?? ""} ${fabulosoCorregido?.presentacion ?? ""}`), "el Fabuloso sigue en un litro");
assert(fusiLineas.length === 1, "Fusi no sale dos veces");
assert(/frutos rojos/i.test(fusiLineas[0]?.nombre_producto ?? ""), "el Fusi que se cotiza es frutos rojos");
assert(!/^refresco$/i.test(fusiLineas[0]?.nombre_producto ?? ""), "el Fusi ya no se manda como refresco");
const preguntaCorreccion = corregido.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(!/el lentejas|el gen[eé]ricas/i.test(preguntaCorreccion), "no pregunta El Lentejas ni El genéricas");
assert(corregido.readyForConfirmation, "con la corrección el mandado ya se puede confirmar");
const resumenCorregido = confirmationCustomerMessage({
  pedidoId: 78,
  snapshot: { ...pedido73, items: corregido.validatedItems.items },
  items: corregido.validatedItems.items,
  readyForConfirmation: true,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
for (const item of corregido.validatedItems.items) {
  const linea = formatSpecificItemLine(item);
  assert(resumenCorregido.includes(linea), `el resumen trae la misma línea que iría a la tienda: ${linea}`);
  assert(!/Frijol, Lentejas/i.test(linea), "el ticket no pega lentejas en el frijol");
}
assert(!/refresco,\s*fusi/i.test(resumenCorregido), "el resumen no manda Fusi como refresco");

const lentejasGenericas = quoteCheck([{ nombre_producto: "Lentejas", cantidad: 1, unidad: "kilo" }], "son genéricas");
assert(lentejasGenericas.readyForConfirmation, "son genéricas cierra la marca de las lentejas");
assert(!/el gen[eé]ricas|el lentejas/i.test(lentejasGenericas.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "no re-pregunta con El genéricas");
const galletasGenericas = quoteCheck([{ nombre_producto: "Galletas" }], "son genéricas");
const preguntaGalletaGenerica = galletasGenericas.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/galleta/i.test(preguntaGalletaGenerica) && !/de qué marca/i.test(preguntaGalletaGenerica), "son genéricas no vuelve a pedir la marca");
assert(!/el gen[eé]ricas/i.test(preguntaGalletaGenerica), "la pregunta de las galletas no dice El genéricas");

const pedidoGeorge = {
  businessId: 7,
  businessName: "Hamburguesas Hotdogs George",
  businessPhone: "5213322222222",
  addressText: "Ubicación compartida por WhatsApp",
  latitud: 20.8658,
  longitud: -103.24,
  items: [{ nombre_producto: "Hamburguesa sencilla", cantidad: 1 }],
};
const sumaDogo = planConfirmationAmendment({
  pedidoId: 80,
  message: "y también un dogo de arrachera",
  snapshot: pedidoGeorge,
  quoteStore: false,
  catalog: menuGeorge,
});
assert(sumaDogo.kind === "amend", "en George, sumar un dogo durante la confirmación actualiza el pedido");
if (sumaDogo.kind === "amend") {
  assert(sumaDogo.items.some((item) => /hamburguesa sencilla/i.test(item.nombre_producto)), "la hamburguesa se queda");
  assert(sumaDogo.items.some((item) => /dogo arrachera/i.test(item.nombre_producto)), "el dogo entra al mismo pedido");
  assert(sumaDogo.readyForConfirmation, "el dogo del menú no pide marca de abarrotes");
  assert(!/pétalo|rollos|lala/i.test(sumaDogo.question ?? ""), "George no hace preguntas de tiendita");
}
const quitaDogo = planConfirmationAmendment({
  pedidoId: 80,
  message: "OK, pero te equivocaste, quita el dogo",
  snapshot: {
    ...pedidoGeorge,
    items: [
      { nombre_producto: "Hamburguesa sencilla", cantidad: 1 },
      { nombre_producto: "Dogo arrachera", cantidad: 1 },
    ],
  },
  quoteStore: false,
  catalog: menuGeorge,
});
assert(quitaDogo.kind === "amend", "quitar el dogo corrige el pedido y no confirma");
if (quitaDogo.kind === "amend") {
  assert(quitaDogo.items.length === 1 && /hamburguesa/i.test(quitaDogo.items[0]?.nombre_producto ?? ""), "se queda solo la hamburguesa");
}
const grandeEnConfirmacion = applyCatalogSpeech({
  base: marYTierra.items,
  userMessage: "grande",
  catalog: menuGeorge,
});
assert(/grande/i.test(grandeEnConfirmacion.items[0]?.nombre_producto ?? ""), "grande cierra el tamaño que faltaba");
assert(!grandeEnConfirmacion.missing, "con el tamaño dicho ya no se pregunta");

const unionDeItems = mergeSnapshot({
  currentSnapshot: {
    businessId: 1,
    businessName: "Abarrotes ZAGU",
    items: [{ nombre_producto: "Coca", presentacion: "2 litros", cantidad: 1 }],
  },
  llmOrderState: { items: [{ nombre_producto: "Galletas" }] },
});
assert((unionDeItems.items ?? []).length === 2, "unir no tira la Coca cuando el turno solo trae galletas");
assert(
  (unionDeItems.items ?? []).some((item) => /coca/i.test(item.nombre_producto) && /2 litros/i.test(String(item.presentacion))),
  "la Coca conserva los 2 litros",
);
assert((unionDeItems.items ?? []).some((item) => /galleta/i.test(item.nombre_producto)), "las galletas se suman");
const cambioDeTienda = mergeSnapshot({
  currentSnapshot: {
    businessId: 1,
    businessName: "Abarrotes ZAGU",
    items: [{ nombre_producto: "Coca", presentacion: "2 litros", cantidad: 1 }],
  },
  llmOrderState: {
    business_id: george.id,
    business_name: george.nombre,
    items: [{ nombre_producto: "Hamburguesa sencilla" }],
  },
  forceBusiness: true,
  forceReplaceItems: true,
});
assert((cambioDeTienda.items ?? []).length === 1, "cambiar de tienda sí reemplaza la lista");
assert(/hamburguesa/i.test(cambioDeTienda.items?.[0]?.nombre_producto ?? ""), "en la tienda nueva queda la hamburguesa");

const prompt = buildMandaloSystemPrompt({
  negociosDisponibles: "ZAGU",
  negociosCerrados: "(ninguno)",
  repartidoresActivos: "(ninguno)",
  zonasCobertura: "Calle Hidalgo",
  historial: "",
  saludoInicial: "Hola",
  horarioMandaloText: "de 3pm a 9pm",
  categoriasTienda: "(no aplica)",
});
assert(prompt.includes("del que sea") && prompt.includes("la más barata") && prompt.includes("cualquiera"), "el prompt acepta que el cliente deje la elección");
assert(prompt.includes("Lala") && prompt.includes("Pétalo") && prompt.includes("Ciel"), "el prompt trae ejemplos, no un catálogo cerrado");
assert(prompt.includes("no reenvíes") || prompt.includes("No reenvíes"), "el prompt no manda a reenviar menús");
assert(prompt.includes("foto del menú"), "el flujo de foto de George sigue en el prompt");
assert(prompt.includes("pasa el menú"), "el prompt manda el menú al nombrar o elegir el restaurante");
assert(prompt.includes("suelta la tienda anterior"), "el prompt suelta la tienda al cambiar de categoría");
assert(prompt.includes("dos hamburguesas = 2"), "el prompt no deja caer la cantidad del menú");
assert(prompt.includes("$25") && !prompt.includes("$35"), "el prompt cobra $25 y no el monto viejo");
assert(prompt.includes("cada uno es su propio item"), "el prompt no junta varios productos en un nombre");
assert(prompt.includes("¿Están bien estos productos?"), "el prompt no pide GPS antes de confirmar los productos");

const pedidoAguaSanta =
  "Quiero un kilo de azúcar dos Tanks de horchata, un kilo de arroz y una coca de 2 l";
const sinDireccion = {
  businessId: 1,
  businessName: "Agua Santa",
};
const partido = validateCaptureForConfirmation({
  snapshot: { ...sinDireccion, items: [] },
  items: [],
  quoteStore: true,
  userMessage: pedidoAguaSanta,
});
assert(partido.validatedItems.items.length >= 4, "azúcar, tanks, arroz y coca quedan en líneas distintas");
const lineaAzucar = partido.validatedItems.items.find((item) => /az[uú]car/i.test(item.nombre_producto));
const lineaTanks = partido.validatedItems.items.find((item) => /tanks|tanques/i.test(item.nombre_producto));
const lineaArroz = partido.validatedItems.items.find((item) => /arroz/i.test(item.nombre_producto));
const lineaCoca = partido.validatedItems.items.find((item) => /coca|refresco/i.test(item.nombre_producto));
assert(lineaAzucar != null && lineaTanks != null && lineaArroz != null && lineaCoca != null, "las cuatro líneas existen");
assert(!/horchata|tanks|tanques/i.test(lineaAzucar?.nombre_producto ?? ""), "el azúcar no se pega a la horchata");
assert(/horchata/i.test(lineaTanks?.nombre_producto ?? ""), "los tanks de horchata son su propio producto");
assert(lineaTanks?.cantidad === 2, "los tanks quedan en 2");
assert(/paquete/i.test(String(lineaTanks?.unidad ?? "")), "los tanks se anotan como paquetes");
assert(lineaAzucar?.cantidad === 1 && /kilo/i.test(String(lineaAzucar?.unidad ?? "")), "el azúcar queda en 1 kilo");
assert(/2 litro/i.test(String(lineaCoca?.presentacion ?? "")), "la coca queda de 2 litros");
assert(
  !partido.validatedItems.items.some((item) => /az[uú]car/i.test(item.nombre_producto) && /horchata|tanks/i.test(item.nombre_producto)),
  "ninguna línea junta azúcar y tanks",
);
const preguntaPrimera = partido.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/arroz/i.test(preguntaPrimera) && /marca/i.test(preguntaPrimera), "el arroz sigue pidiendo marca antes de la lista");
assert(!preguntaPrimera.includes("¿Están bien estos productos?"), "no se confirma la lista mientras falta la marca");
assert(!preguntaPrimera.includes("ubicación por GPS"), "tampoco se pide GPS mientras falta la marca");

const pegados = validateCaptureForConfirmation({
  snapshot: {
    ...sinDireccion,
    items: [
      { nombre_producto: "Azúcar Tanks Horchata", cantidad: 1, unidad: "kilo" },
      { nombre_producto: "Arroz", marca: "Quieres Valle", cantidad: 1, unidad: "kilo" },
      { nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1 },
    ],
  },
  items: [
    { nombre_producto: "Azúcar Tanks Horchata", cantidad: 1, unidad: "kilo" },
    { nombre_producto: "Arroz", marca: "Quieres Valle", cantidad: 1, unidad: "kilo" },
    { nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1 },
  ],
  quoteStore: true,
  userMessage: pedidoAguaSanta,
});
assert(pegados.validatedItems.items.length >= 4, "si la IA los pega, el corte los vuelve a separar");
assert(
  !pegados.validatedItems.items.some((item) => /quieres/i.test(String(item.marca ?? ""))),
  "Quieres Valle no se queda pegado en el primer mensaje",
);

const arrozConMarca = validateCaptureForConfirmation({
  snapshot: { ...sinDireccion, items: partido.validatedItems.items },
  items: partido.validatedItems.items,
  quoteStore: true,
  userMessage: "Si quieres valle",
});
const arrozMarcado = arrozConMarca.validatedItems.items.find((item) => /arroz/i.test(item.nombre_producto));
assert(/verde valle/i.test(String(arrozMarcado?.marca ?? "")), "Si quieres valle se anota como Verde Valle");
assert(!/quieres/i.test(String(arrozMarcado?.marca ?? "")), "Quieres no se queda como marca");
assert(arrozConMarca.validatedItems.items.length >= 4, "la marca del arroz no borra las otras líneas");

const listaProductos = buildCustomerMessage({
  validation: arrozConMarca,
  snapshot: { ...sinDireccion, items: arrozConMarca.validatedItems.items },
  items: arrozConMarca.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(listaProductos.startsWith("OK, pediste:"), "con los productos claros se listan antes de la dirección");
assert(listaProductos.includes("¿Están bien estos productos?"), "se pregunta si los productos están bien");
assert(!listaProductos.includes("ubicación por GPS"), "esa lista no pide GPS");
assert(!listaProductos.includes("$35") && !listaProductos.includes("$25"), "la lista de productos no adelanta el cargo");
assert(/az[uú]car/i.test(listaProductos) && /horchata/i.test(listaProductos) && /arroz/i.test(listaProductos) && /coca|refresco/i.test(listaProductos), "la lista trae los cuatro");
assert(!arrozConMarca.readyForConfirmation, "sin dirección y sin SÍ de productos no hay ticket final");

const jitomateSinDireccion = validateCaptureForConfirmation({
  snapshot: { ...sinDireccion, items: [{ nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" }] },
  items: [{ nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" }],
  quoteStore: true,
  userMessage: "2 kilos de jitomate",
});
const preguntaJitomate = buildCustomerMessage({
  validation: jitomateSinDireccion,
  snapshot: sinDireccion,
  items: jitomateSinDireccion.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(preguntaJitomate.includes("¿Están bien estos productos?"), "un producto ya claro también se confirma antes del GPS");
assert(!preguntaJitomate.includes("ubicación por GPS"), "el jitomate listo no pide GPS todavía");
assert(formatProductListConfirm(jitomateSinDireccion.validatedItems.items).includes("✅ "), "la lista va en viñetas");
assert(formatProductListConfirm(jitomateSinDireccion.validatedItems.items).includes("\n\n✅ "), "hay aire entre los bloques de la lista");

const jitomateConfirmado = validateCaptureForConfirmation({
  snapshot: {
    ...sinDireccion,
    items: jitomateSinDireccion.validatedItems.items,
    flags: { productosConfirmados: true },
  },
  items: jitomateSinDireccion.validatedItems.items,
  quoteStore: true,
  userMessage: "",
});
const pideGps = buildCustomerMessage({
  validation: jitomateConfirmado,
  snapshot: { ...sinDireccion, flags: { productosConfirmados: true } },
  items: jitomateConfirmado.validatedItems.items,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
assert(pideGps === ADDRESS_ASK_MESSAGE, "después del SÍ de productos se pide el GPS de siempre");
assert(!pideGps.includes("¿Están bien estos productos?"), "ya no se repite la lista");

const lecheSinCerrar = validateCaptureForConfirmation({
  snapshot: { ...sinDireccion, items: [] },
  items: [],
  quoteStore: true,
  userMessage: "dos litros de leche",
});
const preguntaLeche = lecheSinCerrar.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
assert(/Lala/.test(preguntaLeche), "si falta la marca no se adelanta la lista de productos");
assert(!preguntaLeche.includes("¿Están bien estos productos?"), "la aclaración de marca va antes de confirmar la lista");
assert(!lecheSinCerrar.readyForConfirmation, "la leche incompleta no se confirma");

for (const rechazo of ["No", "No.", "No está correcto", "no esta correcto", "no es correcto"]) {
  assert(isBareOrderRejection(rechazo), `"${rechazo}" cancela la confirmación inicial`);
  const plan = planConfirmationAmendment({
    pedidoId: 79,
    message: rechazo,
    snapshot: pedido73,
    quoteStore: true,
  });
  assert(plan.kind === "cancel", `"${rechazo}" no reimprime el resumen`);
}
assert(!isBareOrderRejection("no, quita el frijol"), "una corrección con quita no cancela");
assert(!isBareOrderRejection("no, sepáralos"), "pedir que se separen no cancela");
assert(!isBareOrderRejection("cancela"), "cancela sigue en el camino de siempre");
assert(!isBareOrderRejection("pedido nuevo"), "pedido nuevo sigue en el camino de siempre");
assert(isNoConfirmation("No"), "el no del precio final sigue siendo un no");
assert(isNoConfirmation("No está correcto"), "no está correcto sigue cancelando en confirmado_tiendas");
assert(
  planConfirmationAmendment({ pedidoId: 73, message: "Quiero unas galletas", snapshot: pedido73, quoteStore: true }).kind === "amend",
  "agregar en la confirmación no se volvió cancelación",
);
assert(isYesConfirmation("SÍ") && isYesConfirmation("ok"), "el sí de productos y del ticket no cambió");
const flowSrc = readFileSync("src/lib/mandaloFlow.ts", "utf8");
assert(flowSrc.includes("cliente_rechazo_confirmacion_inicial"), "un no en el primer resumen cancela el pedido");
assert(flowSrc.includes("cliente_rechazo_productos"), "un no en la lista de productos cancela el pedido");
assert(flowSrc.includes("awaitingProductConfirm"), "el sí de la lista no es el sí del ticket final");
assert(flowSrc.includes("classifyProductListReply"), "el sí con corrección no se trata como el sí del GPS");
assert(flowSrc.includes("productos_corregidos"), "una corrección en la lista se guarda antes de volver a preguntar");
assert(flowSrc.includes("shouldEscalateComplaint"), "te faltaron durante la captura no se manda como queja");
assert(flowSrc.includes("reviseFixedCatalogProductList"), "el menú fijo también corrige y vuelve a listar");
assert(!flowSrc.includes("usaCatalogoFijo === true) return null"), "corregir en George ya no se ignora");

const tiendaSinGps = { businessId: 1, businessName: "Abarrotes" };
function quoteSinGps(items: PedidoItemInput[], userMessage: string, flags?: { productosConfirmados?: boolean; awaitingProductConfirm?: boolean }) {
  return validateCaptureForConfirmation({
    snapshot: { ...tiendaSinGps, items, ...(flags ? { flags } : {}) },
    items,
    quoteStore: true,
    userMessage,
  });
}
function listaDe(result: ReturnType<typeof quoteSinGps>) {
  return buildCustomerMessage({
    validation: result,
    snapshot: tiendaSinGps,
    items: result.validatedItems.items,
    feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
  });
}

for (const corta of ["Blanca", "La quiero blanca", "Morada"]) {
  const cerrada = quoteSinGps([{ nombre_producto: "Cebolla", cantidad: 1, unidad: "kilo" }], corta);
  const linea = cerrada.validatedItems.items[0];
  assert(cerrada.validatedItems.allItemsSpecific, `"${corta}" cierra la cebolla`);
  assert(/blanca|morada/i.test(String(linea?.presentacion)), `"${corta}" guarda el tipo`);
  const pregunta = listaDe(cerrada);
  assert(pregunta.includes("¿Están bien estos productos?"), `"${corta}" pasa a la lista`);
  assert(!/blanca o morada/i.test(pregunta), `"${corta}" no vuelve a preguntar el tipo`);
  assert(!pregunta.includes("ubicación por GPS"), `"${corta}" no pide GPS`);
}

const blancaAunqueFalteFrijol = quoteSinGps(
  [
    { nombre_producto: "Frijol", cantidad: 1, unidad: "kilo" },
    { nombre_producto: "Cebolla", cantidad: 1, unidad: "kilo" },
  ],
  "Blanca",
);
const cebollaBlanca = blancaAunqueFalteFrijol.validatedItems.items.find((item) => /cebolla/i.test(item.nombre_producto));
assert(/blanca/i.test(String(cebollaBlanca?.presentacion)), "blanca se anota en la cebolla aunque el frijol siga abierto");
assert(!/blanca/i.test(String(blancaAunqueFalteFrijol.validatedItems.items.find((item) => /frijol/i.test(item.nombre_producto))?.presentacion ?? "")), "blanca no se le pega al frijol");

const chileCorto = quoteSinGps([{ nombre_producto: "Chile", cantidad: 1, unidad: "kilo" }], "jalapeño");
assert(/jalapeño/i.test(String(chileCorto.validatedItems.items[0]?.presentacion)), "jalapeño cierra el chile sin repetir el nombre");
assert(chileCorto.validatedItems.allItemsSpecific, "el chile con variedad y kilos ya se puede listar");
assert(!/jalapeño, serrano/i.test(listaDe(chileCorto)), "no vuelve a preguntar el chile");

const aceiteCorto = quoteSinGps([{ nombre_producto: "Aceite" }], "Nutrioli");
assert(/nutrioli/i.test(String(aceiteCorto.validatedItems.items[0]?.marca)), "Nutrioli cierra la marca del aceite sin decir aceite");
assert(/tamaño|litro/i.test(aceiteCorto.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? ""), "al aceite solo le falta el tamaño");
const jamonClaro = quoteSinGps([{ nombre_producto: "Jamón" }], "FUD");
assert(/fud/i.test(String(jamonClaro.validatedItems.items[0]?.marca)), "FUD cierra la marca del jamón sin decir jamón");
const jamonCuarto = quoteSinGps([{ nombre_producto: "Jamón", marca: "FUD" }], "1/4");
assert(jamonCuarto.validatedItems.items[0]?.cantidad === 0.25, "1/4 del jamón queda en un cuarto de kilo");
assert(/1\/4/.test(String(jamonCuarto.validatedItems.items[0]?.presentacion)), "el jamón muestra 1/4");
const cuartoNuevo = quoteSinGps([], "un cuarto de jamón");
assert(/jam[oó]n/i.test(cuartoNuevo.validatedItems.items[0]?.nombre_producto ?? ""), "un cuarto de jamón abre la línea");
assert(cuartoNuevo.validatedItems.items[0]?.cantidad === 0.25, "un cuarto queda en 0.25 kg");
assert(!/cuarto/i.test(String(cuartoNuevo.validatedItems.items[0]?.marca ?? "")), "cuarto no se guarda como marca");
const gramosJamon = quoteSinGps([], "250 g de jamón");
assert(gramosJamon.validatedItems.items[0]?.cantidad === 250, "250 g de jamón no se pierde");
assert(/250/.test(String(gramosJamon.validatedItems.items[0]?.presentacion)), "250 g queda en la presentación");

const mandado80 = "1 kg frijol, 1 kg arroz, 1 kg cebolla, 1/4 jamón, 1 L leche, Coca 2 L";
const pedido80 = quoteSinGps([], mandado80);
const jamon80 = pedido80.validatedItems.items.find((item) => /jam[oó]n/i.test(item.nombre_producto));
assert(jamon80 != null, "el jamón con cantidad no se pierde del mensaje");
assert(jamon80?.cantidad === 0.25, "el 1/4 de jamón no se vuelve otra cantidad");
assert(pedido80.validatedItems.items.some((item) => /frijol/i.test(item.nombre_producto)), "el frijol sigue en el mandado");
assert(pedido80.validatedItems.items.some((item) => /arroz/i.test(item.nombre_producto)), "el arroz sigue en el mandado");
assert(pedido80.validatedItems.items.some((item) => /cebolla/i.test(item.nombre_producto)), "la cebolla sigue en el mandado");
assert(pedido80.validatedItems.items.some((item) => /leche/i.test(item.nombre_producto)), "la leche sigue en el mandado");
assert(pedido80.validatedItems.items.some((item) => /coca|refresco/i.test(item.nombre_producto)), "la coca sigue en el mandado");
const aceiteYJamon = quoteSinGps([], "1 litro de aceite y 1/4 de jamón");
assert(aceiteYJamon.validatedItems.items.some((item) => /aceite/i.test(item.nombre_producto)), "el aceite con cantidad no se pierde");
assert(aceiteYJamon.validatedItems.items.some((item) => /jam[oó]n/i.test(item.nombre_producto)), "el jamón sigue junto al aceite");

assert(classifyProductListReply("Sí") === "confirm", "un sí limpio confirma la lista");
assert(classifyProductListReply("Sí, nomás que la cebolla es blanca") === "revise", "sí, nomás que no es un sí limpio");
assert(classifyProductListReply("sí, solo que la cebolla es blanca") === "revise", "sí, solo que corrige");
assert(classifyProductListReply("sí pero la cebolla es blanca") === "revise", "sí pero corrige");
assert(classifyProductListReply("No") === "cancel", "un no en la lista sigue cancelando");
assert(isProductListRequest("Me puedes pasar otra vez la lista"), "pedir la lista otra vez se reconoce");
assert(isProductListRequest("pásame la lista"), "pásame la lista se reconoce");
assert(!isProductListRequest("pásame el menú"), "el menú no es la lista del pedido");
assert(isYesConfirmation("SÍ") && !isYesConfirmation("Sí, nomás que la cebolla es blanca"), "el sí del ticket no se confunde con una corrección");

const casiListo = [
  { nombre_producto: "Frijol", presentacion: "negro", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Arroz", marca: "SOS", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Cebolla", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Jamón", marca: "FUD", presentacion: "1/4 kg", cantidad: 0.25, unidad: "kilo" },
  { nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 1, unidad: "litro" },
  { nombre_producto: "Refresco", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
];
const nomasQue = quoteSinGps(casiListo, "Sí, nomás que la cebolla es blanca", { awaitingProductConfirm: true });
const cebollaCorregida = nomasQue.validatedItems.items.find((item) => /cebolla/i.test(item.nombre_producto));
assert(/blanca/i.test(String(cebollaCorregida?.presentacion)), "nomás que blanca corrige la cebolla");
assert(nomasQue.validatedItems.items.some((item) => /jam[oó]n/i.test(item.nombre_producto)), "la corrección no borra el jamón");
const listaCorregida = listaDe(nomasQue);
assert(listaCorregida.includes("¿Están bien estos productos?"), "después de nomás que se vuelve a listar");
assert(/blanca/i.test(listaCorregida), "la lista nueva dice blanca");
assert(!listaCorregida.includes("ubicación por GPS"), "la corrección no salta al GPS");

const conBlanca = nomasQue.validatedItems.items;
const otraVez = quoteSinGps(conBlanca, "Me puedes pasar otra vez la lista", { productosConfirmados: true });
const listaOtraVez = listaDe(otraVez);
assert(listaOtraVez.includes("¿Están bien estos productos?"), "pedir la lista la reenvía");
assert(/cebolla/i.test(listaOtraVez) && /blanca/i.test(listaOtraVez) && /jam[oó]n/i.test(listaOtraVez), "la lista reenviada trae los productos");
assert(!listaOtraVez.includes("ubicación por GPS"), "pedir la lista no contesta solo con el GPS");
assert(prompt.includes("nomás que") && prompt.includes("respuesta corta"), "el prompt acepta la corrección y la respuesta corta");
assert(prompt.includes("te faltó") && prompt.includes("también quiero"), "el prompt no toma un sí con faltó o también quiero como el SÍ del GPS");

const falto = "Sí, solamente te faltó caja sanitas y paquete Sams";
assert(classifyProductListReply(falto) === "revise", "sí, te faltó revisa y no confirma");
assert(!isYesConfirmation(falto), "sí, te faltó no es un sí limpio");
for (const suma of ["agrega una coca", "añade servilletas", "también quiero leche", "solamente te faltó el pan", "Sí, agrega una caja"]) {
  assert(classifyProductListReply(suma) === "revise", `"${suma}" se revisa`);
  assert(!isYesConfirmation(suma), `"${suma}" no confirma`);
}
assert(classifyProductListReply("Sí") === "confirm" && classifyProductListReply("No") === "cancel", "el sí limpio y el no pelado no cambian");

const mandadoListo = [
  { nombre_producto: "Frijol", presentacion: "negro", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Limpiador", marca: "Pinol", cantidad: 1, unidad: "litro", presentacion: "1 litro" },
];
const conFalto = quoteSinGps(mandadoListo, falto, { awaitingProductConfirm: true, productosConfirmados: true });
const papelSanitas = conFalto.validatedItems.items.find((item) => /sanitas/i.test(String(item.marca)));
const papelSams = conFalto.validatedItems.items.find((item) => /sam/i.test(String(item.marca)));
assert(Boolean(papelSanitas && papelSams), "sí, te faltó anota Sanitas y Sams");
assert(/papel/i.test(papelSanitas?.nombre_producto ?? "") && /caja/i.test(String(papelSanitas?.unidad)), "la caja Sanitas queda como papel");
assert(/papel/i.test(papelSams?.nombre_producto ?? "") && /paquete/i.test(String(papelSams?.unidad)), "el paquete Sams queda como papel");
assert(conFalto.validatedItems.items.some((item) => /frijol/i.test(item.nombre_producto)), "faltó no borra el frijol");
assert(!/agregar|falt[oó]/i.test(`${papelSanitas?.marca ?? ""} ${papelSams?.marca ?? ""}`), "faltó no se copia en la marca");
const listaFalto = listaDe(conFalto);
assert(listaFalto.includes("OK, pediste:") && listaFalto.includes("¿Están bien estos productos?"), "sí, te faltó vuelve a listar");
assert(/sanitas/i.test(listaFalto) && /sam/i.test(listaFalto), "la lista nueva trae Sanitas y Sams");
assert(!listaFalto.includes("ubicación por GPS"), "sí, te faltó no pide GPS");

const yaConfirmado = conFalto.validatedItems.items;
const servilletas = "Está bien, pero agregar caja de servilletas sanitas";
assert(classifyProductListReply(servilletas) === "revise", "está bien pero agregar se revisa aunque ya hubo un sí");
const conServilletas = quoteSinGps(yaConfirmado, servilletas, { productosConfirmados: true });
const lineaServilletas = conServilletas.validatedItems.items.find((item) => /servilleta/i.test(item.nombre_producto));
assert(lineaServilletas != null, "agregar servilletas suma la línea");
assert(!/agregar/i.test(`${lineaServilletas?.nombre_producto ?? ""} ${lineaServilletas?.marca ?? ""}`), "agregar no se copia en la marca");
assert(/sanitas/i.test(`${lineaServilletas?.nombre_producto ?? ""} ${lineaServilletas?.marca ?? ""}`), "las servilletas quedan Sanitas");
assert(conServilletas.validatedItems.items.some((item) => /sanitas/i.test(String(item.marca)) && /papel/i.test(item.nombre_producto)), "el papel Sanitas sigue");
assert(conServilletas.validatedItems.items.some((item) => /sam/i.test(String(item.marca))), "el papel Sams sigue");
const listaServilletas = listaDe(conServilletas);
assert(listaServilletas.includes("¿Están bien estos productos?"), "agregar después de confirmar vuelve a listar");
assert(/servilleta/i.test(listaServilletas), "la lista nueva trae las servilletas");
assert(!listaServilletas.includes("ubicación por GPS"), "agregar después de confirmar no pide GPS");
const marcaSucia = quoteSinGps(
  [{ nombre_producto: "Servilletas", marca: "Agregar Servilletas Sanitas", cantidad: 1, unidad: "caja" }],
  "1 l",
);
const servilletaLimpia = marcaSucia.validatedItems.items.find((item) => /servilleta/i.test(`${item.nombre_producto} ${item.marca ?? ""}`));
assert(servilletaLimpia != null && !/agregar/i.test(String(servilletaLimpia?.marca ?? "")), "la marca guardada no se queda con Agregar");

const siete = [
  { nombre_producto: "Frijol", presentacion: "negro", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Arroz", marca: "SOS", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Papel higiénico", marca: "Sanitas", cantidad: 1, unidad: "caja" },
  { nombre_producto: "Papel higiénico", marca: "Sams", cantidad: 1, unidad: "paquete" },
  { nombre_producto: "Limpiador", marca: "Pinol" },
  { nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 1, unidad: "litro" },
];
const trasUnLitro = mergeSnapshot({
  currentSnapshot: { businessId: 1, businessName: "Agua Santa", items: siete },
  llmOrderState: {
    items: siete.map((item) =>
      /pinol/i.test(String(item.marca))
        ? { ...item, cantidad: 1, unidad: "litro", presentacion: "1 litro" }
        : { ...item },
    ),
  },
});
assert((trasUnLitro.items ?? []).length === 7, "1 l de Pinol no baja el pedido de 7 a 6");
assert(
  (trasUnLitro.items ?? []).some((item) => /papel/i.test(item.nombre_producto) && /sanitas/i.test(String(item.marca))),
  "Sanitas no se fusiona con Sams",
);
assert(
  (trasUnLitro.items ?? []).some((item) => /papel/i.test(item.nombre_producto) && /sam/i.test(String(item.marca))),
  "Sams se queda en su propia línea",
);
const pinolCerrado = (trasUnLitro.items ?? []).find((item) => /pinol/i.test(String(item.marca)));
assert(pinolCerrado?.cantidad === 1 && /litro/i.test(String(pinolCerrado?.unidad)), "1 l cierra el Pinol");
assert(
  flowSrc.includes('waitingAddress && (replyKind === "relist" || replyKind === "revise")'),
  "esperando la dirección también se puede corregir, no solo repetir la lista",
);
assert(prompt.includes("Sanitas") && prompt.includes("arroz higiénico") && prompt.includes("Pinol"), "el prompt lee Sanitas, arroz higiénico y Pinol como en la tienda");

console.log("\n--- Transcripción de ejemplo ---\n");
console.log("CLIENTE: hola\n");
console.log("MÁNDALO:\n" + greeting + "\n");
console.log("CLIENTE: 2\n");
console.log("MÁNDALO:\n" + listed + "\n");
console.log("CLIENTE: George\n");
console.log("MÁNDALO: [foto public/menus/george.png]\n" + caption + "\n");
console.log("CLIENTE: una de res chica\n");
console.log("MÁNDALO:\n" + catalogReceipt + "\n");
console.log("CLIENTE: (después de cotizar)\n");
console.log("MÁNDALO:\n" + quote + "\n");
console.log("RECIBO ANTES DEL PRIMER SÍ:\n" + receipt + "\n");
console.log("check-customer-ux: ok");
