import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

// Contadores agregados para el reporte semanal al admin (brief sección 5).
// Deliberadamente NO guarda nada de un pedido individual (ni cliente, ni
// tienda, ni productos) — solo suma un número. Ver
// supabase/migrations/20260812_metricas_semanales.sql para el porqué de esta
// tabla frente a la regla de retención de CLAUDE.md Sección 4.

export type MetricKey = "pedidos_entregados" | "pedidos_cancelados" | "ingresos_entregados";

// Best-effort a propósito: un fallo al incrementar una métrica nunca debe
// tumbar el cierre real de un pedido (entrega/cancelación). El llamador ya
// envuelve esto en su propio try/catch de logging.
export async function incrementMetric(clave: MetricKey, delta: number = 1): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.rpc("increment_metrica", { p_clave: clave, p_delta: delta });
  if (error) throw error;
}

export type WeeklyMetricsSnapshot = Record<string, number>;

// Lee y resetea a 0 en la misma llamada (RPC atómico, ver migración) — así
// el siguiente periodo no arrastra nada del anterior.
export async function readAndResetWeeklyMetrics(): Promise<WeeklyMetricsSnapshot> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("read_and_reset_metricas");
  if (error) throw error;

  const snapshot: WeeklyMetricsSnapshot = {};
  for (const row of (data ?? []) as Array<{ clave: string; valor: number }>) {
    snapshot[row.clave] = Number(row.valor ?? 0);
  }
  return snapshot;
}
