/**
 * Máquina de estados canónica de Mándalo — Sección 7 del CLAUDE.md.
 *
 * Módulo puro y aislado:
 * - sin Supabase / OpenAI / proveedor de WhatsApp
 * - sin side effects
 *
 * Nota: hasta la Fase 2 había dos vocabularios de estado superpuestos (uno
 * "v2" legacy y uno "v3"), más un tercer vocabulario de strings persistidas
 * en la tabla legacy `pedidos.estado`. Con la migración al esquema definitivo,
 * `pedidos.estado` es un enum nativo de Postgres con exactamente estos 11
 * valores — ya no hace falta normalizar strings legacy.
 *
 * La validación de zona geográfica (Regla de oro #1) ya NO vive aquí: se
 * hace con Haversine sobre coordenadas reales, ANTES de crear cualquier
 * registro (ver mandaloFlow.ts). Por eso no existe un estado "fuera de zona"
 * en este catálogo — un pedido fuera de cobertura nunca llega a persistirse.
 */
export const ORDER_STATES = [
  "seleccion_productos",
  "confirmacion_cliente",
  "esperando_apertura_tienda",
  "pendiente_tiendas",
  "ajuste_producto",
  "confirmado_tiendas",
  "dispatch_repartidor_pendiente",
  "repartidor_asignado",
  "recogiendo",
  "en_camino_cliente",
  "entregado",
  "cancelado",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type OrderItem = {
  name: string;
  qty?: string | null;
  details?: string | null;
};

export type TransitionContext = {
  // Identidad / trazabilidad (opcionales, para auditoría)
  orderId?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;

  businessId?: number | string | null;
  businessName?: string | null;
  businessPhone?: string | null;
  business?: {
    name?: string | null;
    phone?: string | null;
  } | null;

  courierId?: number | string | null;
  courierPhone?: string | null;
  courier?: {
    name?: string | null;
    phone?: string | null;
  } | null;
  courierAvailable?: boolean | null;

  items?: OrderItem[] | null;
  addressText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  mapsLink?: string | null;
  total?: number | null;
  logistics?: unknown;
};

export type GuardValidationResult = { ok: true } | { ok: false; failed: string[] };

export type TransitionValidationResult = {
  allowed: boolean;
  guards: GuardValidationResult;
};

// Grafo de transiciones permitidas. `cancelado` es alcanzable desde cualquier
// estado no terminal (el cliente, una tienda sin stock, o un timeout pueden
// cancelar en cualquier punto del flujo — Sección 8).
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  seleccion_productos: ["seleccion_productos", "confirmacion_cliente", "cancelado"],
  confirmacion_cliente: ["seleccion_productos", "pendiente_tiendas", "esperando_apertura_tienda", "cancelado"],
  // La tienda elegida estaba cerrada al momento de confirmar (Sección 5,
  // regla 6) — espera aquí hasta que abra, luego sigue exactamente igual
  // que un pedido normal (-> pendiente_tiendas).
  esperando_apertura_tienda: ["pendiente_tiendas", "cancelado"],
  pendiente_tiendas: ["ajuste_producto", "confirmado_tiendas", "cancelado"],
  ajuste_producto: ["pendiente_tiendas", "cancelado"],
  confirmado_tiendas: ["dispatch_repartidor_pendiente", "cancelado"],
  // Repartidor no puede completar a medio pedido (Sección 8): puede regresar
  // a "buscando repartidor" desde cualquier punto de la logística del envío.
  dispatch_repartidor_pendiente: ["repartidor_asignado", "cancelado"],
  repartidor_asignado: ["recogiendo", "dispatch_repartidor_pendiente", "cancelado"],
  recogiendo: ["en_camino_cliente", "dispatch_repartidor_pendiente", "cancelado"],
  en_camino_cliente: ["entregado", "dispatch_repartidor_pendiente", "cancelado"],
  entregado: [],
  cancelado: [],
};

export function isTerminalState(state: OrderState): boolean {
  return state === "entregado" || state === "cancelado";
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function hasItems(items: TransitionContext["items"]): boolean {
  const arr = Array.isArray(items) ? items : [];
  return arr.length > 0 && arr.every((it) => String(it?.name ?? "").trim().length > 0);
}

function hasBusiness(context: TransitionContext): boolean {
  return Boolean(String(context.business?.name ?? context.businessName ?? "").trim());
}

function hasBusinessPhone(context: TransitionContext): boolean {
  return Boolean(String(context.business?.phone ?? context.businessPhone ?? "").trim());
}

function hasAddress(context: TransitionContext): boolean {
  const hasText = Boolean(String(context.addressText ?? "").trim());
  const hasCoords =
    typeof context.latitude === "number" &&
    Number.isFinite(context.latitude) &&
    typeof context.longitude === "number" &&
    Number.isFinite(context.longitude);
  return hasText || hasCoords;
}

function hasPositiveTotal(total: TransitionContext["total"]): boolean {
  return typeof total === "number" && Number.isFinite(total) && total > 0;
}

function hasCourierAssigned(context: TransitionContext): boolean {
  return Boolean(
    String(context.courier?.name ?? "").trim() ||
      String(context.courier?.phone ?? context.courierPhone ?? "").trim(),
  );
}

export function validateTransitionGuards(
  from: OrderState,
  to: OrderState,
  context: TransitionContext,
): GuardValidationResult {
  const failed: string[] = [];
  const key = `${from}->${to}` as const;

  switch (key) {
    case "seleccion_productos->confirmacion_cliente": {
      if (!hasItems(context.items)) failed.push("items");
      if (!hasBusiness(context)) failed.push("business.name");
      if (!hasAddress(context)) failed.push("addressText");
      break;
    }
    case "confirmacion_cliente->pendiente_tiendas":
    case "confirmacion_cliente->esperando_apertura_tienda":
    case "esperando_apertura_tienda->pendiente_tiendas": {
      // Mismas precondiciones en los tres casos: esperando_apertura_tienda
      // es solo una versión diferida de confirmacion_cliente->pendiente_tiendas
      // (la tienda estaba cerrada al confirmar); cuando abre, se completa
      // exactamente la misma transición que si hubiera estado abierta desde
      // el inicio.
      if (!hasBusiness(context)) failed.push("business.name");
      if (!hasBusinessPhone(context)) failed.push("business.phone");
      if (!hasItems(context.items)) failed.push("items");
      if (!hasAddress(context)) failed.push("addressText");
      break;
    }
    case "pendiente_tiendas->confirmado_tiendas": {
      if (!hasPositiveTotal(context.total)) failed.push("total");
      break;
    }
    case "confirmado_tiendas->dispatch_repartidor_pendiente": {
      if (!Boolean(String(context.customerPhone ?? "").trim())) failed.push("customerPhone");
      if (!hasAddress(context)) failed.push("addressText");
      if (!hasItems(context.items)) failed.push("items");
      if (!hasPositiveTotal(context.total)) failed.push("total");
      break;
    }
    case "dispatch_repartidor_pendiente->repartidor_asignado": {
      if (!hasCourierAssigned(context)) failed.push("courier");
      break;
    }
    case "repartidor_asignado->recogiendo":
    case "recogiendo->en_camino_cliente":
    case "en_camino_cliente->entregado": {
      if (!hasCourierAssigned(context)) failed.push("courier");
      break;
    }
    default:
      // El resto de transiciones (cancelaciones, retrocesos a ajuste_producto,
      // reasignación de repartidor) no tienen precondiciones adicionales en
      // esta fase — quien las dispara ya validó lo necesario en el flujo.
      break;
  }

  return failed.length ? { ok: false, failed } : { ok: true };
}

export function assertTransition(from: OrderState, to: OrderState, context: TransitionContext): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición ilegal: ${from} -> ${to}`);
  }

  const guards = validateTransitionGuards(from, to, context);
  if (!guards.ok) {
    throw new Error(
      `Precondiciones fallidas para transición ${from} -> ${to}: ${guards.failed.join(", ")}`,
    );
  }
}
