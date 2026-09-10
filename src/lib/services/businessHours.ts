// Validación de horario. El bot en sí sigue platicando y armando pedidos
// 24/7 (eso no cambió) — lo que se restringe es el DESPACHO: Mándalo solo
// reparte de 3pm a 9pm (horario real del repartidor, reintroducido agosto
// 2026 tras la fase 24/7, ajustado de 3pm-8pm a 3pm-9pm — ver CLAUDE.md
// Sección 5 regla 6), y cada tienda
// tiene además su propio horario en base de datos (tiendas.hora_apertura /
// hora_cierre, columnas `text` libres — ver Fase 1; y tiendas.dias_cerrado,
// días fijos de descuento — ver migración 20260909). Un pedido fuera de
// cualquiera de las dos ventanas se programa (mismo mecanismo,
// esperando_apertura_tienda) en vez de rechazarse. Los repartidores no
// tienen columnas de horario en el esquema (CLAUDE.md Sección 4): su
// disponibilidad ya se gobierna por `disponible`/`activo`, que es lo que
// findActiveCourier() ya filtra — no hace falta nada nuevo para ellos aquí.

const MANDALO_TIMEZONE = "America/Mexico_City";

const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

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

// Día de la semana (0=domingo … 6=sábado, misma convención que
// Date.getDay() y Postgres EXTRACT(DOW)) en la zona horaria de México.
// Se ancla a mediodía UTC de la fecha local para que getUTCDay no se
// corra de día por el offset de zona horaria.
export function weekdayInMandalo(now: Date): number {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: MANDALO_TIMEZONE,
  }).format(now);
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
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

// Formato de 12 horas para mensajes al cliente ("3pm", "8am", "7:30pm").
// Se apoya en parseHourToMinutes para tolerar los mismos formatos de
// entrada ("8", "08:00", "20:00", "8 pm", …).
export function formatHour12(raw: string): string {
  const total = parseHourToMinutes(raw);
  if (total == null) return String(raw ?? "").trim();

  const hour24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;
  const minuteText = minute > 0 ? `:${String(minute).padStart(2, "0")}` : "";
  return `${hour12}${minuteText}${meridiem}`;
}

export function parseDiasCerrado(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

// Horario completo en una línea para que la IA pueda responder "a qué hora
// abren/cierran", "qué días tienen servicio", etc. Ej: "todos los días menos
// el lunes, de 7pm a 12am" / "todos los días, de 8am a 8pm". Vacío si no hay
// horas usables cargadas.
export function describeHorarioTienda(params: {
  horaApertura: string | null;
  horaCierre: string | null;
  diasCerrado?: number[] | null;
}): string {
  const openMin = parseHourToMinutes(params.horaApertura);
  const closeMin = parseHourToMinutes(params.horaCierre);
  const rango =
    openMin != null && closeMin != null
      ? `de ${formatHour12(params.horaApertura ?? "")} a ${formatHour12(params.horaCierre ?? "")}`
      : "";

  const cerrados = [...new Set(parseDiasCerrado(params.diasCerrado))].sort((a, b) => a - b);
  let dias = "";
  if (cerrados.length === 0) {
    dias = rango ? "todos los días" : "";
  } else if (cerrados.length < 7) {
    const nombres = cerrados.map((d) => `el ${DIAS_SEMANA[d]}`);
    const lista =
      nombres.length === 1 ? nombres[0] : `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
    dias = `todos los días menos ${lista}`;
  }

  return [dias, rango].filter(Boolean).join(", ");
}

// Texto "abre {hoy|mañana|el <día>} a las <hora 12h>" — el primer día de
// operación (que no esté en diasCerrado) a partir de hoy, considerando si
// hoy ya pasó la hora de apertura. Solo se llama cuando la tienda está
// cerrada (checkTiendaSchedule devolvió withinSchedule:false).
function describeProximaApertura(params: {
  horaApertura: string | null;
  diasCerrado: number[];
  now: Date;
}): string {
  const openMin = parseHourToMinutes(params.horaApertura);
  if (openMin == null) return "";
  const aperturaTexto = formatHour12(params.horaApertura ?? "");

  const nowMin = nowInMandaloMinutes(params.now);
  const hoy = weekdayInMandalo(params.now);
  const cerrado = new Set(params.diasCerrado);

  for (let offset = 0; offset < 7; offset++) {
    const dia = (hoy + offset) % 7;
    if (cerrado.has(dia)) continue;

    if (offset === 0) {
      if (nowMin < openMin) return `abre hoy a las ${aperturaTexto}`;
      continue; // hoy ya abrió y cerró — el siguiente día de operación
    }
    if (offset === 1) return `abre mañana a las ${aperturaTexto}`;
    return `abre el ${DIAS_SEMANA[dia]} a las ${aperturaTexto}`;
  }
  return "";
}

export type TiendaScheduleCheck =
  | { withinSchedule: true }
  | {
      withinSchedule: false;
      closedReason: "hora" | "dia";
      abreTexto: string;
      horaApertura: string;
      horaCierre: string;
      diasCerrado: number[];
    };

function closedResult(
  closedReason: "hora" | "dia",
  horaApertura: string | null,
  horaCierre: string | null,
  diasCerrado: number[],
  now: Date,
): TiendaScheduleCheck {
  return {
    withinSchedule: false,
    closedReason,
    abreTexto: describeProximaApertura({ horaApertura, diasCerrado, now }) || "abre pronto",
    horaApertura: String(horaApertura ?? ""),
    horaCierre: String(horaCierre ?? ""),
    diasCerrado,
  };
}

// Si la tienda no tiene horario cargado en BD, se trata como siempre abierta
// (fail-open) — no todas las tiendas van a tener el dato cargado de entrada.
export function checkTiendaSchedule(params: {
  horaApertura: string | null;
  horaCierre: string | null;
  diasCerrado?: number[] | null;
  now?: Date;
}): TiendaScheduleCheck {
  const now = params.now ?? new Date();
  const diasCerrado = parseDiasCerrado(params.diasCerrado);

  const openMin = parseHourToMinutes(params.horaApertura);
  const closeRaw = parseHourToMinutes(params.horaCierre);
  if (openMin == null || closeRaw == null) return { withinSchedule: true };

  // "00:00" como hora de cierre = fin del día (medianoche), no "cruza a las
  // 12am" — sin esto, un cierre a medianoche exacta se comporta raro.
  const closeMin = closeRaw === 0 ? 1440 : closeRaw;

  if (diasCerrado.includes(weekdayInMandalo(now))) {
    return closedResult("dia", params.horaApertura, params.horaCierre, diasCerrado, now);
  }

  const nowMin = nowInMandaloMinutes(now);
  const within =
    openMin <= closeMin
      ? nowMin >= openMin && nowMin < closeMin
      : nowMin >= openMin || nowMin < closeMin; // horario que cruza medianoche

  if (within) return { withinSchedule: true };
  return closedResult("hora", params.horaApertura, params.horaCierre, diasCerrado, now);
}

// Ventana fija de despacho de Mándalo — reusa checkTiendaSchedule pasándole
// estos valores en vez de duplicar la lógica de horario cruzando medianoche/
// fail-open. Constantes exportadas (no solo usadas aquí) para que el prompt
// y los mensajes al cliente muestren siempre el mismo valor.
export const MANDALO_HORA_APERTURA = "15:00";
export const MANDALO_HORA_CIERRE = "21:00";

export function checkMandaloSchedule(now?: Date): TiendaScheduleCheck {
  return checkTiendaSchedule({ horaApertura: MANDALO_HORA_APERTURA, horaCierre: MANDALO_HORA_CIERRE, now });
}
