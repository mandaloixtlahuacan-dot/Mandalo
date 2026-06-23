import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";

type TimedOutPedidoRow = {
  id?: unknown;
  legacy_pedido_id?: unknown;
  estado_flujo?: unknown;
  snapshot_json?: unknown;
  total_cliente?: unknown;
  repartidor_id?: unknown;
};

type CourierRow = {
  id?: unknown;
  nombre?: unknown;
  whatsapp?: unknown;
  activo?: unknown;
};

type PedidoItemRow = {
  nombre_producto?: unknown;
  marca?: unknown;
  presentacion?: unknown;
  cantidad?: unknown;
  unidad?: unknown;
  notas?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getAttemptedCourierIds(snapshot: Record<string, unknown>): number[] {
  const attempts = Array.isArray(snapshot.courier_attempts) ? snapshot.courier_attempts : [];
  return attempts
    .map((row) => toNullableNumber(asRecord(row).courierId))
    .filter((id): id is number => id != null);
}

function formatPedidoItems(items: PedidoItemRow[]): string {
  if (!items.length) return "- Sin productos definidos";
  return items
    .map((row) => {
      const parts = [
        cleanText(row.nombre_producto),
        cleanText(row.marca),
        cleanText(row.presentacion),
        toNullableNumber(row.cantidad) != null ? `x${Number(row.cantidad)}` : null,
        cleanText(row.unidad),
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

async function getTimedOutPedidos(limit: number, nowIso: string): Promise<Array<{
  id: number;
  legacyOrderId: number | null;
  snapshot: Record<string, unknown>;
  totalCliente: number | null;
}>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos_v2")
    .select("id, legacy_pedido_id, estado_flujo, snapshot_json, total_cliente, repartidor_id, courier_confirmation_deadline_at")
    .eq("estado_flujo", "pendiente_confirmacion_repartidor")
    .lte("courier_confirmation_deadline_at", nowIso)
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as TimedOutPedidoRow[]).map((row) => ({
    id: Number(row.id),
    legacyOrderId: toNullableNumber(row.legacy_pedido_id),
    snapshot: asRecord(row.snapshot_json),
    totalCliente: toNullableNumber(row.total_cliente),
  }));
}

async function findNextCourier(excludedIds: number[]): Promise<{
  id: number;
  nombre: string;
  whatsapp: string;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("repartidores")
    .select("id, nombre, whatsapp, activo")
    .eq("activo", true)
    .order("id", { ascending: true })
    .limit(100);

  if (error) throw error;
  const excluded = new Set(excludedIds);
  const hit = ((data ?? []) as CourierRow[]).find((row) => {
    const id = toNullableNumber(row.id);
    return id != null && !excluded.has(id) && cleanText(row.whatsapp);
  });

  if (!hit) return null;
  return {
    id: Number(hit.id),
    nombre: cleanText(hit.nombre) ?? "Repartidor",
    whatsapp: normalizePhone(String(hit.whatsapp ?? "")),
  };
}

async function getPedidoItems(pedidoId: number): Promise<PedidoItemRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedido_items")
    .select("nombre_producto, marca, presentacion, cantidad, unidad, notas")
    .eq("pedido_id", pedidoId)
    .order("id", { ascending: true });

  if (error) throw error;
  return (data ?? []) as PedidoItemRow[];
}

function buildCourierDispatchMessage(params: {
  pedidoId: number;
  legacyOrderId: number | null;
  snapshot: Record<string, unknown>;
  totalCliente: number | null;
  courierName: string;
  itemsText: string;
}): string {
  const negocioNombre = cleanText(params.snapshot.businessName ?? params.snapshot.business_name) ?? "la tienda";
  const customerName = cleanText(params.snapshot.customerName ?? params.snapshot.customer_name) ?? "(sin nombre)";
  const addressText = cleanText(params.snapshot.addressText ?? params.snapshot.address_text) ?? "(sin dirección)";
  const customerPhone = cleanText(params.snapshot.customerPhone ?? params.snapshot.customer_phone) ?? "(sin teléfono)";
  const mapsLink = addressText
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`
    : "";
  const orderRef = params.legacyOrderId ?? params.pedidoId;

  return (
    `Hola ${params.courierName}, tienes un nuevo pedido de ${negocioNombre}.\n\n` +
    `Cliente: ${customerName}\n` +
    `Dirección: ${addressText}\n` +
    `${params.totalCliente != null ? `Total: $${params.totalCliente}\n` : ""}` +
    `Tel cliente: ${customerPhone}\n` +
    `${mapsLink ? `Mapa: ${mapsLink}\n` : ""}` +
    `\nProductos:\n${params.itemsText}\n\n` +
    `Responde con: #CONFIRMO ${orderRef}\n` +
    `Luego usa: #RECOGI ${orderRef} y #ENTREGADO ${orderRef}`
  );
}

export type CourierTimeoutWorkerRunResult = {
  scanned: number;
  timedOut: number;
  reassigned: number;
  failed: number;
};

export function createCourierTimeoutWorker() {
  const transitionService = createStateTransitionService();

  return {
    async run(params?: { limit?: number }): Promise<CourierTimeoutWorkerRunResult> {
      const limit = params?.limit ?? 20;
      const nowIso = new Date().toISOString();
      const timedOutPedidos = await getTimedOutPedidos(limit, nowIso);

      const summary: CourierTimeoutWorkerRunResult = {
        scanned: timedOutPedidos.length,
        timedOut: 0,
        reassigned: 0,
        failed: 0,
      };

      for (const pedido of timedOutPedidos) {
        summary.timedOut += 1;
        await transitionService.handleCourierTimeout({
          pedidoId: pedido.id,
          errorMessage: "No se recibió #CONFIRMO dentro de 5 minutos",
        });

        const snapshot = pedido.snapshot;
        const currentAttempt = toNullableNumber(snapshot.courier_assignment_attempt) ?? 1;
        const nextAttempt = currentAttempt + 1;
        if (nextAttempt > 3) {
          await transitionService.handleCourierReassignmentFailed({
            pedidoId: pedido.id,
            errorMessage: "Se agotaron los intentos automáticos de reasignación.",
          });
          summary.failed += 1;
          continue;
        }

        const excludedIds = getAttemptedCourierIds(snapshot);
        const nextCourier = await findNextCourier(excludedIds);
        if (!nextCourier) {
          await transitionService.handleCourierReassignmentFailed({
            pedidoId: pedido.id,
            errorMessage: "No hay repartidores activos disponibles para reasignación.",
          });
          summary.failed += 1;
          continue;
        }

        const items = await getPedidoItems(pedido.id);
        const body = buildCourierDispatchMessage({
          pedidoId: pedido.id,
          legacyOrderId: pedido.legacyOrderId,
          snapshot,
          totalCliente: pedido.totalCliente,
          courierName: nextCourier.nombre,
          itemsText: formatPedidoItems(items),
        });

        await outboxRepository.enqueueOutboundMessage({
          pedidoId: pedido.id,
          tipoMensaje: "dispatch_repartidor",
          destinatarioTipo: "repartidor",
          destinatarioId: nextCourier.id,
          telefonoDestino: nextCourier.whatsapp,
          payload: {
            body,
            legacyOrderId: pedido.legacyOrderId,
            courierId: nextCourier.id,
            courierName: nextCourier.nombre,
            courierPhone: nextCourier.whatsapp,
            attemptNumber: nextAttempt,
          },
          idempotencyKey: `pedido:${pedido.id}:dispatch_repartidor:attempt:${nextAttempt}`,
        });

        await transitionService.handleCourierReassignmentQueued({
          pedidoId: pedido.id,
          courierId: nextCourier.id,
          courierName: nextCourier.nombre,
          courierPhone: nextCourier.whatsapp,
          attemptNumber: nextAttempt,
        });
        summary.reassigned += 1;
      }

      return summary;
    },
  };
}

