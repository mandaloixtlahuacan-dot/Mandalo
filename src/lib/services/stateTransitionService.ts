import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { appendPedidoEvento } from "@/lib/repositories/pedidoRepositoryV2";
import { enqueueAdminNotification } from "@/lib/dualWrite";
import type { EstadoFlujoPedido } from "@/lib/services/captureEngine";
import type { OutboxMessageType } from "@/lib/services/dispatchWorker";

type PedidoStateRow = {
  id: number;
  legacy_pedido_id: number | null;
  estado_flujo: EstadoFlujoPedido;
  snapshot_json: Record<string, unknown> | null;
  total_cliente: number | null;
  negocio_id: number | null;
  repartidor_id: number | null;
};

type CourierAttempt = {
  attemptNumber: number;
  courierId: number | null;
  courierName: string | null;
  courierPhone: string | null;
  assignedAt: string | null;
  deadlineAt: string | null;
  status: "pending" | "confirmed" | "timed_out" | "picked_up" | "delivered";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function getCourierAttempts(snapshot: Record<string, unknown> | null): CourierAttempt[] {
  const attempts = Array.isArray(snapshot?.courier_attempts) ? snapshot.courier_attempts : [];
  return attempts
    .map((row, index) => {
      const item = asRecord(row);
      return {
        attemptNumber: toNullableNumber(item.attemptNumber) ?? index + 1,
        courierId: toNullableNumber(item.courierId),
        courierName: cleanText(item.courierName),
        courierPhone: cleanText(item.courierPhone),
        assignedAt: cleanText(item.assignedAt),
        deadlineAt: cleanText(item.deadlineAt),
        status:
          (cleanText(item.status) as CourierAttempt["status"] | null) ??
          "pending",
      };
    })
    .filter((row) => row.attemptNumber > 0);
}

function upsertCourierAttempt(
  attempts: CourierAttempt[],
  patch: Partial<CourierAttempt> & { attemptNumber: number },
): CourierAttempt[] {
  const next = [...attempts];
  const index = next.findIndex((item) => item.attemptNumber === patch.attemptNumber);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...patch,
    };
  } else {
    next.push({
      attemptNumber: patch.attemptNumber,
      courierId: patch.courierId ?? null,
      courierName: patch.courierName ?? null,
      courierPhone: patch.courierPhone ?? null,
      assignedAt: patch.assignedAt ?? null,
      deadlineAt: patch.deadlineAt ?? null,
      status: patch.status ?? "pending",
    });
  }
  return next.sort((a, b) => a.attemptNumber - b.attemptNumber);
}

async function getPedidoState(pedidoId: number): Promise<PedidoStateRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos_v2")
    .select("id, legacy_pedido_id, estado_flujo, snapshot_json, total_cliente, negocio_id, repartidor_id")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`Pedido v2 no encontrado: ${pedidoId}`);

  return {
    id: Number(data.id),
    legacy_pedido_id: data.legacy_pedido_id == null ? null : Number(data.legacy_pedido_id),
    estado_flujo: String(data.estado_flujo ?? "capturando_pedido") as EstadoFlujoPedido,
    snapshot_json: asRecord(data.snapshot_json),
    total_cliente: data.total_cliente == null ? null : Number(data.total_cliente),
    negocio_id: data.negocio_id == null ? null : Number(data.negocio_id),
    repartidor_id: data.repartidor_id == null ? null : Number(data.repartidor_id),
  };
}

async function updatePedidoState(params: {
  pedidoId: number;
  estadoFlujo: EstadoFlujoPedido;
  snapshotPatch?: Record<string, unknown>;
  extraUpdates?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const current = await getPedidoState(params.pedidoId);
  const snapshot = {
    ...current.snapshot_json,
    ...(params.snapshotPatch ?? {}),
  };

  const { error } = await supabase
    .from("pedidos_v2")
    .update({
      estado_flujo: params.estadoFlujo,
      snapshot_json: snapshot,
      updated_at: new Date().toISOString(),
      ...(params.extraUpdates ?? {}),
    })
    .eq("id", params.pedidoId);

  if (error) throw error;
}

async function emitTransitionEvent(params: {
  pedidoId: number;
  estadoOrigen: EstadoFlujoPedido | null;
  estadoDestino: EstadoFlujoPedido | null;
  tipoEvento: string;
  payload?: Record<string, unknown>;
  actorTipo?: "cliente" | "sistema" | "negocio" | "repartidor" | "admin";
}): Promise<void> {
  await appendPedidoEvento({
    pedidoId: params.pedidoId,
    tipoEvento: params.tipoEvento,
    estadoOrigen: params.estadoOrigen,
    estadoDestino: params.estadoDestino,
    actorTipo: params.actorTipo ?? "sistema",
    payload: params.payload,
  });
}

async function notifyAdmin(params: {
  pedidoId: number;
  contenido: string;
}): Promise<void> {
  await enqueueAdminNotification({
    pedidoV2Id: params.pedidoId,
    tipo: "venta_entregada",
    contenido: params.contenido,
  });
}

function assertAllowedState(current: EstadoFlujoPedido, allowed: EstadoFlujoPedido[], action: string) {
  if (!allowed.includes(current)) {
    throw new Error(`Transición inválida para ${action}. Estado actual: ${current}`);
  }
}

async function notifyAdminOnDispatchFailure(params: {
  pedidoId: number;
  messageType: OutboxMessageType;
  errorMessage?: string | null;
}): Promise<void> {
  const label = params.messageType === "cotizacion_tienda" ? "tienda" : "repartidor";
  await notifyAdmin({
    pedidoId: params.pedidoId,
    contenido:
      `Alerta operativa\n\n` +
      `Pedido: ${params.pedidoId}\n` +
      `Fallo de dispatch a ${label}\n` +
      `${params.errorMessage ? `Error: ${params.errorMessage}` : ""}`,
  });
}

export function createStateTransitionService() {
  return {
    async handleDispatchAck(params: {
      pedidoId: number;
      messageType: OutboxMessageType;
      messageId: number;
      providerMessageId?: string | null;
      providerStatus?: string | null;
      payload?: Record<string, unknown>;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      const nowIso = new Date().toISOString();

      if (params.messageType === "cotizacion_tienda") {
        await updatePedidoState({
          pedidoId: params.pedidoId,
          estadoFlujo: "pendiente_respuesta_tienda",
          snapshotPatch: {
            store_dispatch_sent_at: nowIso,
            store_dispatch_message_id: params.providerMessageId ?? null,
            store_dispatch_provider_status: params.providerStatus ?? null,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado_flujo,
          estadoDestino: "pendiente_respuesta_tienda",
          tipoEvento: "dispatch_tienda_ack",
          payload: {
            messageId: params.messageId,
            providerMessageId: params.providerMessageId ?? null,
            providerStatus: params.providerStatus ?? null,
            ...(params.payload ?? {}),
          },
        });
        return;
      }

      if (params.messageType === "dispatch_repartidor") {
        const deadlineIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const snapshot = current.snapshot_json ?? {};
        const attemptNumber =
          toNullableNumber(params.payload?.attemptNumber) ??
          (toNullableNumber(snapshot.courier_assignment_attempt) ?? 0) + 1;
        const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
          attemptNumber,
          courierId: toNullableNumber(params.payload?.courierId),
          courierName: cleanText(params.payload?.courierName),
          courierPhone: cleanText(params.payload?.courierPhone),
          assignedAt: nowIso,
          deadlineAt: deadlineIso,
          status: "pending",
        });

        await updatePedidoState({
          pedidoId: params.pedidoId,
          estadoFlujo: "pendiente_confirmacion_repartidor",
          snapshotPatch: {
            courier_assigned_at: nowIso,
            courier_confirmation_deadline_at: deadlineIso,
            courier_dispatch_message_id: params.providerMessageId ?? null,
            courier_dispatch_provider_status: params.providerStatus ?? null,
            courier_assignment_attempt: attemptNumber,
            current_courier_id: toNullableNumber(params.payload?.courierId),
            current_courier_name: cleanText(params.payload?.courierName),
            current_courier_phone: cleanText(params.payload?.courierPhone),
            courier_attempts: attempts,
          },
          extraUpdates: {
            repartidor_id: toNullableNumber(params.payload?.courierId),
            courier_assigned_at: nowIso,
            courier_confirmation_deadline_at: deadlineIso,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado_flujo,
          estadoDestino: "pendiente_confirmacion_repartidor",
          tipoEvento: "dispatch_repartidor_ack",
          payload: {
            messageId: params.messageId,
            providerMessageId: params.providerMessageId ?? null,
            providerStatus: params.providerStatus ?? null,
            courier_confirmation_deadline_at: deadlineIso,
            attemptNumber,
            ...(params.payload ?? {}),
          },
        });
        return;
      }

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: current.estado_flujo,
        tipoEvento: "dispatch_ack",
        payload: {
          messageId: params.messageId,
          providerMessageId: params.providerMessageId ?? null,
          providerStatus: params.providerStatus ?? null,
          messageType: params.messageType,
        },
      });
    },

    async handleDispatchFailure(params: {
      pedidoId: number;
      messageType: OutboxMessageType;
      messageId: number;
      finalFailure: boolean;
      errorMessage?: string | null;
      payload?: Record<string, unknown>;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);

      if (params.finalFailure) {
        await updatePedidoState({
          pedidoId: params.pedidoId,
          estadoFlujo: "incidencia_dispatch",
          snapshotPatch: {
            last_dispatch_failure_at: new Date().toISOString(),
            last_dispatch_failure_reason: params.errorMessage ?? null,
            last_dispatch_failure_type: params.messageType,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado_flujo,
          estadoDestino: "incidencia_dispatch",
          tipoEvento: "dispatch_failed_final",
          payload: {
            messageId: params.messageId,
            errorMessage: params.errorMessage ?? null,
            messageType: params.messageType,
            ...(params.payload ?? {}),
          },
        });

        try {
          await notifyAdminOnDispatchFailure({
            pedidoId: params.pedidoId,
            messageType: params.messageType,
            errorMessage: params.errorMessage ?? null,
          });
        } catch (e: unknown) {
          console.error("[stateTransitionService] no se pudo notificar al admin", {
            pedidoId: params.pedidoId,
            message: errorMessage(e),
          });
        }
        return;
      }

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: current.estado_flujo,
        tipoEvento: "dispatch_retry_scheduled",
        payload: {
          messageId: params.messageId,
          errorMessage: params.errorMessage ?? null,
          messageType: params.messageType,
          ...(params.payload ?? {}),
        },
      });
    },

    async handleCourierConfirm(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado_flujo, ["pendiente_confirmacion_repartidor"], "confirmación de repartidor");

      const snapshot = current.snapshot_json ?? {};
      const attemptNumber = toNullableNumber(snapshot.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "confirmed",
      });
      const confirmedAt = new Date().toISOString();

      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "repartidor_asignado",
        snapshotPatch: {
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          courier_confirmed_at: confirmedAt,
          courier_attempts: attempts,
        },
        extraUpdates: {
          repartidor_id: params.courierId,
          courier_confirmation_deadline_at: null,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "repartidor_asignado",
        tipoEvento: "courier_confirmed",
        payload: {
          courierId: params.courierId,
          courierName: params.courierName,
          courierPhone: params.courierPhone,
          confirmedAt,
        },
        actorTipo: "repartidor",
      });
    },

    async handleCourierPickedUp(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado_flujo, ["repartidor_asignado"], "recogida");

      const snapshot = current.snapshot_json ?? {};
      const attemptNumber = toNullableNumber(snapshot.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "picked_up",
      });
      const pickedUpAt = new Date().toISOString();

      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "pedido_recogido",
        snapshotPatch: {
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          picked_up_at: pickedUpAt,
          courier_attempts: attempts,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "pedido_recogido",
        tipoEvento: "courier_picked_up",
        payload: {
          courierId: params.courierId,
          courierName: params.courierName,
          courierPhone: params.courierPhone,
          pickedUpAt,
        },
        actorTipo: "repartidor",
      });
    },

    async handleCourierDelivered(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado_flujo, ["pedido_recogido", "en_camino"], "entrega");

      const snapshot = current.snapshot_json ?? {};
      const attemptNumber = toNullableNumber(snapshot.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "delivered",
      });
      const deliveredAt = new Date().toISOString();

      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "entregado",
        snapshotPatch: {
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          delivered_at: deliveredAt,
          courier_attempts: attempts,
        },
        extraUpdates: {
          delivered_at: deliveredAt,
          closed_at: deliveredAt,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "entregado",
        tipoEvento: "courier_delivered",
        payload: {
          courierId: params.courierId,
          courierName: params.courierName,
          courierPhone: params.courierPhone,
          deliveredAt,
        },
        actorTipo: "repartidor",
      });

      try {
        await notifyAdmin({
          pedidoId: params.pedidoId,
          contenido:
            `Pedido entregado\n\n` +
            `Cliente: ${cleanText(snapshot.customerName) ?? "Cliente"}\n` +
            `Total: $${current.total_cliente ?? 0}\n` +
            `Hora: ${deliveredAt}\n` +
            `Repartidor: ${params.courierName}`,
        });
      } catch (e: unknown) {
        console.error("[stateTransitionService] no se pudo notificar cierre al admin", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }
    },

    async handleCourierTimeout(params: {
      pedidoId: number;
      errorMessage?: string | null;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado_flujo, ["pendiente_confirmacion_repartidor"], "timeout de repartidor");

      const snapshot = current.snapshot_json ?? {};
      const attemptNumber = toNullableNumber(snapshot.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
        attemptNumber,
        status: "timed_out",
      });
      const timeoutAt = new Date().toISOString();

      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "reasignacion_pendiente",
        snapshotPatch: {
          courier_attempts: attempts,
          last_courier_timeout_at: timeoutAt,
          last_courier_timeout_reason: params.errorMessage ?? "No se recibió #CONFIRMO dentro del deadline",
        },
        extraUpdates: {
          courier_confirmation_deadline_at: null,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "reasignacion_pendiente",
        tipoEvento: "courier_confirmation_timeout",
        payload: {
          timeoutAt,
          attemptNumber,
          errorMessage: params.errorMessage ?? null,
        },
      });

      try {
        await notifyAdmin({
          pedidoId: params.pedidoId,
          contenido:
            `Alerta: Repartidor inactivo.\n\n` +
            `Pedido: ${params.pedidoId}\n` +
            `Intento: ${attemptNumber}\n` +
            `${params.errorMessage ? `Detalle: ${params.errorMessage}` : "No llegó #CONFIRMO en el tiempo esperado."}`,
        });
      } catch (e: unknown) {
        console.error("[stateTransitionService] no se pudo notificar timeout al admin", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }
    },

    async handleCourierReassignmentQueued(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
      attemptNumber: number;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado_flujo, ["reasignacion_pendiente"], "reasignación de repartidor");

      const snapshot = current.snapshot_json ?? {};
      const attempts = upsertCourierAttempt(getCourierAttempts(snapshot), {
        attemptNumber: params.attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        assignedAt: new Date().toISOString(),
        status: "pending",
      });

      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "dispatch_repartidor_pendiente",
        snapshotPatch: {
          courier_assignment_attempt: params.attemptNumber,
          courier_reassignment_count: Math.max(0, params.attemptNumber - 1),
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          courier_attempts: attempts,
        },
        extraUpdates: {
          repartidor_id: params.courierId,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "dispatch_repartidor_pendiente",
        tipoEvento: "courier_reassigned",
        payload: {
          courierId: params.courierId,
          courierName: params.courierName,
          courierPhone: params.courierPhone,
          attemptNumber: params.attemptNumber,
        },
      });
    },

    async handleCourierReassignmentFailed(params: {
      pedidoId: number;
      errorMessage?: string | null;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      await updatePedidoState({
        pedidoId: params.pedidoId,
        estadoFlujo: "incidencia_repartidor",
        snapshotPatch: {
          last_courier_failure_at: new Date().toISOString(),
          last_courier_failure_reason: params.errorMessage ?? "No hay repartidores disponibles para reasignación",
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado_flujo,
        estadoDestino: "incidencia_repartidor",
        tipoEvento: "courier_reassignment_failed",
        payload: {
          errorMessage: params.errorMessage ?? null,
        },
      });

      try {
        await notifyAdmin({
          pedidoId: params.pedidoId,
          contenido:
            `Incidencia de repartidor\n\n` +
            `Pedido: ${params.pedidoId}\n` +
            `${params.errorMessage ?? "No fue posible reasignar un repartidor."}`,
        });
      } catch (e: unknown) {
        console.error("[stateTransitionService] no se pudo notificar falla de reasignación al admin", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }
    },
  };
}
