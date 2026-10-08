/**
 * Presentación de WhatsApp: un emoji por producto, aire entre líneas,
 * negritas que no parten las frases que el flujo reconoce, y palomitas
 * que no se leen como producto.
 *
 * Correr: npx tsx scripts/check-message-style.ts
 */
import { ABARROTES_PRODUCT_REQUEST, buildGreeting, formatAbarrotesStoreAck, formatCatalogMenu, formatCatalogReceiptFee, formatCustomerFeeLine, formatCustomerQuoteMessage, formatNicheStoreList, type UxStore } from "../src/lib/customerUx";
import { CUSTOMER_STORE_NICHES } from "../src/lib/customerUx";
import {
  formatCheckedLine,
  formatCheckedLines,
  joinBlocks,
  productEmoji,
  stripBotDecorations,
} from "../src/lib/messageStyle";
import { mensajeClienteProductoNoDisponible, mensajeTiendaProductoNoEncontrado } from "../src/lib/ordenes";
import { formatProductListConfirm, formatSpecificItemLine } from "../src/lib/services/captureEngine";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const cases: Array<[string, string | null, string]> = [
  ["Coca-Cola 2 litros", null, "🥤"],
  ["sopa Maruchan de habanero", null, "🍜"],
  ["Pinol 1 litro", null, "🧴"],
  ["jabón Zote", null, "🧼"],
  ["papel higiénico", null, "🧻"],
  ["leche Lala", null, "🥛"],
  ["huevo", null, "🥚"],
  ["pan", null, "🍞"],
  ["tortillas", null, "🫓"],
  ["jitomate", null, "🍅"],
  ["plátano", null, "🍌"],
  ["jamón", null, "🧀"],
  ["hamburguesa sencilla", null, "🍔"],
  ["dogo clásico", null, "🌭"],
  ["papas gajo", null, "🍟"],
  ["papa", null, "🍅"],
  ["bistec", null, "🥩"],
  ["pastor", "carnes", "🌮"],
  ["chorizo", null, "🌭"],
  ["carbón fino", null, "🔥"],
  ["salsa", null, "🫙"],
  ["manzanita", null, "🥤"],
  ["algo raro", null, "🛍️"],
];

for (const [name, category, emoji] of cases) {
  assert(productEmoji(name, category) === emoji, `${name} debía ser ${emoji} y fue ${productEmoji(name, category)}`);
}

assert(joinBlocks(["a", "b"]) === "a\n\nb", "varias líneas van con una línea en blanco");
assert(joinBlocks([" a ", "", "b"]) === "a\n\nb", "las líneas vacías no cuentan");

const coca = formatCheckedLine("2 Coca-Cola de 2 litros");
assert(coca.startsWith("✅ 🥤 "), `la Coca no salió con palomita: ${coca}`);
assert(coca.includes("*2 Coca-Cola de 2 litros*"), "el producto va en negrita, entero");
assert((coca.match(/\p{Extended_Pictographic}/gu) ?? []).length === 2, "palomita y un emoji, nada más");

const list = formatProductListConfirm([
  { nombre_producto: "Coca-Cola", presentacion: "2 litros", cantidad: 2, unidad: "pieza" },
  { nombre_producto: "Sopa", marca: "Maruchan", presentacion: "habanero", cantidad: 1, unidad: "pieza" },
  { nombre_producto: "Pinol", presentacion: "1 litro", cantidad: 1, unidad: "pieza" },
]);
assert(list.startsWith("OK, pediste:"), "la lista sigue empezando igual");
assert(list.includes("🛒 *Tu pedido*"), "el título del pedido va en negrita");
assert(list.includes("\n\n✅ "), "hay aire entre productos");
assert(list.includes("*¿Están bien estos productos?*"), "la pregunta va en negrita");
assert(!list.includes("**"), "no se duplica la negrita");

const stripped = stripBotDecorations(`quita ${coca}`);
assert(!/\p{Extended_Pictographic}/u.test(stripped), `quedó un emoji: ${stripped}`);
assert(!stripped.includes("*"), `quedó un asterisco: ${stripped}`);
assert(/coca-cola de 2 litros/i.test(stripped), `se perdió el producto: ${stripped}`);
assert(
  stripBotDecorations(stripBotDecorations(`quita ${list}`)) === stripBotDecorations(`quita ${list}`),
  "quitar adornos dos veces no cambia el texto",
);

const fee = formatCustomerFeeLine();
assert(fee === "*Envío y servicio: $25*", `la línea de $25 cambió: ${fee}`);
assert(fee.includes("Envío y servicio: $25"), "el cargo sigue siendo una sola frase");

const ticket = formatCustomerQuoteMessage({
  tiendaNombre: "ZAGU",
  pedidoId: 12,
  subtotal: 80,
  total: 105,
  itemLines: ["Coca-Cola 2 litros — $40", "Pinol 1 litro — $40"],
});
assert(ticket.includes("*ZAGU*") || ticket.includes("en ZAGU*"), "el ticket pone la tienda en negrita");
assert(ticket.includes("*Envío y servicio: $25*"), "el ticket pone el $25 en negrita");
assert(ticket.includes("*Total a pagar: $105*"), "el total va en negrita");
assert(ticket.includes("*Coca-Cola 2 litros — $40*"), "el precio del producto va en negrita");
assert(ticket.includes("\n\n✅ "), "el ticket separa los productos");

const receipt = formatCatalogReceiptFee(60);
assert(receipt.includes("*Envío y servicio: $25*"), "el menú fijo deja el $25 en negrita");
assert(receipt.includes("*Total: $85*"), "el total del menú fijo va en negrita");
assert(receipt.includes("\n\n*Total:"), "el total va en su propio bloque");

const greeting = buildGreeting();
assert(greeting.includes("1. *Abarrotes*"), "la opción sigue numerada y el nombre va en negrita");
assert(greeting.includes("\n\n2. *Restaurantes*"), "las opciones van separadas");
assert(/^\d+\. /m.test(greeting), "el número queda al inicio de la línea");
assert(!greeting.includes("*1."), "el número no se come la negrita");

const zagu: UxStore = {
  id: 1,
  nombre: "ZAGU",
  categoria: "Abarrotes",
  telefono: "5213300000000",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const niche = CUSTOMER_STORE_NICHES.find((row) => row.id === "abarrotes");
assert(niche, "falta el nicho de abarrotes");
const stores = formatNicheStoreList(niche, [zagu]);
assert(/^\d+\. \*ZAGU\*/m.test(stores), "la tienda va en su línea, con el nombre en negrita");
assert(stores.includes("*¿De cuál te hago el mandado?*"), "la pregunta de tienda va en negrita");

const ack = formatAbarrotesStoreAck(zagu);
assert(ack.includes("2 Coca-Cola de 600 ml") && ack.includes("1 Pinol de 1 litro") && ack.includes("1 kg de tortillas"), "el ejemplo de abarrotes sigue completo");
assert(ack.includes("\n\n✅ "), "el ejemplo separa cada producto");
assert(!/maruchan/i.test(ABARROTES_PRODUCT_REQUEST), "el ejemplo no usa Maruchan");

const menu = formatCatalogMenu("George", "Hamburguesas", [
  { nombre: "Hamburguesa sencilla", precio: 55 },
  { nombre: "Hamburguesa hawaiana", precio: 75 },
]);
assert(/^\d+\. /m.test("1. *Hamburguesas*") && menu.includes("*Hamburguesa sencilla — $55*"), "el menú pone el precio en negrita");
assert(menu.includes("\n\n✅ "), "el menú separa cada producto");
assert(menu.includes("*¿Cuál te encargo?*"), "la instrucción del menú va en negrita");

const alCliente = mensajeClienteProductoNoDisponible("ZAGU", "Mayonesa");
assert(alCliente.includes('*"Mayonesa"*'), "el faltante va en negrita");
assert(alCliente.includes('*"sin él"*'), "la instrucción de quitarlo va en negrita");
const aLaTienda = mensajeTiendaProductoNoEncontrado(12, "kétchup", "- Mayonesa x1\n\n- Coca x2", "Mayonesa");
assert(aLaTienda.includes('No encontré "kétchup"'), "el aviso a la tienda conserva la frase");
assert(aLaTienda.includes("ORDEN #12 NO_DISPONIBLE Mayonesa"), "el comando a la tienda se copia sin asteriscos");
assert(!/ORDEN #\d+ NO_DISPONIBLE \*/.test(aLaTienda), "el comando no abre negrita");

const specific = formatSpecificItemLine({
  nombre_producto: "Coca-Cola",
  presentacion: "2 litros",
  cantidad: 1,
  unidad: "pieza",
});
const checked = formatCheckedLines([specific]);
assert(checked.includes(specific), "la negrita no parte el texto del producto");
assert(checked.includes("*"), "la línea del ticket sí va en negrita");

console.log(`Estilo: ${cases.length} emojis y los bloques de saludo, lista, ticket, menú y comandos.`);
