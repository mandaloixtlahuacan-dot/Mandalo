import { formatHour12, type TiendaScheduleCheck } from "@/lib/services/businessHours";

/** Misma idea que el texto del bot cuando el pedido espera a que abran. */
export function describeWhyWaiting(params: {
  tiendaNombre: string;
  tiendaSchedule: TiendaScheduleCheck;
  mandaloSchedule: TiendaScheduleCheck;
}): string {
  const { tiendaNombre, tiendaSchedule, mandaloSchedule } = params;
  if (!mandaloSchedule.withinSchedule && !tiendaSchedule.withinSchedule) {
    return (
      `Por ahora operamos de ${formatHour12(mandaloSchedule.horaApertura)} a ${formatHour12(mandaloSchedule.horaCierre)}, y ahorita está fuera de ese horario — ` +
      `*${tiendaNombre}* también está cerrada (${tiendaSchedule.abreTexto})`
    );
  }
  if (!mandaloSchedule.withinSchedule) {
    return `Por ahora operamos de ${formatHour12(mandaloSchedule.horaApertura)} a ${formatHour12(mandaloSchedule.horaCierre)}, y ahorita está fuera de ese horario`;
  }
  if (!tiendaSchedule.withinSchedule) {
    return `*${tiendaNombre}* está cerrada ahora, ${tiendaSchedule.abreTexto}`;
  }
  return `*${tiendaNombre}* y Mándalo ya deberían estar disponibles`;
}

export function scheduledCustomerMessage(pedidoId: number, why: string): string {
  return `⏰ *Pedido #${pedidoId} programado.*\n\n${why}.\n\nTe aviso apenas se mande.`;
}
