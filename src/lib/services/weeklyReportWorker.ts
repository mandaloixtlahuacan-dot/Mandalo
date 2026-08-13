import * as metricsRepository from "@/lib/repositories/metricsRepository";
import * as outboxRepository from "@/lib/repositories/outboxRepository";

// Reporte semanal al admin (brief sección 5): "notificación semanal... con
// contexto del negocio (cantidad de pedidos, etc.)". Corre vía pg_cron, no
// como reacción a un evento — ver supabase/migrations/20260812_metricas_semanales.sql.

function formatMoney(value: number): string {
  return `$${value.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function buildReportBody(snapshot: metricsRepository.WeeklyMetricsSnapshot): string {
  const entregados = Math.round(snapshot.pedidos_entregados ?? 0);
  const cancelados = Math.round(snapshot.pedidos_cancelados ?? 0);
  const ingresos = snapshot.ingresos_entregados ?? 0;
  const totalPedidos = entregados + cancelados;

  return (
    `Reporte semanal Mándalo\n\n` +
    `Pedidos entregados: ${entregados}\n` +
    `Pedidos cancelados: ${cancelados}\n` +
    `Total de pedidos: ${totalPedidos}\n` +
    `Ingresos de pedidos entregados: ${formatMoney(ingresos)}`
  );
}

export type WeeklyReportRunResult = { sent: boolean; snapshot: metricsRepository.WeeklyMetricsSnapshot };

export function createWeeklyReportWorker() {
  return {
    async run(): Promise<WeeklyReportRunResult> {
      const snapshot = await metricsRepository.readAndResetWeeklyMetrics();
      await outboxRepository.enqueueAdminNotification({
        pedidoId: null,
        tipo: "reporte_semanal",
        contenido: buildReportBody(snapshot),
      });
      return { sent: true, snapshot };
    },
  };
}
