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

export const MANDALO_SERVICE_FEE = 10;
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

// Comando de tienda mencionado desde BLOQUE 1 del prompt ("Asume disponibilidad
// y deja que la tienda cotice o responda #NO_DISPONIBLE") pero nunca antes
// implementado — cierra el estado ajuste_producto, que existía en la máquina
// de estados sin lógica real detrás. Formato esperado: "ORDEN #162 NO_DISPONIBLE
// takis fuego" (mismo estilo que "ORDEN #162 PRECIO 87") — el texto después del
// comando es la referencia del producto, se resuelve por coincidencia difusa
// contra pedido_items en el llamador.
export function extraerNoDisponible(texto: string): { productoTexto: string } | null {
  const normalized = String(texto ?? "");
  const m = normalized.match(/no_disponible\b[:\-]?\s*(.+)/i);
  if (!m) return null;
  const productoTexto = m[1].trim();
  return productoTexto ? { productoTexto } : null;
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
