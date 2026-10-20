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
  | { action: "guide"; body: string }
  | { action: "ignore" };

function foldEcho(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Texto libre de la tienda. Un precio se acepta solo si no hay duda de cuál
 * pedido es: el parser ya sacó el monto y hay un solo pedido esperando, o el
 * mensaje completo es un número y hay un solo pedido. Si no, se guía.
 */
/** El aviso que nosotros mandamos trae el ejemplo y el comando de faltante juntos. No es una cotización. */
export function isBotInstructionPaste(text: string): boolean {
  const folded = foldEcho(text);
  if (folded.includes("asi me contestas")) return true;
  if (folded.includes("nombre del producto") && (/no hay/.test(folded) || /no_?disponible/.test(folded))) return true;
  if (folded.includes("responde asi") && /precio\s+150\b/.test(folded) && /no_?disponible/.test(folded)) return true;
  if (folded.includes("responde asi") && /no hay/.test(folded) && (/precio\s+150\b/.test(folded) || /\bconfirmo\b/.test(folded))) return true;
  if (folded.includes("separalos con coma") && /no hay/.test(folded)) return true;
  if (folded.includes("comando invalido")) return true;
  const commands = ["#confirmo", "#recogi", "#entregado"].filter((token) => folded.includes(token));
  return commands.length >= 2;
}

const OWN_COPY_SNIPPETS = [
  "soy mandalo, tu mandadero",
  "solo es un ejemplo, no esta en tu pedido",
  "tuve un problema procesando tu mensaje",
  "esa ubicacion en tiempo real no la manejamos",
  "por ahora solo podemos atender mensajes de texto",
  "de cual te hago el mandado",
  "cual categoria te late",
  "cual te encargo",
  "gracias por tu compra y por confiar en nosotros",
];

/** Copia de un texto que este bot manda. Vale en cualquier proceso, sin memoria. */
export function isOwnOutboundCopy(text: string): boolean {
  if (isBotInstructionPaste(text)) return true;
  const folded = foldEcho(text);
  if (folded.length < 12) return false;
  if (OWN_COPY_SNIPPETS.some((snippet) => folded.includes(snippet))) return true;
  if (folded.includes("envio y servicio") && folded.includes("confirmas tu pedido")) return true;
  if (folded.includes("tienes un nuevo pedido") && folded.includes("#confirmo")) return true;
  return false;
}

const ACK_WORD =
  /^(ok|okey|okay|si|sip|recibido|recibi|gracias|listo|va|sale|enterado|acuerdo|perfecto|bueno|hola|buen|dia|dias|buenos|buenas|tarde|tardes|noche|noches|de|👍|✅)$/u;

/** "ok" o "recibido" de la tienda o del repartidor. No trae pedido ni precio. */
export function isBareAck(text: string): boolean {
  const folded = foldEcho(text)
    .replace(/[^\p{L}\p{N}\s👍✅]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!folded || folded.length > 40 || /\d/.test(folded)) return false;
  const words = folded.split(" ");
  return words.length > 0 && words.length <= 4 && words.every((word) => ACK_WORD.test(word));
}

export function classifyRoleChatter(text: string): "echo" | "ack" | "message" {
  if (isOwnOutboundCopy(text)) return "echo";
  if (isBareAck(text)) return "ack";
  return "message";
}

export function planStoreFreeText(params: { text: string; openOrderIds: number[] }): StoreFreeTextPlan {
  const ids = [...new Set(params.openOrderIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (isBotInstructionPaste(params.text)) return { action: "ignore" };
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

/** El SÍ de la lista con precios es el último del cliente. La tienda de menú fijo igual confirma después. */
export function mayPrepareStore(customerFinalConfirmed: boolean): boolean {
  return customerFinalConfirmed;
}

/** Orden de los mensajes al cliente cuando un pedido programado de menú fijo sale. */
export function scheduledCustomerMessageOrder(catalog: boolean): Array<"ya_se_envio" | "total"> {
  if (catalog) return ["ya_se_envio", "total"];
  return ["ya_se_envio"];
}
