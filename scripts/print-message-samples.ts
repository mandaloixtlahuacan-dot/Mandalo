/**
 * Texto real de los mensajes, para revisarlo como se vería en WhatsApp.
 * No manda nada. Correr: npx tsx scripts/print-message-samples.ts
 */
import { applyCatalogSpeech } from "../src/lib/catalogOrderSpeech";
import { CARNICERIA_LA_CENTRAL_PRODUCTOS } from "../src/lib/carniceriaLaCentralCatalog";
import { priceCatalogOrder } from "../src/lib/catalogQuantities";
import { renderPedidoSummary } from "../src/lib/confirmationAmendment";
import {
  buildGreeting,
  CUSTOMER_STORE_NICHES,
  formatAbarrotesStoreAck,
  formatCatalogCategories,
  formatCatalogMenuCaption,
  formatCatalogOrderRegistered,
  formatCatalogReceiptFee,
  formatCustomerQuoteMessage,
  formatHowToEditList,
  formatNicheStoreList,
  formatNoFixedMenu,
  formatPreConfirmFeeNote,
  formatQuoteOrderRegistered,
  formatStuckCorrection,
  type UxStore,
} from "../src/lib/customerUx";
import { formatCheckedLine, formatNameQtyLine, joinBlocks } from "../src/lib/messageStyle";
import { mensajeClienteProductoNoDisponible, mensajeTiendaProductoNoEncontrado } from "../src/lib/ordenes";
import { quoteQuestionForItems } from "../src/lib/quoteProductClarity";
import { ADDRESS_ASK_MESSAGE, buildCustomerMessage, formatProductListConfirm, formatSpecificItemLine } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";

function section(title: string, body: string) {
  console.log(`\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}\n`);
  console.log(body.trimEnd());
  console.log();
}

const zagu: UxStore = {
  id: 1,
  nombre: "ZAGU",
  categoria: "Abarrotes",
  telefono: "5213300000000",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: false,
};
const aguaSanta: UxStore = {
  id: 2,
  nombre: "Abarrotes Agua Santa",
  categoria: "Abarrotes",
  telefono: "5213300000001",
  abierta: false,
  abreTexto: "abre mañana a las 8am",
  usaCatalogoFijo: false,
};
const george: UxStore = {
  id: 7,
  nombre: "Hamburguesas Hotdogs George",
  categoria: "Restaurante",
  telefono: "5213300000002",
  abierta: true,
  abreTexto: "",
  usaCatalogoFijo: true,
};
const central: UxStore = {
  id: 8,
  nombre: "Carnicería La Central",
  categoria: "Carnicerías",
  telefono: "5213318527050",
  abierta: false,
  abreTexto: "abre mañana a las 8am",
  usaCatalogoFijo: true,
};

const abarrotes = CUSTOMER_STORE_NICHES.find((niche) => niche.id === "abarrotes")!;
const restaurantes = CUSTOMER_STORE_NICHES.find((niche) => niche.id === "restaurantes")!;
const carnicerias = CUSTOMER_STORE_NICHES.find((niche) => niche.id === "carnicerias")!;

const pedidoAbarrotes = [
  { nombre_producto: "Coca-Cola", marca: "Coca-Cola", presentacion: "2 litros", cantidad: 2, unidad: "pieza" },
  { nombre_producto: "Sopa", marca: "Maruchan", presentacion: "habanero", cantidad: 1, unidad: "pieza" },
  { nombre_producto: "Pinol", presentacion: "1 litro", cantidad: 1, unidad: "pieza" },
  { nombre_producto: "Tortillas", presentacion: "de maíz", cantidad: 1, unidad: "kilo" },
];

section("ABARROTES — saludo", buildGreeting());
section(
  "ABARROTES — lista de tiendas",
  formatNicheStoreList(abarrotes, [zagu, aguaSanta, george, central]),
);
section("ABARROTES — pedido, con ejemplo", formatAbarrotesStoreAck(zagu));
section(
  "ABARROTES — tienda cerrada, se programa",
  formatAbarrotesStoreAck({ ...aguaSanta, abierta: false }),
);
section(
  "ABARROTES — falta marca o tamaño",
  quoteQuestionForItems([{ nombre_producto: "Leche", cantidad: 1 }]) ?? "(sin pregunta)",
);
section("ABARROTES — OK, pediste", formatProductListConfirm(pedidoAbarrotes));
section("ABARROTES — ayuda para corregir", formatHowToEditList());
section("ABARROTES — corrección que no movió la lista", formatStuckCorrection(1));
section("ABARROTES — segunda corrección, ya dice reiniciar", formatStuckCorrection(2));
section(
  "ABARROTES — atorado, con la lista",
  formatStuckCorrection(1, {
    itemLines: [
      "✅ 🥤 *Coca-Cola, 2 litros, x2*",
      "✅ 🧼 *Pinol, 1 litro, x1*",
      "✅ 🛍️ *Tang, 3 sobres*",
    ],
  }),
);
section("ABARROTES — ubicación", ADDRESS_ASK_MESSAGE);

const snapshot = {
  businessId: 1,
  businessName: "ZAGU",
  addressText: "Calle Hidalgo 12, frente a la tortillería",
  addressZone: "Calle Hidalgo",
  items: pedidoAbarrotes,
};
const ticketAntes = buildCustomerMessage({
  validation: validateCaptureForConfirmation({
    snapshot,
    items: pedidoAbarrotes,
    knownZoneNames: ["Calle Hidalgo"],
    quoteStore: true,
  }),
  snapshot,
  items: pedidoAbarrotes,
  feeNote: formatPreConfirmFeeNote("cotiza_tienda"),
});
section("ABARROTES — resumen antes del SÍ final", ticketAntes);
section("ABARROTES — pedido registrado", formatQuoteOrderRegistered(102, "ZAGU"));
section(
  "ABARROTES — ticket cuando la tienda ya cotizó",
  formatCustomerQuoteMessage({
    tiendaNombre: "ZAGU",
    pedidoId: 102,
    subtotal: 97,
    total: 122,
    itemLines: [
      "2 Coca-Cola de 2 litros — $36",
      "1 sopa Maruchan de habanero — $15",
      "1 Pinol de 1 litro — $28",
      "1 kg de tortillas — $18",
    ],
  }),
);
section(
  "ABARROTES — se mandó al abrir",
  "🧾 *Pedido #102*\n\nYa se envió a *ZAGU*.\n\nTe aviso en cuanto confirme el precio.",
);
section(
  "ABARROTES — no abrió en 48 horas",
  "⏰ *Pedido #102*\n\nSe canceló: *ZAGU* no abrió a tiempo.\n\nCuando quieras, puedes hacer un nuevo pedido.",
);
section(
  "ABARROTES — fuera de cobertura",
  "📍 *Por ahora Mándalo solo cubre entregas dentro de Ixtlahuacán del Río.*\n\nTu ubicación quedó fuera de esa zona.\n\nEn cuanto ampliemos la cobertura te avisamos. ¡Gracias por tu interés!",
);
section("ABARROTES — producto que la tienda no tiene", mensajeClienteProductoNoDisponible("ZAGU", "Pinol 1 litro"));
section(
  "ABARROTES — cancelar",
  "✅ *Listo, cancelé tu pedido.*\n\nCuando quieras hacer uno nuevo, aquí estoy.",
);
section("ABARROTES — reiniciar", `✅ *Pedido anterior cancelado.*\n\n${buildGreeting()}`);
section(
  "ESTADO — aceptado, en camino, entregado",
  [
    "🛵 *Pedido #102*",
    "",
    "*Luis* ya tiene tu pedido y está en camino.",
    "",
    "---",
    "",
    "🛵 *Tu pedido ya va con el repartidor*, en camino a recogerlo.",
    "",
    "---",
    "",
    "🛵 *El repartidor ya recogió tu pedido* y va en camino.",
    "",
    "---",
    "",
    "✅ *Pedido #102 entregado.*",
    "",
    "¡*Gracias por tu compra y por confiar en nosotros*!",
    "",
    "Buen provecho.",
  ].join("\n"),
);
section(
  "ERRORES Y TIEMPOS",
  [
    "🧾 *Pedido #102*",
    "",
    "Se canceló porque la tienda no respondió a tiempo.",
    "",
    "¿Quieres pedir de otro negocio?",
    "",
    "---",
    "",
    "⏰ *Pedido #102*",
    "",
    "Está por vencer.",
    "",
    "Responde *SÍ* en los próximos *5 minutos* para confirmarlo, o se cancelará.",
    "",
    "---",
    "",
    "🛵 *Pedido #102*",
    "",
    "Por ahora no tenemos repartidores disponibles, así que lo cancelamos.",
    "",
    "En cuanto haya uno libre, puedes volver a pedir.",
    "",
    "---",
    "",
    "🧾 *Pedido #102*",
    "",
    "Ya está en proceso avanzado, así que no puedo cancelarlo yo solo.",
    "",
    "Ya avisé a nuestro equipo. Te van a contactar directo.",
  ].join("\n"),
);

const georgeCatalog = [
  { nombreProducto: "Hamburguesa de Res Chica", precio: 75 },
  { nombreProducto: "Hamburguesa de Res Grande", precio: 100 },
  { nombreProducto: "Dogo clásico", precio: 40 },
  { nombreProducto: "Papas Gajo 315g", precio: 45 },
  { nombreProducto: "Refresco", precio: 20 },
];
const georgeSpeech = applyCatalogSpeech({
  base: [],
  userMessage: "una hamburguesa de res chica, un dogo clásico y unas papas gajo",
  catalog: georgeCatalog,
});
section("GEORGE — lista de restaurantes", formatNicheStoreList(restaurantes, [george, central, zagu]));
section(
  "GEORGE — categorías",
  formatCatalogCategories(george, ["Hamburguesas", "Hot dogs", "Papas", "Bebidas"]),
);
section("GEORGE — menú", formatCatalogMenuCaption(george));
section("GEORGE — lo que anotó", georgeSpeech.reply ?? georgeSpeech.question ?? "(sin respuesta)");
const pedidoGeorge = [
  { nombre_producto: "Hamburguesa de Camarón Grande", cantidad: 1 },
  { nombre_producto: "Hamburguesa Hawaiana Grande", cantidad: 1 },
  { nombre_producto: "Salchilocos 310g", cantidad: 1 },
  { nombre_producto: "Dogo Clásico", cantidad: 3 },
  { nombre_producto: "Refresco (Pepsi, Seven, Coca, Mirinda o Manzana)", marca: "Pepsi", cantidad: 2 },
];
section("GEORGE — OK, pediste", formatProductListConfirm(pedidoGeorge, "restaurante"));
section(
  "GEORGE — ayuda para corregir",
  formatHowToEditList("restaurante"),
);
section(
  "GEORGE — atorado, con la lista",
  formatStuckCorrection(1, {
    kind: "restaurante",
    itemLines: pedidoGeorge.map((item) => formatCheckedLine(formatSpecificItemLine(item), item.nombre_producto)),
  }),
);
section("GEORGE — sin menú fijo", formatNoFixedMenu("Hamburguesas Hotdogs George", "restaurante"));
const preguntaHamburguesa = applyCatalogSpeech({
  base: [],
  userMessage: "Quiero una hamburguesa",
  catalog: [
    { nombreProducto: "Hamburguesa de Res Chica", precio: 60 },
    { nombreProducto: "Hamburguesa de Res Grande", precio: 100 },
    { nombreProducto: "Hamburguesa de Pollo Chica", precio: 70 },
    { nombreProducto: "Hamburguesa de Pollo Grande", precio: 110 },
    { nombreProducto: "Hamburguesa de Camarón Chica", precio: 90 },
    { nombreProducto: "Hamburguesa de Camarón Grande", precio: 130 },
    { nombreProducto: "Hamburguesa Hawaiana Chica", precio: 90 },
    { nombreProducto: "Hamburguesa Hawaiana Grande", precio: 120 },
    { nombreProducto: "Hamburguesa Cubana Chica", precio: 90 },
    { nombreProducto: "Hamburguesa Cubana Grande", precio: 120 },
    { nombreProducto: "Hamburguesa Mar y Tierra Chica", precio: 90 },
    { nombreProducto: "Hamburguesa Mar y Tierra Grande", precio: 140 },
    { nombreProducto: "Hamburguesa de Arrachera Chica", precio: 70 },
    { nombreProducto: "Hamburguesa de Arrachera Grande", precio: 100 },
  ],
});
section("GEORGE — cuál hamburguesa", preguntaHamburguesa.question ?? preguntaHamburguesa.reply ?? "(sin pregunta)");
const georgeTicket = renderPedidoSummary({
  pedidoId: 85,
  snapshot: {
    businessId: 7,
    businessName: "Hamburguesas Hotdogs George",
    addressText: "Calle Hidalgo 12, frente a la tortillería",
    items: georgeSpeech.items,
  },
  items: georgeSpeech.items,
  pricedLines: priceCatalogOrder(georgeSpeech.items, georgeCatalog).lines.join("\n"),
  feeNote: formatCatalogReceiptFee(priceCatalogOrder(georgeSpeech.items, georgeCatalog).subtotal),
});
section(
  "GEORGE — ticket",
  `${georgeTicket}\n\n¿Es correcto? Responde *SÍ* para confirmar.`,
);
section("GEORGE — pedido registrado", formatCatalogOrderRegistered(85, "Hamburguesas Hotdogs George"));
const fuera = applyCatalogSpeech({
  base: [],
  userMessage: "un sushi y una hamburguesa de res chica",
  catalog: georgeCatalog,
});
section("GEORGE — fuera del menú", fuera.reply ?? fuera.question ?? "(sin respuesta)");

const centralCatalog = CARNICERIA_LA_CENTRAL_PRODUCTOS.map(({ nombreProducto, precio }) => ({ nombreProducto, precio }));
const centralSpeech = applyCatalogSpeech({
  base: [],
  userMessage: "un kilo de chorizo y medio de arrachera",
  catalog: centralCatalog,
});
section(
  "LA CENTRAL — lista",
  formatNicheStoreList(carnicerias, [central, george, zagu]),
);
section("LA CENTRAL — menú, cerrada", formatCatalogMenuCaption(central));
section("LA CENTRAL — lo que anotó", centralSpeech.reply ?? centralSpeech.question ?? "(sin respuesta)");
const pedidoCentral = [
  { nombre_producto: "Bistec de res", cantidad: 1, unidad: "kilo" },
  { nombre_producto: "Chorizo", cantidad: 0.5, unidad: "kilo" },
];
section("LA CENTRAL — OK, pediste", formatProductListConfirm(pedidoCentral, "carniceria"));
section("LA CENTRAL — ayuda para corregir", formatHowToEditList("carniceria"));
section(
  "LA CENTRAL — atorado, con la lista",
  formatStuckCorrection(1, {
    kind: "carniceria",
    itemLines: ["✅ 🥩 *Bistec de res, 1 kilo*", "✅ 🥩 *Chorizo, 0.5 kilos*"],
  }),
);
section("LA CENTRAL — sin menú fijo", formatNoFixedMenu("Carnicería La Central", "carniceria"));
const centralPrice = priceCatalogOrder(centralSpeech.items, centralCatalog);
section(
  "LA CENTRAL — ticket",
  `${renderPedidoSummary({
    pedidoId: 90,
    snapshot: {
      businessId: 8,
      businessName: "Carnicería La Central",
      addressText: "Calle Hidalgo 12, frente a la tortillería",
      items: centralSpeech.items,
    },
    items: centralSpeech.items,
    pricedLines: centralPrice.lines.join("\n"),
    feeNote: formatCatalogReceiptFee(centralPrice.subtotal),
  })}\n\n¿Es correcto? Responde *SÍ* para confirmar.`,
);

const storeItems = [
  { nombreProducto: "Coca-Cola 2 litros", cantidad: 2 },
  { nombreProducto: "Sopa Maruchan habanero", cantidad: 1 },
  { nombreProducto: "Pinol 1 litro", cantidad: 1 },
  { nombreProducto: "Tortillas", cantidad: 1 },
];
const storeLines = joinBlocks(storeItems.map((item) => formatNameQtyLine(item.nombreProducto, item.cantidad, false)));
section(
  "TIENDA — cotizar",
  `🏪 *Cotizar. ORDEN #102*\n\n📍 *Entrega:*\nCalle Hidalgo 12, frente a la tortillería\n\n🛒 *Pedido*\n\n${storeLines}\n\n*Responde así:*\nORDEN #102 PRECIO 150\n\n¿Te falta algún producto?\n\n*Responde:*\nORDEN #102 NO_DISPONIBLE nombre del producto`,
);
section(
  "TIENDA — recordatorio",
  `⏰ *Recordatorio*\n\nEl pedido #102 sigue esperando tu precio.\n\n🛒 *Pedido*\n\n${storeLines}\n\nTienes *5 minutos* antes de que se cancele.\n\n*Responde así:*\nORDEN #102 PRECIO 150\n\n¿Te falta algún producto?\n\n*Responde:*\nORDEN #102 NO_DISPONIBLE nombre del producto`,
);
section(
  "TIENDA — producto no encontrado",
  mensajeTiendaProductoNoEncontrado(102, "kétchup", storeLines, "Pinol 1 litro"),
);
section(
  "TIENDA — ya no hace falta cotizar",
  "🏪 *Pedido #102*\n\nSe canceló por falta de respuesta a tiempo. Ya no es necesario cotizarlo.",
);

section(
  "REPARTIDOR — pedido nuevo",
  `🛵 *Hola Luis, tienes un nuevo pedido*\n\n🧾 *Pedido #102*\n\n🏪 *ZAGU*\n\n📍 *Recoger en:*\nCalle Hidalgo 20\n\n📍 *Entregar en:*\nCalle Hidalgo 12, frente a la tortillería\nhttps://maps.google.com/?q=20.86,-103.24\n\n🛒 *Productos:*\n\n${storeLines}\n\n💵 *Cobrar: $122*\n\n*Tel. cliente:* 5213312345678\n\n*Responde con:*\n#CONFIRMO 102\n\n*Luego:*\n#RECOGI 102\n\n#ENTREGADO 102`,
);
section(
  "REPARTIDOR — aceptado, recogido, entregado",
  [
    "✅ *Aceptación registrada*",
    "",
    "Pedido *#102*.",
    "",
    "---",
    "",
    "🛵 *Pedido #102*",
    "",
    "Lo tomó el repartidor *Luis*.",
    "",
    "---",
    "",
    "⏰ *Pedido #102*",
    "",
    "Tienes *5 minutos* más para aceptarlo, o se cancelará.",
    "",
    "*Responde:*",
    "#CONFIRMO 102",
  ].join("\n"),
);
section(
  "REPARTIDOR — comando inválido",
  "🛵 *Comando inválido.*\n\nUsa uno de estos formatos:\n\n#CONFIRMO 123\n\n#RECOGI 123\n\n#ENTREGADO 123",
);
