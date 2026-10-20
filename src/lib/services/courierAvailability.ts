// Horario semanal de cada repartidor (repartidores.horario_json) y el
// claim del #CONFIRMO. Puro: no toca Supabase. La zona es America/Mexico_City,
// igual que el horario de Mándalo y el de las tiendas.
//
// Clave del día: 0=domingo … 6=sábado. Sin la clave de ese día, el repartidor
// no está disponible. La hora de cierre no entra (igual que la tienda).
// Sin horario_json no se le ofrece el pedido: hay que cargar el horario.

import { checkTiendaSchedule, formatHour12, parseHorarioPorDia, weekdayInMandalo } from "@/lib/services/businessHours";

export const MATEO_PHONE_INTL = "5213327898967";
/** Moy. El número antes estaba dado de alta como Roberto. */
export const MOY_PHONE_INTL = "5213314705434";

/** Tardes lun–vie y domingo, y el sábado el día completo. Cierra 23:30. */
export const MATEO_HORARIO_JSON = {
  "0": { abre: "15:00", cierra: "23:30" },
  "1": { abre: "15:00", cierra: "23:30" },
  "2": { abre: "15:00", cierra: "23:30" },
  "3": { abre: "15:00", cierra: "23:30" },
  "4": { abre: "15:00", cierra: "23:30" },
  "5": { abre: "15:00", cierra: "23:30" },
  "6": { abre: "08:00", cierra: "23:30" },
} as const;

/** Moy: todos los días 08:00–23:30, menos el sábado. */
export const MOY_HORARIO_JSON = {
  "0": { abre: "08:00", cierra: "23:30" },
  "1": { abre: "08:00", cierra: "23:30" },
  "2": { abre: "08:00", cierra: "23:30" },
  "3": { abre: "08:00", cierra: "23:30" },
  "4": { abre: "08:00", cierra: "23:30" },
  "5": { abre: "08:00", cierra: "23:30" },
} as const;

export const COURIER_ORDER_TAKEN_MESSAGE =
  "⚠️ Ya lo tomó otro repartidor. Este pedido ya no es tuyo.";

export type CourierScheduleRow = {
  id?: number | null;
  nombre?: string | null;
  telefono?: string | null;
  activo?: boolean | null;
  disponible?: boolean | null;
  horarioJson?: unknown;
};

export function isCourierOnSchedule(horarioJson: unknown, now: Date): boolean {
  const parsed = parseHorarioPorDia(horarioJson);
  const hours = parsed[weekdayInMandalo(now)];
  if (!hours) return false;
  return checkTiendaSchedule({ horaApertura: hours.abre, horaCierre: hours.cierra, now }).withinSchedule;
}

export function selectAvailableCouriers<T extends CourierScheduleRow>(couriers: T[], now: Date): T[] {
  return couriers.filter((courier) => {
    if (courier.activo !== true || courier.disponible === false) return false;
    if (!String(courier.telefono ?? "").trim()) return false;
    return isCourierOnSchedule(courier.horarioJson, now);
  });
}

export function mandaloHoursCustomerText(apertura: string, cierre: string): string {
  return `de ${formatHour12(apertura)} a ${formatHour12(cierre)}`;
}

export type CourierClaimRow = {
  estado: string;
  repartidorId: number | null;
};

/** Misma condición que el UPDATE: estado pendiente y repartidor_id nulo. */
export function courierOfferStillOpen(row: CourierClaimRow): boolean {
  return row.estado === "dispatch_repartidor_pendiente" && row.repartidorId == null;
}

export function applyCourierConfirmClaim(
  row: CourierClaimRow,
  courierId: number,
): { claimed: boolean; row: CourierClaimRow; message: string | null } {
  if (!courierOfferStillOpen(row)) {
    return { claimed: false, row, message: COURIER_ORDER_TAKEN_MESSAGE };
  }
  return {
    claimed: true,
    row: { estado: "repartidor_asignado", repartidorId: courierId },
    message: null,
  };
}

export function phonesMatch(left: string, right: string): boolean {
  const a = String(left ?? "").replace(/\D/g, "");
  const b = String(right ?? "").replace(/\D/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const a10 = a.length <= 10 ? a : a.slice(-10);
  const b10 = b.length <= 10 ? b : b.slice(-10);
  return a10 === b10;
}

export type OfferedCourierRef = { id: number | null; telefono: string };

export function courierMayConfirmOffer(params: {
  offered: OfferedCourierRef[];
  repartidorId: number | null;
  currentCourierId: number | null;
  currentCourierPhone: string;
  courierId: number | null;
  courierPhone: string;
}): boolean {
  if (params.repartidorId != null && params.courierId != null) {
    return params.repartidorId === params.courierId;
  }

  if (params.offered.length > 0) {
    return params.offered.some(
      (row) =>
        (row.id != null && params.courierId != null && row.id === params.courierId) ||
        phonesMatch(row.telefono, params.courierPhone),
    );
  }

  if (params.currentCourierId != null && params.courierId != null) {
    return params.currentCourierId === params.courierId;
  }
  if (params.currentCourierPhone) return phonesMatch(params.currentCourierPhone, params.courierPhone);
  return true;
}

export type OfferedCourierContact = { id: number | null; nombre: string; telefono: string };

function toId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readOfferedCouriers(metadata: Record<string, unknown> | null | undefined): OfferedCourierContact[] {
  const raw = metadata?.offered_couriers;
  const listed: OfferedCourierContact[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const telefono = String(row.telefono ?? "").trim();
      if (!telefono) continue;
      listed.push({
        id: toId(row.id),
        nombre: String(row.nombre ?? "").trim() || "Repartidor",
        telefono,
      });
    }
  }
  if (listed.length) return listed;

  const telefono = String(metadata?.current_courier_phone ?? "").trim();
  if (!telefono) return [];
  return [
    {
      id: toId(metadata?.current_courier_id),
      nombre: String(metadata?.current_courier_name ?? "").trim() || "Repartidor",
      telefono,
    },
  ];
}

export function buildCourierOfferMessage(params: {
  courierName: string;
  pedidoId: number;
  storeName: string;
  pickupAddress: string;
  dropoffAddress: string;
  mapsLink: string | null;
  itemsText: string;
  chargeLine: string | null;
  customerPhone: string;
}): string {
  const maps = params.mapsLink ? `${params.mapsLink}\n` : "";
  const charge = params.chargeLine ? `${params.chargeLine}\n\n` : "";
  return (
    `🛵 *Hola ${params.courierName}, tienes un nuevo pedido*\n\n` +
    `🧾 *Pedido #${params.pedidoId}*\n\n` +
    `🏪 *${params.storeName}*\n\n` +
    `📍 *Recoger en:*\n${params.pickupAddress}\n\n` +
    `📍 *Entregar en:*\n${params.dropoffAddress}\n` +
    `${maps}\n` +
    `🛒 *Productos:*\n\n${params.itemsText}\n\n` +
    `${charge}` +
    `*Tel. cliente:* ${params.customerPhone}\n\n` +
    `*Responde con:*\n#CONFIRMO ${params.pedidoId}\n\n` +
    `*Luego:*\n#RECOGI ${params.pedidoId}\n\n#ENTREGADO ${params.pedidoId}`
  );
}

export function buildCustomerCourierCoordinatingMessage(params: {
  pedidoId: number;
  etaText: string;
  courierNames: string[];
}): string {
  const named = params.courierNames.length === 1 ? ` con *${params.courierNames[0]}*` : "";
  const followup =
    params.courierNames.length > 1 ? "Te aviso en cuanto un repartidor confirme." : "Te aviso en cuanto confirme.";
  return (
    `✅ *Pedido #${params.pedidoId} confirmado*\n\n` +
    `Llegará aproximadamente a las ${params.etaText}.\n\n` +
    `🛵 Estamos coordinando tu entrega${named}.\n\n` +
    followup
  );
}
