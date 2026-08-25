// Validación de horario — Mándalo opera 24/7 (sin horario fijo general,
// retirado agosto 2026 para poder atender pedidos a cualquier hora); cada
// tienda tiene su propio horario en base de datos (tiendas.hora_apertura /
// hora_cierre, columnas `text` libres — ver Fase 1). Los repartidores no
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
