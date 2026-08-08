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

export const MANDALO_SERVICE_FEE = 20;
export const DELIVERY_FEE = 35;
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
