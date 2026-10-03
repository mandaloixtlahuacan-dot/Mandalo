/**
 * Frases con las que la tienda marca un faltante. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-no-disponible.ts
 */
import { readFileSync } from "node:fs";
import { isYesConfirmation } from "../src/lib/messages";
import {
  calculateFinalPrice,
  esConfirmacionCliente,
  extraerComandoNoDisponible,
  extraerNoDisponible,
  extraerOrdenId,
  extraerPrecio,
  MANDALO_DELIVERY_FEE,
  MANDALO_SERVICE_FEE,
  mensajeClienteProductoNoDisponible,
  mensajeTiendaProductoNoEncontrado,
} from "../src/lib/ordenes";

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

function assertComando(texto: string, ordenId: number, productoTexto: string) {
  const got = extraerComandoNoDisponible(texto);
  assert(
    got?.ordenId === ordenId && got.productoTexto === productoTexto,
    `${JSON.stringify(texto)} → ${JSON.stringify(got)}, se esperaba orden ${ordenId} y ${JSON.stringify(productoTexto)}`,
  );
}

function assertIgnorado(texto: string) {
  assert(extraerComandoNoDisponible(texto) === null, `${JSON.stringify(texto)} no debe marcar un producto`);
}

assert(MANDALO_SERVICE_FEE === 10 && MANDALO_DELIVERY_FEE === 25, "el desglose interno sigue 10+25");
assert(calculateFinalPrice(100) === 135, "el total sigue siendo tienda + 35");

assertComando("ORDEN #12 no disponible mayonesa", 12, "mayonesa");
assertComando("orden 12 no hay coca", 12, "coca");
assertComando("ORDEN #12 No está la leche", 12, "la leche");
assertComando("orden 12 no esta la leche", 12, "la leche");
assertComando("ORDEN #12 NO_DISPONIBLE mayonesa", 12, "mayonesa");
assertComando("orden #12 no_disponible mayonesa", 12, "mayonesa");
assertComando("ORDEN #12 NO DISPONIBLE Mayonesa", 12, "Mayonesa");
assertComando("#12 no hay coca", 12, "coca");
assertComando("ORDEN #12 no está disponible jamón", 12, "jamón");
assertComando("ORDEN #12 no están las papas", 12, "las papas");
assertComando("ORDEN #162 NO_DISPONIBLE: takis fuego", 162, "takis fuego");
assertComando("ORDEN #12 no-disponible coca-cola", 12, "coca-cola");
assertComando("ORDEN #12\nno disponible\nmayonesa", 12, "mayonesa");
assertComando("ya no hay coca, orden 12", 12, "coca");

assert(extraerNoDisponible("No está la leche")?.productoTexto === "la leche", "la frase no está se reconoce");
assert(extraerNoDisponible("no esta la leche")?.productoTexto === "la leche", "no esta sin acento se reconoce");
assertIgnorado("No está la leche");
assertIgnorado("no hay coca");
assertIgnorado("no hay");
assertIgnorado("hola, qué tal");
assertIgnorado("no estamos bien");
assert(extraerNoDisponible("no hay") === null, "no hay sin producto no es frase");
assert(extraerNoDisponible("hola, qué tal") === null, "la charla no es frase");
assert(extraerNoDisponible("no estamos bien") === null, "no estamos no es no está");

assertIgnorado("ORDEN #12 PRECIO 150");
assertIgnorado("ORDEN #12 PRECIO 150 no hay problema");
assert(extraerPrecio("ORDEN #12 PRECIO 150 no hay problema") === 150, "no hay problema no se come el PRECIO");
assertComando("ORDEN #12 NO_DISPONIBLE mayonesa PRECIO 80", 12, "mayonesa PRECIO 80");
assert(extraerOrdenId("ORDEN #12 PRECIO 150") === 12, "el precio sigue trayendo la orden 12");
assert(extraerPrecio("ORDEN #12 PRECIO 150") === 150, "PRECIO 150 no se confunde con la orden");
assert(extraerPrecio("ORDEN #162 PRECIO 87") === 87, "PRECIO 87 no agarra el 162");
assert(extraerOrdenId("ORDEN #162 PRECIO 87") === 162, "la orden del precio sigue siendo 162");
assertIgnorado("ORDEN #12 TOTAL 90");
assert(extraerPrecio("ORDEN #12 TOTAL 90") === 90, "TOTAL sigue siendo comando de precio");

for (const comando of ["#CONFIRMO 12", "#RECOGI 12", "#ENTREGADO 12", "#confirmo 12"]) {
  assertIgnorado(comando);
  assert(extraerPrecio(comando) === null, `${comando} no es un precio`);
}
const courier = readFileSync("src/lib/services/courierCommandParser.ts", "utf8");
assert(
  courier.includes("normalized.match(/^#(CONFIRMO|RECOGI|ENTREGADO)\\s+(\\d+)$/i)"),
  "el comando del repartidor sigue siendo #CONFIRMO / #RECOGI / #ENTREGADO y el número",
);

for (const si of ["sí", "SÍ", "si", "ok"]) {
  assert(isYesConfirmation(si), `${si} sigue siendo el sí del cliente`);
  assertIgnorado(si);
}
assert(esConfirmacionCliente("si") && esConfirmacionCliente("ok"), "el helper viejo de sí no se movió");
assert(!isYesConfirmation("ORDEN #12 no disponible mayonesa"), "el faltante no es un sí");
assert(!isYesConfirmation("No está la leche"), "no está no confirma el pedido");

const alCliente = mensajeClienteProductoNoDisponible("ZAGU", "Mayonesa McCormick");
assert(
  alCliente ===
    `📦 *ZAGU* no tiene disponible:\n"Mayonesa McCormick"\n\n` +
      `¿Quieres continuar tu pedido sin este producto, o prefieres cambiarlo por otro?\n\n` +
      `Responde "sin él" para quitarlo, o dime el producto por el que lo cambias. 🙏`,
  "el aviso al cliente conserva tienda, producto guardado y la opción de quitar o cambiar",
);
assert(mensajeClienteProductoNoDisponible(null, "Coca").includes("*La tienda*"), "sin nombre de tienda usa La tienda");
assert(mensajeClienteProductoNoDisponible("Abarrotes", "Coca").includes('"Coca"'), "el producto va entre comillas");

const aLaTienda = mensajeTiendaProductoNoEncontrado(12, "kétchup", "- Mayonesa x1\n- Coca x2", "Mayonesa");
assert(aLaTienda.includes('No encontré "kétchup"'), "le dice a la tienda qué texto no encontró");
assert(aLaTienda.includes("- Mayonesa x1") && aLaTienda.includes("- Coca x2"), "lista las líneas del pedido");
assert(aLaTienda.includes("ORDEN #12 NO_DISPONIBLE Mayonesa"), "incluye un ejemplo corto");
assert(!aLaTienda.includes("sin él"), "el ejemplo a la tienda no es el mensaje del cliente");

const flow = readFileSync("src/lib/mandaloFlow.ts", "utf8");
const notFoundStart = flow.indexOf("findPedidoItemByText");
const flagStart = flow.indexOf("await flagItemUnavailable", notFoundStart);
const notFound = flow.slice(notFoundStart, flagStart);
assert(notFound.includes("mensajeTiendaProductoNoEncontrado"), "si no hay línea, se arma el recado a la tienda");
assert(notFound.includes("PRODUCTO_NO_ENCONTRADO"), "ese caso regresa sin marcar el producto");
assert(!notFound.includes("mensajeClienteProductoNoDisponible"), "ese caso no arma el mensaje al cliente");

const dispatch = readFileSync("src/lib/services/storeDispatch.ts", "utf8");
assert(
  dispatch.includes("mensajeClienteProductoNoDisponible(pedido.tienda.nombre, item.nombreProducto)"),
  "al cliente se le nombra el producto guardado, no el texto de la tienda",
);

console.log("check-no-disponible: ok");
