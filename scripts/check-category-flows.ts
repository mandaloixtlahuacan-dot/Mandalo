/**
 * Flujos de la fase de productos, uno por categoría.
 * Los mensajes son los de las pruebas del 7 de octubre de 2026 y variantes.
 * Cada caso corre con lo que devolvió OpenAI, sin JSON, y con una adivinanza.
 * No toca Supabase, WhatsApp ni OpenAI.
 *
 * Correr: npx tsx scripts/check-category-flows.ts
 */
import { CARNICERIA_LA_CENTRAL_PRODUCTOS } from "../src/lib/carniceriaLaCentralCatalog";
import type { CatalogPriceRow } from "../src/lib/catalogQuantities";
import {
  ABARROTES_PRODUCT_REQUEST,
  buildGreeting,
  CUSTOMER_STORE_NICHES,
  formatAbarrotesStoreAck,
  formatCatalogMenuCaption,
  formatCatalogOrderRegistered,
  formatHowToEditList,
  formatNicheStoreList,
  formatNoFixedMenu,
  formatRunningTotal,
  formatStuckCorrection,
  type UxStore,
} from "../src/lib/customerUx";
import { classifyProductListReply, isYesConfirmation, orderingStepAfterCustomer } from "../src/lib/messages";
import { assembleCapturedItems } from "../src/lib/orderGrounding";
import * as grocery from "../src/lib/quoteProductClarity";
import { prepareQuoteItems, quoteQuestionForItems } from "../src/lib/quoteProductClarity";
import { renderPedidoSummary } from "../src/lib/confirmationAmendment";
import {
  ADDRESS_ASK_MESSAGE,
  buildCustomerMessage,
  formatProductListConfirm,
  type PedidoItemInput,
} from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";

const george: CatalogPriceRow[] = `
Hamburguesa de Res Chica | 60
Hamburguesa de Res Grande | 100
Hamburguesa de Pollo Chica | 70
Hamburguesa de Pollo Grande | 110
Hamburguesa de Camarón Chica | 90
Hamburguesa de Camarón Grande | 130
Hamburguesa Hawaiana Chica | 90
Hamburguesa Hawaiana Grande | 120
Hamburguesa Cubana Chica | 90
Hamburguesa Cubana Grande | 120
Hamburguesa Mar y Tierra Chica | 90
Hamburguesa Mar y Tierra Grande | 140
Hamburguesa de Arrachera Chica | 70
Hamburguesa de Arrachera Grande | 100
Papas a la Francesa 300g | 70
Papas Gajo 315g | 70
Salchilocos 310g | 70
Dedos de Queso 6 piezas | 85
Boneless 10 piezas | 130
Botana Completa | 100
Dogo Clásico | 35
Dogo de Pollo | 45
Dogo Cubano | 60
Dogo Hawaiano | 60
Dogo de Camarón | 60
Dogoburguer | 50
Doridogo | 45
Dogo Arrachera | 45
Pizzadogo | 45
Refresco (Pepsi, Seven, Coca, Mirinda o Manzana) | 20
Torta de Pierna | 80
Torta Hawaiana | 100
Torta Cubana | 100
Torta Mexicana | 100
Torta de Arrachera | 80
Torta de Chorizo | 80
Torta Campechana | 80
Sincronizada de Pierna y Tocino | 70
Sincronizada de Tocino | 60
Sincronizada de Camarón | 80
Sincronizada de Arrachera | 70
Sincronizada de Chorizo | 70
Sincronizada Campechana | 70
Quesadilla de Tocino | 35
Quesadilla de Camarón | 80
Quesadilla Burrita | 35
Quesadilla Quesaburra | 70
Quesadilla de Arrachera | 45
Quesadilla de Chorizo | 45
Quesadilla Campechana | 55
Ingrediente Extra en Quesadilla | 20
Alitas 5 piezas | 70
Alitas 10 piezas | 130
Alitas 15 piezas | 185
Alitas 20 piezas | 225
Alitas 30 piezas | 325
`
  .trim()
  .split("\n")
  .map((line) => {
    const [nombreProducto, precio] = line.split(" | ");
    return { nombreProducto, precio: Number(precio) };
  });

const central: CatalogPriceRow[] = CARNICERIA_LA_CENTRAL_PRODUCTOS.map(({ nombreProducto, precio }) => ({
  nombreProducto,
  precio,
}));

const GEORGE_MSG =
  "Quiero una hamburguesa Grande de camarón y sería otra hamburguesa grande hawaiana. También sería unos Salchi locos serían también tres Dogos clásicos y dos Pepsi";
const LOGGED_GEORGE: PedidoItemInput[] = [
  { nombre_producto: "Hamburguesa de Camarón Grande", cantidad: 1 },
  { nombre_producto: "Hamburguesa Hawaiana Grande", cantidad: 1 },
  { nombre_producto: "Salchi locos", cantidad: 1 },
  { nombre_producto: "Dogo Clásico", cantidad: 3 },
];
const WRONG_GEORGE: PedidoItemInput[] = [
  { nombre_producto: "Hamburguesa", cantidad: 1 },
  { nombre_producto: "Torta Hawaiana", cantidad: 1 },
  { nombre_producto: "Dogo Hawaiano", cantidad: 1 },
  { nombre_producto: "Salchi locos", cantidad: 1 },
];
const TANG_MSG = "1 kilo de tortillas también 2 litros de leche 22 kilos de azúcar y 3 sobres de tang";
const STORE = "Abarrotes Agua Santa (PRUEBA)";

const failures: string[] = [];
let passed = 0;

function check(id: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${id}: ${detail}` : id);
}

function findItem(items: PedidoItemInput[], re: RegExp): PedidoItemInput | undefined {
  return items.find((item) => re.test(item.nombre_producto.trim()));
}

function qty(item: PedidoItemInput | undefined): number | null {
  return typeof item?.cantidad === "number" ? item.cantidad : null;
}

function helpAfterList(message: string): string {
  const marker = "*¿Están bien estos productos?*";
  const at = message.indexOf(marker);
  const rest = at === -1 ? message : message.slice(at + marker.length);
  return rest.replace(/^\s*\*Si tu pedido está bien, responde sí\.\*\s*/, "");
}

function georgeOrder(incoming: PedidoItemInput[]) {
  return assembleCapturedItems({ prior: [], incoming, userMessage: GEORGE_MSG, catalog: george });
}

function georgeLinesOk(items: PedidoItemInput[]): string | null {
  const camaron = findItem(items, /Hamburguesa de Camarón Grande/i);
  const hawaiana = findItem(items, /Hamburguesa Hawaiana Grande/i);
  const salchi = findItem(items, /Salchilocos 310g/i);
  const dogo = findItem(items, /Dogo Clásico/i);
  const pepsi = findItem(items, /Refresco/i);
  if (!camaron || qty(camaron) !== 1) return "falta Hamburguesa de Camarón Grande x1";
  if (!hawaiana || qty(hawaiana) !== 1) return "falta Hamburguesa Hawaiana Grande x1";
  if (!salchi || qty(salchi) !== 1) return "falta Salchilocos 310g x1";
  if (!dogo || qty(dogo) !== 3) return `Dogo Clásico x${qty(dogo)}`;
  if (!pepsi || qty(pepsi) !== 2 || !/pepsi/i.test(pepsi.marca ?? "")) return "falta Refresco Pepsi x2";
  if (items.length !== 5) return `hay ${items.length} líneas: ${items.map((item) => item.nombre_producto).join(", ")}`;
  if (items.some((item) => /torta/i.test(item.nombre_producto))) return "apareció una torta";
  if (items.filter((item) => /dogo cl[aá]sico/i.test(item.nombre_producto)).length !== 1) return "dogo repetido";
  if (items.some((item) => /^hamburguesa$/i.test(item.nombre_producto.trim()))) return "quedó una hamburguesa genérica";
  return null;
}

function speech(message: string, prior: PedidoItemInput[] = [], incoming: PedidoItemInput[] = [], catalog = george) {
  return assembleCapturedItems({ prior, incoming, userMessage: message, catalog });
}

function questionOf(result: ReturnType<typeof speech>): string {
  return `${result.catalogSpeech?.question ?? ""}\n${result.catalogSpeech?.reply ?? ""}`;
}

function quoteItems(message: string, prior: PedidoItemInput[] = [], incoming: PedidoItemInput[] = []): PedidoItemInput[] {
  const assembled = assembleCapturedItems({ prior, incoming, userMessage: message });
  const validation = validateCaptureForConfirmation({
    snapshot: { businessId: 2, businessName: STORE, items: assembled.items },
    items: assembled.items,
    userMessage: message,
    quoteStore: true,
    priorItems: prior,
    storeKind: "abarrotes",
  });
  return validation.validatedItems.items;
}

function asked(validation: ReturnType<typeof validateCaptureForConfirmation>): string {
  return validation.issues
    .map((issue) => issue.customerQuestion ?? "")
    .filter(Boolean)
    .join("\n");
}

const emptyGeorge = georgeOrder([]);
const loggedGeorge = georgeOrder(LOGGED_GEORGE);
const wrongGeorge = georgeOrder(WRONG_GEORGE);
check("george-vacio", georgeLinesOk(emptyGeorge.items) == null, georgeLinesOk(emptyGeorge.items) ?? "");
check("george-openai", georgeLinesOk(loggedGeorge.items) == null, georgeLinesOk(loggedGeorge.items) ?? "");
check("george-adivinanza", georgeLinesOk(wrongGeorge.items) == null, georgeLinesOk(wrongGeorge.items) ?? "");

const georgeList = formatProductListConfirm(emptyGeorge.items, "restaurante");
const georgeConfirm = validateCaptureForConfirmation({
  snapshot: {
    businessId: 5,
    businessName: "Hamburguesas Hotdogs George",
    items: emptyGeorge.items,
    storeKind: "restaurante",
  },
  items: emptyGeorge.items,
  priorItems: [],
  userMessage: GEORGE_MSG,
  quoteStore: false,
  storeKind: "restaurante",
});
const georgeAsked = asked(georgeConfirm);
check(
  "george-lista",
  /OK, pediste/.test(georgeList) &&
    /¿Están bien estos productos\?/.test(georgeList) &&
    /nombre del menú/.test(helpAfterList(georgeList)) &&
    /ejemplo/i.test(helpAfterList(georgeList)) &&
    /quita las papas/.test(helpAfterList(georgeList)) &&
    /agrega 1 refresco/.test(helpAfterList(georgeList)) &&
    !/✅/.test(helpAfterList(georgeList)) &&
    !/Pinol|jabón Zote|marca, tamaño y cuántos|reiniciar/i.test(georgeList) &&
    emptyGeorge.items.every((item) => !helpAfterList(georgeList).includes(item.nombre_producto)) &&
    /OK, pediste/.test(georgeAsked) &&
    /¿Están bien estos productos\?/.test(georgeAsked),
  helpAfterList(georgeList).slice(0, 180),
);
check(
  "george-si",
  orderingStepAfterCustomer({ step: "product_list", customerMessage: "Si" }) === "location" &&
    ADDRESS_ASK_MESSAGE.includes("ubicación por GPS"),
);

const quieta = speech("Quieta digo clásico", emptyGeorge.items);
check(
  "george-quieta",
  /Quito el Dogo Clásico/.test(questionOf(quieta)) &&
    qty(findItem(quieta.items, /Dogo Clásico/i)) === 3 &&
    quieta.items.filter((item) => /Dogo Clásico/i.test(item.nombre_producto)).length === 1,
  questionOf(quieta),
);
const quitaUn = speech("quita un dogo clásico", emptyGeorge.items);
check("george-quita-un", qty(findItem(quitaUn.items, /Dogo Clásico/i)) === 2, `x${qty(findItem(quitaUn.items, /Dogo Clásico/i))}`);
const otra = speech("otra Pepsi", emptyGeorge.items);
check("george-otra-pepsi", qty(findItem(otra.items, /Refresco/i)) === 3 && /pepsi/i.test(findItem(otra.items, /Refresco/i)?.marca ?? ""));
const agregaBurger = speech("agrega una hamburguesa", emptyGeorge.items);
check(
  "george-agrega-hamburguesa",
  /Cuál hamburguesa/.test(questionOf(agregaBurger)) &&
    agregaBurger.items.some((item) => /falta tipo/i.test(item.notas ?? "")),
  questionOf(agregaBurger).slice(0, 160),
);
const agregaHawaiana = speech("agrega una hamburguesa hawaiana grande", emptyGeorge.items);
check("george-agrega-hawaiana", qty(findItem(agregaHawaiana.items, /Hamburguesa Hawaiana Grande/i)) === 2);
const cambia = speech("cambia la de camarón a chica", emptyGeorge.items);
check(
  "george-cambia-chica",
  Boolean(findItem(cambia.items, /Hamburguesa de Camarón Chica/i)) && !findItem(cambia.items, /Hamburguesa de Camarón Grande/i),
);

const una = speech("Quiero una hamburguesa");
check(
  "george-cual-hamburguesa",
  una.catalogSpeech?.missing === true &&
    /Cuál hamburguesa/.test(questionOf(una)) &&
    /De Camarón/.test(questionOf(una)) &&
    /Chica o grande/.test(questionOf(una)) &&
    !/OK, pediste/.test(questionOf(una)),
  questionOf(una).slice(0, 200),
);
const cerrada = speech("de camarón grande", una.items);
check(
  "george-contesta-camarón",
  Boolean(findItem(cerrada.items, /Hamburguesa de Camarón Grande/i)) &&
    qty(findItem(cerrada.items, /Hamburguesa de Camarón Grande/i)) === 1 &&
    cerrada.items.length === 1 &&
    cerrada.catalogSpeech?.missing !== true,
  cerrada.items.map((item) => item.nombre_producto).join(", "),
);
const dos = speech("dos hamburguesas y dos dogos");
check(
  "george-dos-y-dos",
  /Cuáles hamburguesas/.test(questionOf(dos)) &&
    /Cuáles dogos/.test(questionOf(dos)) &&
    /Dogoburguer/.test(questionOf(dos)) &&
    /Pizzadogo/.test(questionOf(dos)),
  questionOf(dos).slice(0, 240),
);
const split = speech("una de res chica y una hawaiana grande, los dogos clásicos", dos.items);
check(
  "george-reparte",
  Boolean(findItem(split.items, /Hamburguesa de Res Chica/i)) &&
    Boolean(findItem(split.items, /Hamburguesa Hawaiana Grande/i)) &&
    qty(findItem(split.items, /Dogo Clásico/i)) === 2 &&
    !split.items.some((item) => /torta/i.test(item.nombre_producto)) &&
    split.items.length === 3,
  split.items.map((item) => `${item.nombre_producto} x${item.cantidad}`).join(", "),
);
const soloHawaiana = speech("una hamburguesa hawaiana");
check(
  "george-hawaiana-tamaño",
  /chica o grande/i.test(questionOf(soloHawaiana)) && !/Cuál hamburguesa/.test(questionOf(soloHawaiana)),
  questionOf(soloHawaiana),
);
const grandeAntes = speech("una hamburguesa grande de camarón");
check("george-tamaño-antes", Boolean(findItem(grandeAntes.items, /Hamburguesa de Camarón Grande/i)) && grandeAntes.catalogSpeech?.missing !== true);
const dogoCoca = speech("un dogo y una coca");
check(
  "george-dogo-coca",
  /Cuál dogo/.test(questionOf(dogoCoca)) &&
    Boolean(findItem(dogoCoca.items, /Refresco/i)) &&
    /coca/i.test(findItem(dogoCoca.items, /Refresco/i)?.marca ?? ""),
  questionOf(dogoCoca).slice(0, 180),
);
check("george-salchi", Boolean(findItem(speech("unos salchi locos").items, /^Salchilocos 310g$/i)));
check("george-salchilocos", Boolean(findItem(speech("salchilocos").items, /^Salchilocos 310g$/i)));
const papas = speech("2 papas");
check("george-papas", /papas/i.test(questionOf(papas)) && /Francesa/.test(questionOf(papas)) && /Gajo/.test(questionOf(papas)), questionOf(papas));
const sushi = speech("una de sushi");
check(
  "george-sushi",
  /no lo manejamos/.test(questionOf(sushi)) && sushi.items.length === 0,
  questionOf(sushi),
);

function centralSpeech(message: string, incoming: PedidoItemInput[] = [], prior: PedidoItemInput[] = []) {
  return speech(message, prior, incoming, central);
}
const bistecVacio = centralSpeech("un kilo de bistec");
const bistecModelo = centralSpeech("un kilo de bistec", [{ nombre_producto: "Bistec de res", cantidad: 1, unidad: "kilo" }]);
const bistecMal = centralSpeech("un kilo de bistec", [{ nombre_producto: "Diezmillo", cantidad: 1 }]);
function asksBistec(result: ReturnType<typeof speech>): boolean {
  return /Cuál bistec/.test(questionOf(result)) && /De res/.test(questionOf(result)) && /puerco/i.test(questionOf(result)) && result.catalogSpeech?.missing === true;
}
check("central-bistec-vacio", asksBistec(bistecVacio), questionOf(bistecVacio).slice(0, 180));
check("central-bistec-openai", asksBistec(bistecModelo), questionOf(bistecModelo).slice(0, 180));
check("central-bistec-adivinanza", asksBistec(bistecMal) && !findItem(bistecMal.items, /Diezmillo/i), questionOf(bistecMal).slice(0, 180));

const costilla = centralSpeech("1 kilo de costilla y medio de chorizo");
check(
  "central-costilla",
  /Cuál costilla/.test(questionOf(costilla)) &&
    Boolean(findItem(costilla.items, /^Chorizo$/i)) &&
    qty(findItem(costilla.items, /^Chorizo$/i)) === 0.5 &&
    !findItem(costilla.items, /Argentino/i),
  `${questionOf(costilla).slice(0, 120)} | ${costilla.items.map((item) => item.nombre_producto).join(", ")}`,
);
const medio = centralSpeech("medio de chorizo y otro de arrachera");
check(
  "central-chorizo-arrachera",
  Boolean(findItem(medio.items, /^Chorizo$/i)) &&
    Boolean(findItem(medio.items, /Arrachera Marinada/i)) &&
    medio.catalogSpeech?.missing !== true,
  medio.items.map((item) => `${item.nombre_producto} x${item.cantidad}`).join(", "),
);
const pollo = centralSpeech("un kilo de pollo");
check("central-pollo", /no lo manejamos/.test(questionOf(pollo)) && pollo.items.length === 0, questionOf(pollo));

const carne = centralSpeech("un kilo de bistec de res y medio de chorizo");
const sinChorizo = centralSpeech("quita el chorizo", [], carne.items);
check("central-quita-chorizo", !findItem(sinChorizo.items, /chorizo/i) && Boolean(findItem(sinChorizo.items, /Bistec de res/i)));
const dosKilos = centralSpeech("cambia el bistec de res a 2 kilos", [], carne.items);
check("central-dos-kilos", qty(findItem(dosKilos.items, /Bistec de res/i)) === 2, `x${qty(findItem(dosKilos.items, /Bistec de res/i))}`);
const conArrachera = centralSpeech("agrega medio kilo de arrachera marinada", [], carne.items);
const carneLista = formatProductListConfirm(conArrachera.items, "carniceria");
check(
  "central-agrega-arrachera",
  Boolean(findItem(conArrachera.items, /Arrachera Marinada/i)) &&
    /ejemplo/i.test(helpAfterList(carneLista)) &&
    /carbón/.test(helpAfterList(carneLista)) &&
    /pastor/.test(helpAfterList(carneLista)) &&
    !/✅/.test(helpAfterList(carneLista)) &&
    !/corte y los kilos|Pinol|Zote|marca, tamaño|reiniciar/i.test(helpAfterList(carneLista)) &&
    conArrachera.items.every((item) => !helpAfterList(carneLista).includes(item.nombre_producto)),
);

function tangOk(items: PedidoItemInput[], detail: string): string | null {
  const tang = findItem(items, /^Tang$/i);
  const tortilla = findItem(items, /tortilla/i);
  const leche = findItem(items, /leche/i);
  const azucar = findItem(items, /azúcar|azucar/i);
  if (!tang || qty(tang) !== 3 || !/sobre/i.test(tang.unidad ?? "")) return `${detail}: Tang ${qty(tang)} ${tang?.unidad ?? ""}`;
  if (!tortilla) return `${detail}: sin tortilla`;
  if (!leche) return `${detail}: sin leche`;
  if (!azucar || qty(azucar) !== 22) return `${detail}: azúcar x${qty(azucar)}`;
  return null;
}
const tangVacio = quoteItems(TANG_MSG);
const tangMal = quoteItems(TANG_MSG, [], [
  { nombre_producto: "Naranja", cantidad: 1 },
  { nombre_producto: "Leche", marca: "Clara", cantidad: 2, unidad: "litros" },
]);
const tangModelo = quoteItems(TANG_MSG, [], [{ nombre_producto: "Tang", cantidad: 3, unidad: "sobre" }]);
check("tang-vacio", tangOk(tangVacio, "vacio") == null, tangOk(tangVacio, "vacio") ?? "");
check("tang-openai", tangOk(tangModelo, "openai") == null, tangOk(tangModelo, "openai") ?? "");
check(
  "tang-adivinanza",
  tangOk(tangMal, "mal") == null && !tangMal.some((item) => /^naranja$/i.test(item.nombre_producto) || item.marca === "Clara"),
  tangOk(tangMal, "mal") ?? tangMal.map((item) => `${item.nombre_producto}/${item.marca ?? ""}`).join(", "),
);
check("tang-pregunta-tortilla", /maíz|harina/.test(quoteQuestionForItems(tangVacio) ?? ""), quoteQuestionForItems(tangVacio) ?? "");

const conMaiz = prepareQuoteItems(tangVacio, "De maíz", STORE);
const conSanta = prepareQuoteItems(conMaiz, "Sería Santa Clara entera", STORE);
const lecheSanta = findItem(conSanta, /leche/i);
check(
  "tang-santa-clara",
  Boolean(findItem(conSanta, /^Tang$/i)) &&
    /Santa Clara/i.test(lecheSanta?.marca ?? "") &&
    /entera/i.test(lecheSanta?.presentacion ?? "") &&
    quoteQuestionForItems(conSanta) == null,
  conSanta.map((item) => `${item.nombre_producto}|${item.marca ?? ""}|${item.presentacion ?? ""}`).join(" ; "),
);
const sinTang = conSanta.filter((item) => !/tang/i.test(item.nombre_producto));
const agregado = prepareQuoteItems(sinTang, "Agrega 3 sobres de tang", STORE);
const relista = validateCaptureForConfirmation({
  snapshot: {
    businessId: 2,
    businessName: STORE,
    items: agregado,
    flags: { awaitingProductConfirm: true },
    storeKind: "abarrotes",
  },
  items: agregado,
  priorItems: sinTang,
  userMessage: "Agrega 3 sobres de tang",
  quoteStore: true,
  storeKind: "abarrotes",
});
const relistaTexto = asked(relista);
check(
  "tang-agrega",
  Boolean(findItem(agregado, /^Tang$/i)) &&
    qty(findItem(agregado, /^Tang$/i)) === 3 &&
    /OK, pediste/.test(relistaTexto) &&
    /Tang/.test(relistaTexto) &&
    /¿Están bien estos productos\?/.test(relistaTexto),
  relistaTexto.slice(0, 220),
);

const restore = (grocery as { restoreNamedFromHistory?: (items: PedidoItemInput[], messages: string[], ignore?: string) => PedidoItemInput[] })
  .restoreNamedFromHistory;
const pin = "https://maps.google.com/?q=20.864,-103.24";
const restored = restore ? restore(sinTang, [TANG_MSG, "De maíz", "Sería Santa Clara entera"], STORE) : sinTang;
const pinParsed = prepareQuoteItems(sinTang, pin, STORE);
check(
  "tang-pin",
  Boolean(restore) &&
    Boolean(findItem(restored, /^Tang$/i)) &&
    !pinParsed.some((item) => /google|maps/i.test(item.nombre_producto)),
  restore ? restored.map((item) => item.nombre_producto).join(", ") : "sin restoreNamedFromHistory",
);

function kept(message: string, name: RegExp, extra?: RegExp): boolean {
  const items = prepareQuoteItems([], message, STORE);
  const item = findItem(items, name);
  if (!item) return false;
  if (extra && !extra.test(`${item.marca ?? ""} ${item.presentacion ?? ""} ${item.unidad ?? ""}`)) return false;
  return !items.some((row) => /^(naranja|mango|uva|verdura)$/i.test(row.nombre_producto));
}
check("sabor-tang", kept("2 Tang de naranja", /^Tang$/i, /naranja/i));
check("sabor-boing", kept("3 Boing de mango", /^Boing$/i, /mango/i));
check("sabor-kool", kept("1 Kool-Aid de uva", /Kool-Aid/i, /uva/i));
check("sabor-zuko", kept("2 sobres de Zuko", /^Zuko$/i, /sobre/i));
check("sabor-tanks", kept("unos Tanks", /^Tanks$/i));
check("sabor-tasks", kept("2 Tasks de piña", /^Tasks$/i, /piña/i));
const coca = prepareQuoteItems([], "2 Coca-Cola de 600 ml", STORE);
check(
  "marca-coca",
  /Coca-Cola/i.test(findItem(coca, /refresco|coca/i)?.marca ?? "") && !/Cola Cola/i.test(findItem(coca, /refresco|coca/i)?.marca ?? ""),
  findItem(coca, /refresco|coca/i)?.marca ?? "",
);
const frijol = prepareQuoteItems([], "1 kilo de frijol y 3 sobres de Kool-Aid", STORE);
check(
  "marca-kool",
  Boolean(findItem(frijol, /frijol/i)) &&
    Boolean(findItem(frijol, /Kool-Aid/i)) &&
    !/Aid Aid/i.test(`${findItem(frijol, /frijol/i)?.marca ?? ""} ${findItem(frijol, /Kool-Aid/i)?.marca ?? ""}`),
);

check("si-estan-bien", isYesConfirmation("Si están bien") && classifyProductListReply("Si están bien") === "confirm" && orderingStepAfterCustomer({ step: "product_list", customerMessage: "Si están bien" }) === "location");
check("si-asi", isYesConfirmation("sí, así está bien") && classifyProductListReply("sí, así está bien") === "confirm");
check("si-pero", classifyProductListReply("ok pero quita el cloro") === "revise" && !isYesConfirmation("ok pero quita el cloro"));
check("si-emoji", !isYesConfirmation("👍") && classifyProductListReply("👍") === "ignore");
check("si-pregunta", !isYesConfirmation("quiero saber si tienen coca") && classifyProductListReply("quiero saber si tienen coca") === "ignore");

const abarrotesLeak = [
  formatHowToEditList(),
  formatStuckCorrection(1),
  formatStuckCorrection(2),
  formatProductListConfirm([{ nombre_producto: "Pinol", cantidad: 1 }, { nombre_producto: "Tang", cantidad: 3, unidad: "sobre" }]),
  formatAbarrotesStoreAck({ id: 2, nombre: STORE, categoria: "Abarrotes", telefono: "1", abierta: true, abreTexto: "", usaCatalogoFijo: false }),
  formatNoFixedMenu("ZAGU"),
  ABARROTES_PRODUCT_REQUEST,
  buildGreeting(),
].join("\n");
check(
  "fuga-abarrotes",
  /Solo es un ejemplo, no está en tu pedido/.test(formatStuckCorrection(1)) &&
    /quita la leche/.test(formatStuckCorrection(1)) &&
    !/pinol|coca|zote/i.test(`${formatHowToEditList()}\n${formatStuckCorrection(1)}`) &&
    !/reiniciar/.test(formatStuckCorrection(1)) &&
    /Pinol/.test(abarrotesLeak) &&
    !/como sale en la foto|El menú trae precio|Hamburguesa Hawaiana|Dogo Clásico|Salchilocos|Arrachera Marinada/i.test(abarrotesLeak),
);

const restaurantBits = [
  formatHowToEditList("restaurante"),
  formatStuckCorrection(1, {
    kind: "restaurante",
    itemLines: ["✅ 🍔 *Hamburguesa Hawaiana Grande, x1*"],
  }),
  formatProductListConfirm(emptyGeorge.items, "restaurante"),
  formatNoFixedMenu("Hamburguesas Hotdogs George", "restaurante"),
  formatCatalogMenuCaption({
    id: 5,
    nombre: "Hamburguesas Hotdogs George",
    categoria: "Restaurante",
    telefono: "1",
    abierta: true,
    abreTexto: "",
    usaCatalogoFijo: true,
  }),
  formatRunningTotal({ storeName: "Hamburguesas Hotdogs George", lines: ["1 Hamburguesa Hawaiana Grande"], subtotal: 120, catalog: true }),
  formatCatalogOrderRegistered(107, "Hamburguesas Hotdogs George"),
].join("\n");
check(
  "fuga-restaurante",
  /¿Están bien estos productos\?/.test(restaurantBits) &&
    /nombre del menú/.test(restaurantBits) &&
    !/Pinol|jabón Zote|Coca a 2 litros|con marca, tamaño y cuántos|La tienda cotiza|es de abarrotes|Takis|Salchicha FUD|McCormick/i.test(restaurantBits) &&
    !/reiniciar/.test(
      formatStuckCorrection(1, {
        kind: "restaurante",
        itemLines: ["✅ 🍔 *Dogo Clásico, x3*"],
      }),
    ),
  restaurantBits.slice(0, 240),
);

const meatBits = [
  formatHowToEditList("carniceria"),
  formatStuckCorrection(2, {
    kind: "carniceria",
    itemLines: ["✅ 🥩 *Chorizo, x1*"],
  }),
  formatProductListConfirm([{ nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" }], "carniceria"),
  formatNoFixedMenu("Carnicería La Central", "carniceria"),
].join("\n");
check(
  "fuga-carniceria",
  /corte y los kilos/.test(meatBits) &&
    /reiniciar/.test(meatBits) &&
    /¿Están bien estos productos\?/.test(meatBits) &&
    !/Pinol|jabón Zote|Coca a 2 litros|con marca, tamaño y cuántos|La tienda cotiza|es de abarrotes|Takis|Salchicha FUD|McCormick/i.test(meatBits) &&
    !/corte y los kilos|reiniciar/.test(formatHowToEditList("carniceria")),
);

const abarrotesPedido = formatProductListConfirm([
  { nombre_producto: "Croquetas Perron", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Frijol negro", cantidad: 2, unidad: "kilo" },
  { nombre_producto: "Agua Ciel", presentacion: "1 litro", cantidad: 1 },
  { nombre_producto: "Monster", presentacion: "lata", cantidad: 1 },
]);
const abarrotesAyuda = helpAfterList(abarrotesPedido);
const mismaAyuda = helpAfterList(
  formatProductListConfirm([{ nombre_producto: "Leche Lala", cantidad: 1, unidad: "litro" }]),
);
check(
  "ayuda-abarrotes",
  abarrotesAyuda === mismaAyuda &&
    /leche/i.test(abarrotesAyuda) &&
    /ejemplo/i.test(abarrotesAyuda) &&
    abarrotesAyuda.includes("_Si algún producto está mal") &&
    !abarrotesAyuda.includes("✅") &&
    !/Pinol|jabón Zote|marca, tamaño y cuántos|reiniciar|Croquetas|Frijol|Ciel|Monster/i.test(abarrotesAyuda) &&
    /No pude cambiar tu lista/.test(formatStuckCorrection(1)) &&
    /quita la leche/.test(formatStuckCorrection(1)) &&
    /marca, tamaño y cuántos/.test(formatStuckCorrection(1)) &&
    !/pinol|coca|zote/i.test(formatStuckCorrection(1)) &&
    !/reiniciar/.test(formatStuckCorrection(1)),
  abarrotesAyuda,
);

const georgePedido = formatProductListConfirm(
  [
    { nombre_producto: "Hamburguesa de Res Grande", cantidad: 2 },
    { nombre_producto: "Dogo de Pollo", cantidad: 2 },
    { nombre_producto: "Papas Gajo 315g", cantidad: 1 },
  ],
  "restaurante",
);
const georgeAyuda = helpAfterList(georgePedido);
check(
  "ayuda-george",
  /ejemplo/i.test(georgeAyuda) &&
    /quita las papas/.test(georgeAyuda) &&
    /agrega 1 refresco/.test(georgeAyuda) &&
    /nombre del menú/.test(georgeAyuda) &&
    !georgeAyuda.includes("✅") &&
    !/Hamburguesa de Res Grande|Dogo de Pollo|Papas Gajo|Pinol|leche Lala|carbón/i.test(georgeAyuda) &&
    georgeAyuda === helpAfterList(formatProductListConfirm([{ nombre_producto: "Dogo Clásico", cantidad: 1 }], "restaurante")) &&
    /Solo es un ejemplo, no está en tu pedido/.test(formatStuckCorrection(1, { kind: "restaurante" })) &&
    /nombre del menú y cuántos/.test(formatStuckCorrection(1, { kind: "restaurante" })) &&
    !formatStuckCorrection(1, { kind: "restaurante" }).includes("✅") &&
    !/Hamburguesa de Res Grande|Dogo de Pollo|Papas Gajo|Pinol|Coca|Zote/.test(formatStuckCorrection(1, { kind: "restaurante" })),
  georgeAyuda,
);

const centralPedido = formatProductListConfirm(
  [
    { nombre_producto: "Bistec de res", cantidad: 1, unidad: "kilo" },
    { nombre_producto: "Chorizo", cantidad: 0.5, unidad: "kilo" },
  ],
  "carniceria",
);
const centralAyuda = helpAfterList(centralPedido);
check(
  "ayuda-central",
  /ejemplo/i.test(centralAyuda) &&
    /carbón/.test(centralAyuda) &&
    /pastor/.test(centralAyuda) &&
    !centralAyuda.includes("✅") &&
    !/Bistec de res|Chorizo|Pinol|leche Lala|nombre del menú/i.test(centralAyuda) &&
    /Solo es un ejemplo, no está en tu pedido/.test(formatStuckCorrection(1, { kind: "carniceria" })) &&
    /corte y los kilos/.test(formatStuckCorrection(1, { kind: "carniceria" })) &&
    !formatStuckCorrection(1, { kind: "carniceria" }).includes("✅") &&
    !/reiniciar/.test(formatStuckCorrection(1, { kind: "carniceria" })) &&
    /reiniciar/.test(formatStuckCorrection(2, { kind: "carniceria" })),
  centralAyuda,
);

const ticket = buildCustomerMessage({
  validation: validateCaptureForConfirmation({
    snapshot: {
      businessId: 5,
      businessName: "Hamburguesas Hotdogs George",
      addressText: "Calle Hidalgo 12",
      latitud: 20.86,
      longitud: -103.24,
      items: emptyGeorge.items,
      flags: { productosConfirmados: true },
      storeKind: "restaurante",
    },
    items: emptyGeorge.items,
    quoteStore: false,
    storeKind: "restaurante",
  }),
  snapshot: {
    businessId: 5,
    businessName: "Hamburguesas Hotdogs George",
    addressText: "Calle Hidalgo 12",
    latitud: 20.86,
    longitud: -103.24,
    items: emptyGeorge.items,
    storeKind: "restaurante",
  },
  items: emptyGeorge.items,
  storeKind: "restaurante",
});
check("etiqueta-restaurante", /Restaurante:/.test(ticket) && !/Takis|Pinol/.test(ticket), ticket.slice(0, 180));

const summary = renderPedidoSummary({
  pedidoId: 90,
  snapshot: {
    businessId: 6,
    businessName: "Carnicería La Central",
    addressText: "Calle Hidalgo 12",
    items: [{ nombre_producto: "Chorizo", cantidad: 0.5, unidad: "kilo" }],
    storeKind: "carniceria",
  },
  items: [{ nombre_producto: "Chorizo", cantidad: 0.5, unidad: "kilo" }],
});
check("etiqueta-carniceria", /Carnicería:/.test(summary) && !/Tienda:/.test(summary), summary.slice(0, 160));

const stores: UxStore[] = [
  { id: 2, nombre: "Abarrotes Agua Santa", categoria: "Abarrotes", telefono: "1", abierta: true, abreTexto: "", usaCatalogoFijo: false },
];
const nicheList = formatNicheStoreList(CUSTOMER_STORE_NICHES.find((niche) => niche.id === "abarrotes")!, stores);
check("nicho-abarrotes", /La tienda cotiza/.test(nicheList) && !/El menú trae precio/.test(nicheList));
check(
  "abarrotes-ejemplo",
  ABARROTES_PRODUCT_REQUEST.includes("Coca") && ABARROTES_PRODUCT_REQUEST.includes("Pinol") && ABARROTES_PRODUCT_REQUEST.includes("tortillas") && !/Maruchan/i.test(ABARROTES_PRODUCT_REQUEST),
);
check(
  "menu-no-espera-precio",
  !/esperando el precio|confirme el precio/i.test(formatCatalogOrderRegistered(107, "Hamburguesas Hotdogs George")),
);

const total = passed + failures.length;
console.log(`Categorías: ${passed}/${total}`);
if (failures.length) {
  console.log(failures.map((line) => `  - ${line}`).join("\n"));
  process.exit(1);
}
