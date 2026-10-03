/**
 * Chequeo local de copy y del ruteo de filtros/menú. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-customer-ux.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { buildMandaloSystemPrompt } from "../src/lib/mandaloPrompt";
import { priceCatalogOrder, reconcileCatalogQuantities } from "../src/lib/catalogQuantities";
import { buildCustomerMessage, dispatchItemAlreadyShowsQty, formatSpecificItemLine, mergeSnapshot, type PedidoItemInput } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import { normalizeWhatsAppText } from "../src/lib/waapi";
import {
  buildGreeting,
  classifyCustomerTurn,
  customerCopySplitsFee,
  formatCatalogCategories,
  formatCatalogMenu,
  formatCatalogMenuCaption,
  formatCatalogOrderRegistered,
  formatCatalogReceiptFee,
  formatCourierCancelNotice,
  formatCustomerQuoteMessage,
  formatQuoteOrderRegistered,
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
assert(
  greeting ===
    `¡Hola! Soy Mándalo, tu mandadero en Ixtlahuacán del Río.
Con gusto pido en la tienda o el restaurante que me digas y te lo llevo a la puerta.

¿De dónde quieres?
1. Abarrotes
2. Restaurantes`,
  "el saludo es el texto aprobado",
);
assert(buildGreeting(new Date("2026-10-02T15:00:00Z")) === greeting, "de mañana el saludo no cambia");
assert(buildGreeting(new Date("2026-10-03T05:00:00Z")) === greeting, "de noche el saludo no cambia");
assert(!greeting.includes("$35") && !greeting.includes("$10") && !greeting.includes("$25"), "el saludo no habla del cargo");
assert(!greeting.includes("Abro de 3") && !greeting.includes("efectivo") && !greeting.includes("envío y servicio"), "el saludo no trae horario, pago ni el párrafo de envío");
assert(!greeting.includes("Pícale al número o al nombre."), "ya no pide picarle al número");
assert(greeting.trimEnd().endsWith("2. Restaurantes"), "el saludo termina en las dos opciones");
assert(!customerCopySplitsFee(greeting), "el saludo no parte el cargo");

function nicheFromGreeting(message: string) {
  const turn = classifyCustomerTurn({ message, lastBotText: greeting, hasBusiness: false, hasItems: false, businessId: null, stores });
  return turn.type === "show_niche" ? turn.nicheId : "";
}

assert(classifyCustomerTurn({ message: "hola", lastBotText: "", hasBusiness: false, hasItems: false, businessId: null, stores }).type === "greeting", "hola → saludo");
assert(nicheFromGreeting("1") === "abarrotes", "1 → abarrotes");
assert(nicheFromGreeting("2") === "restaurantes", "2 → restaurantes");
assert(nicheFromGreeting("Abarrotes") === "abarrotes", "Abarrotes elige el nicho de abarrotes");
assert(nicheFromGreeting("Restaurantes") === "restaurantes", "Restaurantes elige el nicho de restaurantes");
const oldGreeting =
  "¡Buenas tardes! Soy Mándalo, yo te hago el mandado. 🛵\n\n¿Qué se te antoja?\n\n1. Tiendas de abarrotes\n2. Restaurantes\n\nPícale al número o al nombre.";
assert(classifyCustomerTurn({ message: "1", lastBotText: oldGreeting, hasBusiness: false, hasItems: false, businessId: null, stores }).type === "show_niche", "un saludo viejo todavía acepta el 1");
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
assert(caption.includes("Te dejo el menú de"), "la foto se anuncia, no se lista");
assert(!caption.toLowerCase().includes("categoría"), "el pie de la foto no pide categoría");
assert(caption.includes("$35"), "el pie avisa el envío");
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
    quoteStore: true,
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
  feeNote: formatCatalogReceiptFee(60),
  pricedLines: "- Hamburguesa sencilla — $60",
});
assert(catalogReceipt.includes("Envío y servicio: $35"), "recibo de catálogo con $35");
assert(catalogReceipt.includes("Hamburguesa sencilla — $60"), "el recibo trae el precio del producto");
assert(catalogReceipt.includes("Total: $95"), "el recibo suma producto + envío");

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
assert(papel.question.includes("Pétalo") && papel.question.includes("12") && papel.question.includes("32"), "el papel pide marca y rollos");
assert(papel.question.includes("4") && papel.question.includes("18"), "el papel da los cortes de rollos");

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
assert(ticketJunto.includes("$35") && !ticketJunto.includes("$10") && !ticketJunto.includes("$25"), "el ticket junto sigue en un solo $35");
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
assert(mayoReceipt.includes("$35") && !mayoReceipt.includes("$10") && !mayoReceipt.includes("$25"), "abarrotes siguen en un solo $35");

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
assert(waivableReceipt.includes("$35"), "el recibo de cotización sigue en $35");
assert(!waivableReceipt.includes("$10") && !waivableReceipt.includes("$25"), "el recibo no parte el cargo");

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
assert(ticketDos.includes("$35"), "el ticket de catálogo sigue con un solo $35");
assert(ticketDos.includes("$145"), "el total suma las dos hamburguesas más $35");
assert(!ticketDos.includes("$10") && !ticketDos.includes("$25"), "el ticket de catálogo no parte el cargo");

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
assert(priceCatalogOrder(unaSola, georgeCatalog).lines[0]?.includes("$55"), "una hamburguesa se cobra a precio de una");

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
  total: 145,
  itemLines: pricedDos.lines,
});
assert(quoteDos.includes("2 ") && quoteDos.includes("$110") && quoteDos.includes("$145"), "el SÍ del precio repite cantidad y precio de dos");
assert(quoteDos.includes("$35") && !quoteDos.includes("$10") && !quoteDos.includes("$25"), "ese SÍ sigue en un solo $35");
assert(formatCourierCancelNotice(9).includes("#9"), "si el repartidor ya tenía el pedido, el aviso de cancelación lo nombra");

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
assert(prompt.includes("dos hamburguesas = 2"), "el prompt no deja caer la cantidad del menú");
assert(prompt.includes("$35"), "el prompt no cambia el cargo de $35");

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
