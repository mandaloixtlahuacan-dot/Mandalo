/**
 * Utilidades puras de precio y parseo de texto para el flujo de pedidos.
 *
 * Antes este archivo también hacía acceso directo a Supabase (crearOrden,
 * transitionOrderState, actualizarOrden, ...) sobre la tabla legacy `pedidos`.
 * Con la migración al esquema definitivo, toda la persistencia vive en
 * pedidoRepositoryV2.ts (captura) y stateTransitionService.ts (ciclo de vida
 * del repartidor) — una sola fuente de verdad, sin este segundo camino
 * paralelo. Este archivo queda como funciones puras, sin efectos de lado.
 */

/** Parte de Mándalo dentro del cargo. Desde el 5 de octubre de 2026 es 0: el cliente paga un solo $25. */
export const MANDALO_SERVICE_FEE = 0;
/** Parte del repartidor. Junto con MANDALO_SERVICE_FEE suma el $25 que ve el cliente. */
export const DELIVERY_FEE = 25;
export const MANDALO_DELIVERY_FEE = DELIVERY_FEE;

export function calculateOrderTotal(storePrice: number) {
  const base = Number(storePrice);
  const precioTienda = Number.isFinite(base) && base > 0 ? base : 0;
  const total = precioTienda + MANDALO_SERVICE_FEE + DELIVERY_FEE;

  return {
    precioTienda,
    servicioMandalo: MANDALO_SERVICE_FEE,
    servicioDomicilio: DELIVERY_FEE,
    total,
  };
}

export function calculateFinalPrice(storePrice: number): number {
  return calculateOrderTotal(storePrice).total;
}

export function extraerOrdenId(texto: string): number | null {
  const normalized = String(texto ?? "");
  const m =
    normalized.match(/\borden\s*#\s*(\d+)/i) ||
    normalized.match(/\borden\s+(\d+)/i) ||
    normalized.match(/#\s*(\d+)/) ||
    normalized.match(/\b(\d+)\s*(?:precio|total)\b/i);
  return m ? Number(m[1]) : null;
}

export function extraerPrecio(texto: string): number | null {
  // IMPORTANTE:
  // En mensajes como: "ORDEN #162 PRECIO 87" no queremos capturar 162.
  // Extraemos estrictamente el número DESPUÉS de la palabra "PRECIO" o "TOTAL".
  const normalized = String(texto ?? "").replace(/,/g, ".");
  const m =
    normalized.match(/\bprecio\b[^0-9]*([0-9]+(\.[0-9]+)?)/i) ||
    normalized.match(/\btotal\b[^0-9]*([0-9]+(\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

// La tienda marca un producto mientras cotiza. Acepta el token de siempre y
// frases naturales, en cualquier combinación de mayúsculas, con o sin guion
// bajo: "no disponible", "no_disponible", "no hay", "no está" / "no esta"
// (también el plural "no están"). El texto que sigue es el producto; el
// número de orden lo exige extraerComandoNoDisponible, no esta función.
// "á" se aplana solo para buscar la frase: el nombre del producto se recorta
// del texto original, así que conserva acentos y mayúsculas.
const FRASE_NO_DISPONIBLE =
  /\b(?:no[\s_-]+disponible|no\s+estan?(?:\s+disponible)?|no\s+hay)\b[\s:,.\-–—!?¿¡]*(\S(?:.*\S)?)/;

function foldMatchText(value: string): string {
  return value.toLowerCase().replace(/[áéíóúü]/g, (ch) => {
    if (ch === "á") return "a";
    if (ch === "é") return "e";
    if (ch === "í") return "i";
    if (ch === "ó") return "o";
    return "u";
  });
}

function limpiarProductoTexto(value: string): string {
  return value
    .replace(/\s+orden\s*#?\s*\d+\s*$/i, "")
    .replace(/^[\s,;:.!?¿¡–—-]+|[\s,;:.!?¿¡–—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extraerNoDisponible(texto: string): { productoTexto: string } | null {
  const original = String(texto ?? "").replace(/\s+/g, " ").trim();
  if (!original) return null;
  const folded = foldMatchText(original);
  const match = folded.match(FRASE_NO_DISPONIBLE);
  if (!match || match.index == null || !match[1]) return null;
  const productStart = match.index + match[0].length - match[1].length;
  const productoTexto = limpiarProductoTexto(original.slice(productStart));
  if (!productoTexto || !/[0-9a-záéíóúüñ]/i.test(productoTexto)) return null;
  return { productoTexto };
}

// Hace falta el número de orden Y un producto. Sin orden, "no hay coca" o
// una charla no marcan nada — aunque la frase sí se haya reconocido.
// Un PRECIO/TOTAL con número sigue siendo cotización: "no hay problema"
// pegado a "PRECIO 150" no se roba el comando. El token no_disponible sí
// gana, igual que antes.
export function extraerComandoNoDisponible(texto: string): { ordenId: number; productoTexto: string } | null {
  const ordenId = extraerOrdenId(texto);
  const parsed = extraerNoDisponible(texto);
  if (!ordenId || !parsed) return null;
  const esToken = /\bno[\s_-]+disponible\b/.test(foldMatchText(String(texto ?? "")));
  if (extraerPrecio(texto) != null && !esToken) return null;
  return { ordenId, productoTexto: parsed.productoTexto };
}

// Mismo texto que ya ve el cliente cuando la tienda (o el catálogo fijo)
// marca un faltante. El nombre entre comillas es el nombreProducto guardado,
// no lo que la tienda escribió.
export function mensajeClienteProductoNoDisponible(tiendaNombre: string | null | undefined, nombreProducto: string): string {
  return (
    `📦 *${tiendaNombre ?? "La tienda"}* no tiene disponible:\n"${nombreProducto}"\n\n` +
    `¿Quieres continuar tu pedido sin este producto, o prefieres cambiarlo por otro?\n\n` +
    `Responde "sin él" para quitarlo, o dime el producto por el que lo cambias. 🙏`
  );
}

// Si el texto no coincide con una línea, se le dice solo a la tienda.
export function mensajeTiendaProductoNoEncontrado(
  ordenId: number,
  productoTexto: string,
  lineas: string,
  ejemploProducto: string,
): string {
  return (
    `No encontré "${productoTexto}" en el pedido #${ordenId}.\n\n` +
    `Productos del pedido:\n${lineas}\n\n` +
    `Escribe el nombre tal como aparece arriba, ej: ORDEN #${ordenId} NO_DISPONIBLE ${ejemploProducto}`
  );
}

// Formato de moneda consistente para mensajes al cliente/tienda/repartidor:
// enteros sin decimales ($150), no enteros con dos decimales ($150.50) — evita
// artefactos de punto flotante (ej. $150.30000000000001) y mensajes con
// formato inconsistente entre distintos puntos del flujo.
export function formatMoney(amount: number): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "$0";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

export function esConfirmacionCliente(texto: string): boolean {
  return /\b(si|sí|ok|va|confirmo|confirmar|dale|de acuerdo)\b/i.test(texto.trim());
}

export type OrdenEstado = "cotizando" | "esperando_confirmacion" | "asignado" | "en_camino" | "entregado" | "cancelado";

export function esActualizacionRepartidor(texto: string): OrdenEstado | null {
  const t = texto.toLowerCase();
  if (t.includes("en camino") || t.includes("voy")) return "en_camino";
  if (t.includes("entregado") || t.includes("entregue") || t.includes("entregué")) return "entregado";
  if (t.includes("cancel")) return "cancelado";
  return null;
}
