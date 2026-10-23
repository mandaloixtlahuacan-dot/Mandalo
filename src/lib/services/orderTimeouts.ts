// El cliente y el repartidor siguen en 10 minutos, con recordatorio a los 5.
// La tienda (las tres: Peke's, George y La Central) tiene 15 minutos para
// confirmar. El recordatorio a la tienda sale una sola vez, a los 8 minutos.
// Los tres casos comparten la misma mecánica (deadline + recordatorio), así
// que viven bajo un único prefijo de campos en metadata_json.

export const ORDER_TIMEOUT_MINUTES = 10;
export const ORDER_TIMEOUT_REMINDER_BEFORE_MINUTES = 5;
export const STORE_QUOTE_TIMEOUT_MINUTES = 15;
export const STORE_QUOTE_REMINDER_AT_MINUTES = 8;

function scheduleFor(kind: OrderTimeoutKind): { deadlineMinutes: number; reminderAtMinutes: number } {
  if (kind === "store_quote") {
    return { deadlineMinutes: STORE_QUOTE_TIMEOUT_MINUTES, reminderAtMinutes: STORE_QUOTE_REMINDER_AT_MINUTES };
  }
  return {
    deadlineMinutes: ORDER_TIMEOUT_MINUTES,
    reminderAtMinutes: ORDER_TIMEOUT_MINUTES - ORDER_TIMEOUT_REMINDER_BEFORE_MINUTES,
  };
}

export type OrderTimeoutKind = "store_quote" | "final_confirmation" | "courier_confirmation" | "product_adjustment";

function fieldNames(kind: OrderTimeoutKind) {
  return {
    deadlineAt: `${kind}_deadline_at`,
    reminderAt: `${kind}_reminder_at`,
    remindedAt: `${kind}_reminded_at`,
  } as const;
}

// Metadata a fusionar en pedidos.metadata_json al ENTRAR al estado de espera
// correspondiente (pendiente_tiendas, confirmado_tiendas, dispatch_repartidor_pendiente).
export function buildOrderTimeoutMetadata(
  kind: OrderTimeoutKind,
  fromIso: string = new Date().toISOString(),
): Record<string, unknown> {
  const fromMs = Date.parse(fromIso);
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  const { deadlineAt, reminderAt, remindedAt } = fieldNames(kind);
  const schedule = scheduleFor(kind);

  return {
    [deadlineAt]: new Date(base + schedule.deadlineMinutes * 60 * 1000).toISOString(),
    [reminderAt]: new Date(base + schedule.reminderAtMinutes * 60 * 1000).toISOString(),
    [remindedAt]: null,
  };
}

export function orderTimeoutFieldNames(kind: OrderTimeoutKind) {
  return fieldNames(kind);
}

// Límite de espera para que una tienda cerrada abra (CLAUDE.md Sección 8,
// agosto 2026) — distinto de los tres timeouts de arriba: no espera una
// respuesta de alguien en la conversación, espera un evento real (la tienda
// abre), así que el plazo es mucho más largo y no tiene "recordatorio" a la
// mitad. Nombre de campo separado a propósito (no reusa fieldNames/kind) para
// no mezclar semánticas distintas bajo la misma convención de 10 minutos.
export const STORE_REOPEN_MAX_WAIT_HOURS = 48;
export const ESPERANDO_APERTURA_DEADLINE_FIELD = "esperando_apertura_deadline_at";

export function buildEsperandoAperturaMetadata(fromIso: string = new Date().toISOString()): Record<string, unknown> {
  const fromMs = Date.parse(fromIso);
  const base = Number.isFinite(fromMs) ? fromMs : Date.now();
  return {
    [ESPERANDO_APERTURA_DEADLINE_FIELD]: new Date(base + STORE_REOPEN_MAX_WAIT_HOURS * 60 * 60 * 1000).toISOString(),
  };
}
