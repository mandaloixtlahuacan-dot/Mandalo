/**
 * Máquina de estados canónica de Mándalo (Fase 3 / Bloque 1).
 *
 * Módulo puro y aislado:
 * - sin Supabase / OpenAI / proveedor de WhatsApp
 * - sin side effects
 */
export const ORDER_STATES = [
  "capturando_pedido",
  "rechazado_fuera_de_zona",
  "pendiente_confirmacion_cliente",
  "pendiente_cotizacion_tienda",
  "pendiente_aprobacion_total",
  "pendiente_aceptacion_repartidor",
  "repartidor_confirmado",
  "pedido_recogido",
  "repartidor_en_destino",
  "pendiente",
  "confirmado",
  "dispatch_repartidor_pendiente",
  "confirmado_para_repartidor",
  "reasignacion_pendiente",
  "recogido",
  "en_camino",
  "entregado",
  "cancelado",
  "bloqueado_operativamente",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type OrderStatus =
  | "pendiente"
  | "confirmado"
  | "dispatch_repartidor_pendiente"
  | "confirmado_para_repartidor"
  | "reasignacion_pendiente"
  | "recogido"
  | "en_camino"
  | "entregado"
  | "cancelado";

export const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pendiente: ["confirmado", "cancelado"],
  confirmado: ["dispatch_repartidor_pendiente", "cancelado"],
  dispatch_repartidor_pendiente: ["confirmado_para_repartidor", "reasignacion_pendiente", "cancelado"],
  confirmado_para_repartidor: ["recogido", "reasignacion_pendiente", "cancelado"],
  reasignacion_pendiente: ["dispatch_repartidor_pendiente", "cancelado"],
  recogido: ["en_camino", "cancelado"],
  en_camino: ["entregado", "cancelado"],
  entregado: [],
  cancelado: [],
};

export type OrderItem = {
  name: string;
  qty?: string | null;
  details?: string | null;
};

export type TransitionContext = {
  // Identidad / trazabilidad (opcionales, para auditoría y futuras fases)
  orderId?: number | null;
  customerName?: string | null;
  businessId?: number | string | null;
  businessName?: string | null;
  businessPhone?: string | null;
  courierId?: number | string | null;
  courierPhone?: string | null;
  mapsLink?: string | null;
  zoneValidation?: boolean | null;
  logistics?: unknown;

  items?: OrderItem[] | null;
  addressText?: string | null;
  customerPhone?: string | null;
  total?: number | null;
  business?: {
    name?: string | null;
    phone?: string | null;
  } | null;
  courier?: {
    name?: string | null;
    phone?: string | null;
  } | null;
  courierAvailable?: boolean | null;
};

export type GuardValidationResult =
  | { ok: true }
  | { ok: false; failed: string[] };

export type TransitionValidationResult = {
  allowed: boolean;
  guards: GuardValidationResult;
};

const ALLOWED_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  capturando_pedido: [
    "capturando_pedido",
    "rechazado_fuera_de_zona",
    "pendiente_confirmacion_cliente",
    "cancelado",
    "bloqueado_operativamente",
  ],
  rechazado_fuera_de_zona: ["capturando_pedido", "cancelado"],
  pendiente_confirmacion_cliente: [
    "capturando_pedido",
    "pendiente_cotizacion_tienda",
    "cancelado",
    "bloqueado_operativamente",
  ],
  pendiente_cotizacion_tienda: [
    "pendiente_aprobacion_total",
    "capturando_pedido",
    "cancelado",
    "bloqueado_operativamente",
  ],
  pendiente_aprobacion_total: [
    "capturando_pedido",
    "pendiente_aceptacion_repartidor",
    "dispatch_repartidor_pendiente",
    "cancelado",
    "bloqueado_operativamente",
  ],
  pendiente_aceptacion_repartidor: [
    "repartidor_confirmado",
    "pendiente_aprobacion_total",
    "dispatch_repartidor_pendiente",
    "cancelado",
    "bloqueado_operativamente",
  ],
  repartidor_confirmado: ["pedido_recogido", "recogido", "cancelado", "bloqueado_operativamente"],
  pedido_recogido: ["repartidor_en_destino", "en_camino", "cancelado", "bloqueado_operativamente"],
  repartidor_en_destino: ["entregado", "cancelado", "bloqueado_operativamente"],
  pendiente: VALID_TRANSITIONS.pendiente,
  confirmado: VALID_TRANSITIONS.confirmado,
  dispatch_repartidor_pendiente: VALID_TRANSITIONS.dispatch_repartidor_pendiente,
  confirmado_para_repartidor: VALID_TRANSITIONS.confirmado_para_repartidor,
  reasignacion_pendiente: VALID_TRANSITIONS.reasignacion_pendiente,
  recogido: VALID_TRANSITIONS.recogido,
  en_camino: VALID_TRANSITIONS.en_camino,
  entregado: [],
  cancelado: [],
  bloqueado_operativamente: [
    "capturando_pedido",
    "pendiente_confirmacion_cliente",
    "pendiente_cotizacion_tienda",
    "pendiente_aprobacion_total",
    "pendiente_aceptacion_repartidor",
    "cancelado",
  ],
} as const;

export function normalizeLegacyState(raw: string): OrderState | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;

  const map: Record<string, OrderState> = {
    collecting: "capturando_pedido",
    esperando_confirmacion: "pendiente_confirmacion_cliente",
    awaiting_confirmation: "pendiente_confirmacion_cliente",
    awaiting_quote: "pendiente_cotizacion_tienda",
    cotizando: "pendiente_cotizacion_tienda",
    awaiting_confirm: "pendiente_aprobacion_total",
    pendiente: "pendiente",
    confirmado: "confirmado",
    confirmado_para_repartidor: "confirmado_para_repartidor",
    dispatch_repartidor_pendiente: "dispatch_repartidor_pendiente",
    reasignacion_pendiente: "reasignacion_pendiente",
    recogido: "recogido",
    en_proceso: "dispatch_repartidor_pendiente",
    pendiente_aceptacion_repartidor: "dispatch_repartidor_pendiente",
    repartidor_asignado: "confirmado_para_repartidor",
    repartidor_confirmado: "confirmado_para_repartidor",
    asignado: "confirmado_para_repartidor",
    en_camino: "en_camino",
    pedido_recogido: "recogido",
    llegado: "repartidor_en_destino",
    completado: "entregado",
    entregado: "entregado",
    cancelado: "cancelado",
  };

  return map[v] ?? null;
}

export function isTerminalState(state: OrderState): boolean {
  return state === "entregado" || state === "cancelado";
}

export function buildGoogleMapsLink(addressText: string | null | undefined): string | null {
  const a = String(addressText ?? "").trim();
  if (!a) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;
}

export function isAddressInIxtlahuacan(addressText: string | null | undefined): boolean {
  const a = String(addressText ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!a) return false;
  return (
    a.includes("ixtlahuacan del rio") ||
    a.includes("ixtlahuacan del río") ||
    a.includes("ixtlahuacan")
  );
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

function hasItems(items: TransitionContext["items"]): boolean {
  const arr = Array.isArray(items) ? items : [];
  return arr.length > 0 && arr.every((it) => String(it?.name ?? "").trim().length > 0);
}

function hasBusiness(business: TransitionContext["business"]): boolean {
  return Boolean(String(business?.name ?? "").trim());
}

function hasBusinessPhone(business: TransitionContext["business"]): boolean {
  return Boolean(String(business?.phone ?? "").trim());
}

function hasAddress(addressText: TransitionContext["addressText"]): boolean {
  return Boolean(String(addressText ?? "").trim());
}

function hasPositiveTotal(total: TransitionContext["total"]): boolean {
  return typeof total === "number" && Number.isFinite(total) && total > 0;
}

function hasCourierAssigned(courier: TransitionContext["courier"]): boolean {
  return Boolean(String(courier?.name ?? "").trim() || String(courier?.phone ?? "").trim());
}

export function validateTransitionGuards(
  from: OrderState,
  to: OrderState,
  context: TransitionContext,
): GuardValidationResult {
  const failed: string[] = [];

  const zoneOk = isAddressInIxtlahuacan(context.addressText);
  const mapsLink = buildGoogleMapsLink(context.addressText);

  const key = `${from}->${to}` as const;
  switch (key) {
    case "capturando_pedido->pendiente_confirmacion_cliente": {
      if (!hasItems(context.items)) failed.push("items");
      if (!hasBusiness(context.business)) failed.push("business.name");
      if (!hasAddress(context.addressText)) failed.push("addressText");
      if (!zoneOk) failed.push("zona_no_valida");
      break;
    }
    case "capturando_pedido->rechazado_fuera_de_zona": {
      if (!hasAddress(context.addressText)) failed.push("addressText");
      if (zoneOk) failed.push("zona_es_valida_no_debe_rechazar");
      break;
    }
    case "pendiente_confirmacion_cliente->pendiente_cotizacion_tienda": {
      if (!hasBusiness(context.business)) failed.push("business.name");
      if (!hasBusinessPhone(context.business)) failed.push("business.phone");
      if (!hasItems(context.items)) failed.push("items");
      if (!hasAddress(context.addressText)) failed.push("addressText");
      break;
    }
    case "pendiente_cotizacion_tienda->pendiente_aprobacion_total": {
      if (!hasPositiveTotal(context.total)) failed.push("total");
      break;
    }
    case "pendiente_aprobacion_total->pendiente_aceptacion_repartidor":
    case "pendiente_aprobacion_total->dispatch_repartidor_pendiente":
    case "confirmado->dispatch_repartidor_pendiente": {
      if (!Boolean(String(context.customerPhone ?? "").trim())) failed.push("customerPhone");
      if (!hasAddress(context.addressText)) failed.push("addressText");
      if (!mapsLink) failed.push("mapsLink");
      if (!hasItems(context.items)) failed.push("items");
      if (!hasPositiveTotal(context.total)) failed.push("total");
      if (context.courierAvailable !== true) failed.push("courierAvailable");
      break;
    }
    case "pendiente_aceptacion_repartidor->repartidor_confirmado":
    case "dispatch_repartidor_pendiente->confirmado_para_repartidor": {
      if (!hasCourierAssigned(context.courier)) failed.push("courier");
      break;
    }
    case "repartidor_confirmado->pedido_recogido":
    case "confirmado_para_repartidor->recogido": {
      if (!hasCourierAssigned(context.courier)) failed.push("courier");
      break;
    }
    case "pedido_recogido->repartidor_en_destino":
    case "recogido->en_camino": {
      if (!hasCourierAssigned(context.courier)) failed.push("courier");
      break;
    }
    case "repartidor_en_destino->entregado":
    case "en_camino->entregado": {
      if (!hasCourierAssigned(context.courier)) failed.push("courier");
      break;
    }
    default:
      // Transiciones sin guardrails mínimos en esta fase
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
