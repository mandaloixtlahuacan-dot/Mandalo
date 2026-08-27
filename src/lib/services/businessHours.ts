// Validación de horario. El bot en sí sigue platicando y armando pedidos
// 24/7 (eso no cambió) — lo que se restringe es el DESPACHO: Mándalo solo
// reparte de 3pm a 8pm (horario real del repartidor, reintroducido agosto
// 2026 tras la fase 24/7 — ver CLAUDE.md Sección 5 regla 6), y cada tienda
// tiene además su propio horario en base de datos (tiendas.hora_apertura /
// hora_cierre, columnas `text` libres — ver Fase 1). Un pedido fuera de
// cualquiera de las dos ventanas se programa (mismo mecanismo,
// esperando_apertura_tienda) en vez de rechazarse. Los repartidores no
// tienen columnas de horario en el esquema (CLAUDE.md Sección 4): su
// disponibilidad ya se gobierna por `disponible`/`activo`, que es lo que
// findActiveCourier() ya filtra — no hace falta nada nuevo para ellos aquí.

const MANDALO_TIMEZONE = "America/Mexico_City";

function nowInMandaloMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone: MANDALO_TIMEZONE,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

// Tolera "8:00", "08:00", "8:00 am", "8:00 PM", "20:00". Si no puede
// interpretarlo, regresa null (fail-open: no bloquear por un dato sucio).
export function parseHourToMinutes(raw: string | null | undefined): number | null {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return null;

  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;

  return hour * 60 + minute;
}

export type TiendaScheduleCheck = { withinSchedule: true } | { withinSchedule: false; horaApertura: string; horaCierre: string };

// Si la tienda no tiene horario cargado en BD, se trata como siempre abierta
// (fail-open) — no todas las tiendas van a tener el dato cargado de entrada.
export function checkTiendaSchedule(params: {
  horaApertura: string | null;
  horaCierre: string | null;
  now?: Date;
}): TiendaScheduleCheck {
  const openMin = parseHourToMinutes(params.horaApertura);
  const closeMin = parseHourToMinutes(params.horaCierre);
  if (openMin == null || closeMin == null) return { withinSchedule: true };

  const nowMin = nowInMandaloMinutes(params.now ?? new Date());
  const within =
    openMin <= closeMin
      ? nowMin >= openMin && nowMin < closeMin
      : nowMin >= openMin || nowMin < closeMin; // horario que cruza medianoche

  if (within) return { withinSchedule: true };
  return { withinSchedule: false, horaApertura: String(params.horaApertura), horaCierre: String(params.horaCierre) };
}

// Ventana fija de despacho de Mándalo — reusa checkTiendaSchedule pasándole
// estos valores en vez de duplicar la lógica de horario cruzando medianoche/
// fail-open. Constantes exportadas (no solo usadas aquí) para que el prompt
// y los mensajes al cliente muestren siempre el mismo valor.
export const MANDALO_HORA_APERTURA = "15:00";
export const MANDALO_HORA_CIERRE = "20:00";

export function checkMandaloSchedule(now?: Date): TiendaScheduleCheck {
  return checkTiendaSchedule({ horaApertura: MANDALO_HORA_APERTURA, horaCierre: MANDALO_HORA_CIERRE, now });
}
