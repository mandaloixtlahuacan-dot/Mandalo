import { isGreetingOnly } from "@/lib/customerUx";
import { formatStoreCommandHelp } from "@/lib/customerUx";
import { extraerOrdenId, extraerPrecio, extraerPrecioSuelto } from "@/lib/ordenes";

/** Armando el pedido, antes de que la tienda lo vea. */
export const BUILDING_ORDER_STATES = ["seleccion_productos", "confirmacion_cliente"] as const;

export const INACTIVE_CANCEL_REASON = "inactivo";

/** Más de 3 horas sin movimiento: el worker lo cancela en silencio. */
export const INACTIVE_AFTER_MS = 3 * 60 * 60 * 1000;

/** Más de 2 horas: un saludo empieza de cero en vez de reabrir la lista vieja. */
export const GREETING_RESET_AFTER_MS = 2 * 60 * 60 * 1000;

export function isBuildingOrderState(estado: string): boolean {
  return (BUILDING_ORDER_STATES as readonly string[]).includes(estado);
}

export function buildingIdleMs(updatedAtIso: string | null | undefined, nowMs: number): number | null {
  const updatedMs = Date.parse(String(updatedAtIso ?? ""));
  if (!Number.isFinite(updatedMs)) return null;
  return nowMs - updatedMs;
}

export function shouldCancelBuildingForInactivity(estado: string, idleMs: number | null): boolean {
  if (!isBuildingOrderState(estado) || idleMs == null) return false;
  return idleMs > INACTIVE_AFTER_MS;
}

export function shouldRestartOnGreeting(estado: string, message: string, idleMs: number | null): boolean {
  if (!isBuildingOrderState(estado) || idleMs == null) return false;
  if (!(idleMs > GREETING_RESET_AFTER_MS)) return false;
  return isGreetingOnly(message);
}

/**
 * El timeout de "no confirmaste el precio" no aplica cuando el cliente ya
 * confirmó y el problema es que no hay repartidor.
 */
export function priceConfirmTimeoutApplies(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.sin_repartidor !== true;
}

export type StoreFreeTextPlan =
  | { action: "price"; pedidoId: number; amount: number }
  | { action: "guide"; body: string };

/**
 * Texto libre de la tienda. Un precio se acepta solo si no hay duda de cuál
 * pedido es: el parser ya sacó el monto y hay un solo pedido esperando, o el
 * mensaje completo es un número y hay un solo pedido. Si no, se guía.
 */
export function planStoreFreeText(params: { text: string; openOrderIds: number[] }): StoreFreeTextPlan {
  const ids = [...new Set(params.openOrderIds.filter((id) => Number.isInteger(id) && id > 0))];
  const fromCommand = extraerPrecio(params.text);
  const ordenId = extraerOrdenId(params.text);
  if (fromCommand != null && fromCommand > 0) {
    if (ordenId != null && ids.includes(ordenId)) return { action: "price", pedidoId: ordenId, amount: fromCommand };
    if (ordenId == null && ids.length === 1) return { action: "price", pedidoId: ids[0], amount: fromCommand };
  }
  const loose = extraerPrecioSuelto(params.text);
  if (loose != null && ids.length === 1) return { action: "price", pedidoId: ids[0], amount: loose };
  return { action: "guide", body: formatStoreCommandHelp(ids) };
}

export type OutboxRetryPlan = {
  permanent: boolean;
  estado: "fallida" | "cancelada";
  nextAttemptAt: string;
};

/** Reintento con espera que se duplica. Al intento máximo queda cancelada y no se reenvía. */
export function planOutboxRetry(params: {
  attempt: number;
  maxAttempts: number;
  baseSeconds: number;
  nowMs: number;
}): OutboxRetryPlan {
  if (params.attempt >= params.maxAttempts) {
    return {
      permanent: true,
      estado: "cancelada",
      nextAttemptAt: new Date(params.nowMs).toISOString(),
    };
  }
  const delaySeconds = Math.min(params.baseSeconds * Math.pow(2, Math.max(params.attempt - 1, 0)), 3600);
  return {
    permanent: false,
    estado: "fallida",
    nextAttemptAt: new Date(params.nowMs + delaySeconds * 1000).toISOString(),
  };
}

export type CatalogAfterList = "stay" | "ask_address" | "dispatch";

/** El SÍ de la lista con precios es el último. Luego ubicación y, con ella, el envío. */
export function catalogStepAfterList(params: { confirmed: boolean; hasAddress: boolean }): CatalogAfterList {
  if (!params.confirmed) return "stay";
  if (!params.hasAddress) return "ask_address";
  return "dispatch";
}

/** La tienda de menú fijo recibe "Prepáralo" solo después del SÍ final. */
export function mayPrepareStore(customerFinalConfirmed: boolean): boolean {
  return customerFinalConfirmed;
}

/** Orden de los mensajes al cliente cuando un pedido programado de menú fijo sale. */
export function scheduledCustomerMessageOrder(catalog: boolean): Array<"ya_se_envio" | "total"> {
  if (catalog) return ["ya_se_envio", "total"];
  return ["ya_se_envio"];
}
