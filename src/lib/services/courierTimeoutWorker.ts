import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import * as outboxRepository from "@/lib/repositories/outboxRepository";
import { getPedidoById } from "@/lib/repositories/pedidoRepositoryV2";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import { buildMapsLinkFromCoords } from "@/lib/services/geo";

type CourierRow = {
  id?: unknown;
  nombre?: unknown;
  telefono?: unknown;
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

function getAttemptedCourierIds(metadata: Record<string, unknown>): number[] {
  const attempts = Array.isArray(metadata.courier_attempts) ? metadata.courier_attempts : [];
  return attempts
    .map((row) => toNullableNumber(asRecord(row).courierId))
    .filter((id): id is number => id != null);
}

// Escaneo de deadlines vencidos: el deadline vive en metadata_json (no es un
// campo del spec de la Sección 4, ver CLAUDE.md), así que se filtra por el
// path jsonb — PostgREST lo soporta vía `->>`. A la escala de este proyecto
// (un pueblo, no miles de pedidos concurrentes) no hace falta un índice extra.
async function getTimedOutPedidoIds(params: { limit: number; nowIso: string; pedidoId?: number }): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("pedidos_new")
    .select("id")
    .eq("estado", "dispatch_repartidor_pendiente")
    .lte("metadata_json->>courier_confirmation_deadline_at", params.nowIso)
    .limit(params.limit);

  if (params.pedidoId != null) {
    query = query.eq("id", params.pedidoId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => Number((row as { id: unknown }).id));
}

async function findNextCourier(excludedIds: number[]): Promise<{ id: number; nombre: string; telefono: string } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("repartidores_new")
    .select("id, nombre, telefono, activo, disponible")
    .eq("activo", true)
    .eq("disponible", true)
    .order("id", { ascending: true })
    .limit(100);

  if (error) throw error;
  const excluded = new Set(excludedIds);
  const hit = ((data ?? []) as CourierRow[]).find((row) => {
    const id = toNullableNumber(row.id);
    return id != null && !excluded.has(id) && cleanText(row.telefono);
  });

  if (!hit) return null;
  return {
    id: Number(hit.id),
    nombre: cleanText(hit.nombre) ?? "Repartidor",
    telefono: normalizePhone(String(hit.telefono ?? "")),
  };
}

function formatPedidoItems(items: Array<{ nombreProducto: string; cantidad: number | null }>): string {
  if (!items.length) return "- Sin productos definidos";
  return items
    .map((item) => `- ${item.nombreProducto}${item.cantidad != null ? ` x${item.cantidad}` : ""}`)
    .join("\n");
}

function buildCourierDispatchMessage(params: {
  pedidoId: number;
  customerPhone: string;
  addressText: string | null;
  latitud: number | null;
  longitud: number | null;
  totalCliente: number | null;
  courierName: string;
  itemsText: string;
}): string {
  const mapsLink =
    params.latitud != null && params.longitud != null
      ? buildMapsLinkFromCoords({ latitude: params.latitud, longitude: params.longitud })
      : null;

  return (
    `Hola ${params.courierName}, tienes un nuevo pedido.\n\n` +
    `Dirección: ${params.addressText ?? "(sin dirección)"}\n` +
    `${params.totalCliente != null ? `Total: $${params.totalCliente}\n` : ""}` +
    `Tel cliente: ${params.customerPhone}\n` +
    `${mapsLink ? `Mapa: ${mapsLink}\n` : ""}` +
    `\nProductos:\n${params.itemsText}\n\n` +
    `Responde con: #CONFIRMO ${params.pedidoId}\n` +
    `Luego usa: #RECOGI ${params.pedidoId} y #ENTREGADO ${params.pedidoId}`
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
    async run(params?: { limit?: number; pedidoId?: number }): Promise<CourierTimeoutWorkerRunResult> {
      const limit = params?.limit ?? 20;
      const nowIso = new Date().toISOString();
      const timedOutIds = await getTimedOutPedidoIds({ limit, nowIso, pedidoId: params?.pedidoId });

      const summary: CourierTimeoutWorkerRunResult = {
        scanned: timedOutIds.length,
        timedOut: 0,
        reassigned: 0,
        failed: 0,
      };

      for (const pedidoId of timedOutIds) {
        summary.timedOut += 1;
        await transitionService.handleCourierTimeout({
          pedidoId,
          errorMessage: "No se recibió #CONFIRMO dentro de 5 minutos",
        });

        const pedido = await getPedidoById(pedidoId);
        if (!pedido) {
          summary.failed += 1;
          continue;
        }

        const currentAttempt = toNullableNumber(pedido.metadata.courier_assignment_attempt) ?? 1;
        const nextAttempt = currentAttempt + 1;
        if (nextAttempt > 3) {
          await transitionService.handleCourierReassignmentFailed({
            pedidoId,
            errorMessage: "Se agotaron los intentos automáticos de reasignación.",
          });
          summary.failed += 1;
          continue;
        }

        const excludedIds = getAttemptedCourierIds(pedido.metadata);
        const nextCourier = await findNextCourier(excludedIds);
        if (!nextCourier) {
          await transitionService.handleCourierReassignmentFailed({
            pedidoId,
            errorMessage: "No hay repartidores activos disponibles para reasignación.",
          });
          summary.failed += 1;
          continue;
        }

        const body = buildCourierDispatchMessage({
          pedidoId,
          customerPhone: pedido.clienteTelefono,
          addressText: pedido.direccionEntrega,
          latitud: pedido.latitud,
          longitud: pedido.longitud,
          totalCliente: pedido.totalCliente,
          courierName: nextCourier.nombre,
          itemsText: formatPedidoItems(pedido.items),
        });

        await outboxRepository.enqueueOutboundMessage({
          pedidoId,
          tipoMensaje: "dispatch_repartidor",
          destinatarioTipo: "repartidor",
          destinatarioId: nextCourier.id,
          telefonoDestino: nextCourier.telefono,
          payload: {
            body,
            courierId: nextCourier.id,
            courierName: nextCourier.nombre,
            courierPhone: nextCourier.telefono,
            attemptNumber: nextAttempt,
          },
          idempotencyKey: `pedido:${pedidoId}:dispatch_repartidor:attempt:${nextAttempt}`,
        });

        await transitionService.handleCourierReassignmentQueued({
          pedidoId,
          courierId: nextCourier.id,
          courierName: nextCourier.nombre,
          courierPhone: nextCourier.telefono,
          attemptNumber: nextAttempt,
        });
        summary.reassigned += 1;
      }

      return summary;
    },
  };
}
