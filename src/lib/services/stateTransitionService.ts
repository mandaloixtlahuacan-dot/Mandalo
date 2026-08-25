import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { appendPedidoEvento, finalizePedidoRetention } from "@/lib/repositories/pedidoRepositoryV2";
import { incrementMetric } from "@/lib/repositories/metricsRepository";
import { enqueueAdminNotification } from "@/lib/repositories/outboxRepository";
import { canTransition, type OrderState } from "@/lib/orderStateMachine";
import { buildOrderTimeoutMetadata } from "@/lib/services/orderTimeouts";
import type { OutboxMessageType } from "@/lib/services/dispatchWorker";

// Ciclo de vida del repartidor sobre pedidos. Antes vivía en pedidos_v2 con
// un vocabulario de estados propio (EstadoFlujoPedido: pendiente_confirmacion_repartidor,
// reasignacion_pendiente, incidencia_repartidor, ...) que no correspondía 1:1 con
// los 11 estados canónicos de la Sección 7. Se consolidó: el estado de alto nivel
// siempre es uno de los 11 canónicos; el detalle fino de "en qué intento vamos,
// cuál es el deadline, si el último intento venció" vive en metadata_json.

type PedidoStateRow = {
  id: number;
  estado: OrderState;
  metadata_json: Record<string, unknown>;
  total_cliente: number | null;
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

function getCourierAttempts(metadata: Record<string, unknown>): CourierAttempt[] {
  const attempts = Array.isArray(metadata.courier_attempts) ? metadata.courier_attempts : [];
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
        status: (cleanText(item.status) as CourierAttempt["status"] | null) ?? "pending",
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
    next[index] = { ...next[index], ...patch };
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
    .from("pedidos")
    .select("id, estado, metadata_json, total_cliente, repartidor_id")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`Pedido no encontrado: ${pedidoId}`);

  return {
    id: Number(data.id),
    estado: String(data.estado ?? "seleccion_productos") as OrderState,
    metadata_json: asRecord(data.metadata_json),
    total_cliente: data.total_cliente == null ? null : Number(data.total_cliente),
    repartidor_id: data.repartidor_id == null ? null : Number(data.repartidor_id),
  };
}

async function writePedidoState(params: {
  pedidoId: number;
  estado: OrderState;
  metadataPatch?: Record<string, unknown>;
  extraUpdates?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const current = await getPedidoState(params.pedidoId);
  const metadata = { ...current.metadata_json, ...(params.metadataPatch ?? {}) };

  const { error } = await supabase
    .from("pedidos")
    .update({
      estado: params.estado,
      metadata_json: metadata,
      updated_at: new Date().toISOString(),
      ...(params.extraUpdates ?? {}),
    })
    .eq("id", params.pedidoId);

  if (error) throw error;
}

// Valida y persiste una transición de estado de alto nivel usando el mismo
// grafo canónico que el resto del flujo (orderStateMachine.ts). Los guards de
// negocio (items/dirección/total/etc.) no aplican aquí porque para este tramo
// del flujo (confirmado_tiendas en adelante) ya se validaron antes.
async function transitionPedidoState(params: {
  pedidoId: number;
  from: OrderState;
  to: OrderState;
  metadataPatch?: Record<string, unknown>;
  extraUpdates?: Record<string, unknown>;
}): Promise<void> {
  if (!canTransition(params.from, params.to)) {
    throw new Error(`Transición ilegal: ${params.from} -> ${params.to}`);
  }
  await writePedidoState({
    pedidoId: params.pedidoId,
    estado: params.to,
    metadataPatch: params.metadataPatch,
    extraUpdates: params.extraUpdates,
  });
}

async function emitTransitionEvent(params: {
  pedidoId: number;
  estadoOrigen: OrderState | null;
  estadoDestino: OrderState | null;
  tipoEvento: string;
  payload?: Record<string, unknown>;
  actorTipo?: "cliente" | "bot" | "tienda" | "repartidor" | "sistema";
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

async function notifyAdmin(params: { pedidoId: number; contenido: string }): Promise<void> {
  await enqueueAdminNotification({
    pedidoId: params.pedidoId,
    tipo: "alerta_operativa",
    contenido: params.contenido,
  });
}

function assertAllowedState(current: OrderState, allowed: OrderState[], action: string) {
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
        await writePedidoState({
          pedidoId: params.pedidoId,
          estado: current.estado,
          metadataPatch: {
            store_dispatch_sent_at: nowIso,
            store_dispatch_message_id: params.providerMessageId ?? null,
            store_dispatch_provider_status: params.providerStatus ?? null,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado,
          estadoDestino: current.estado,
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
        assertAllowedState(current.estado, ["dispatch_repartidor_pendiente"], "envío a repartidor");
        const timeoutMetadata = buildOrderTimeoutMetadata("courier_confirmation", nowIso);
        const deadlineIso = String(timeoutMetadata.courier_confirmation_deadline_at);
        const attemptNumber =
          toNullableNumber(params.payload?.attemptNumber) ??
          (toNullableNumber(current.metadata_json.courier_assignment_attempt) ?? 0) + 1;
        const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
          attemptNumber,
          courierId: toNullableNumber(params.payload?.courierId),
          courierName: cleanText(params.payload?.courierName),
          courierPhone: cleanText(params.payload?.courierPhone),
          assignedAt: nowIso,
          deadlineAt: deadlineIso,
          status: "pending",
        });

        await writePedidoState({
          pedidoId: params.pedidoId,
          estado: current.estado,
          metadataPatch: {
            ...timeoutMetadata,
            courier_assigned_at: nowIso,
            courier_dispatch_message_id: params.providerMessageId ?? null,
            courier_dispatch_provider_status: params.providerStatus ?? null,
            courier_assignment_attempt: attemptNumber,
            current_courier_id: toNullableNumber(params.payload?.courierId),
            current_courier_name: cleanText(params.payload?.courierName),
            current_courier_phone: cleanText(params.payload?.courierPhone),
            courier_attempts: attempts,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado,
          estadoDestino: current.estado,
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
        estadoOrigen: current.estado,
        estadoDestino: current.estado,
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
        await writePedidoState({
          pedidoId: params.pedidoId,
          estado: current.estado,
          metadataPatch: {
            last_dispatch_failure_at: new Date().toISOString(),
            last_dispatch_failure_reason: params.errorMessage ?? null,
            last_dispatch_failure_type: params.messageType,
          },
        });

        await emitTransitionEvent({
          pedidoId: params.pedidoId,
          estadoOrigen: current.estado,
          estadoDestino: current.estado,
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
        estadoOrigen: current.estado,
        estadoDestino: current.estado,
        tipoEvento: "dispatch_retry_scheduled",
        payload: {
          messageId: params.messageId,
          errorMessage: params.errorMessage ?? null,
          messageType: params.messageType,
          ...(params.payload ?? {}),
        },
      });
    },

    // Claim atómico (CLAUDE.md Sección 8, nota técnica): el UPDATE solo aplica
    // si el pedido SIGUE en dispatch_repartidor_pendiente en el instante exacto
    // de la escritura (`.eq("estado", ...)` como guarda condicional a nivel de
    // base de datos, no un read-then-write en JS). Si dos repartidores mandan
    // #CONFIRMO casi al mismo tiempo, solo el primero cuyo UPDATE llega a
    // Postgres se queda con el pedido — el segundo recibe claimed:false y el
    // llamador (courierCommandParser.ts) le avisa "ya fue tomado".
    async handleCourierConfirm(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
    }): Promise<{ claimed: boolean }> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado, ["dispatch_repartidor_pendiente"], "confirmación de repartidor");

      const attemptNumber = toNullableNumber(current.metadata_json.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "confirmed",
      });
      const confirmedAt = new Date().toISOString();

      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from("pedidos")
        .update({
          estado: "repartidor_asignado",
          repartidor_id: params.courierId,
          metadata_json: {
            ...current.metadata_json,
            current_courier_id: params.courierId,
            current_courier_name: params.courierName,
            current_courier_phone: params.courierPhone,
            courier_confirmed_at: confirmedAt,
            courier_confirmation_deadline_at: null,
            courier_attempts: attempts,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.pedidoId)
        .eq("estado", "dispatch_repartidor_pendiente")
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (!data) return { claimed: false };

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: "repartidor_asignado",
        tipoEvento: "courier_confirmed",
        payload: { courierId: params.courierId, courierName: params.courierName, courierPhone: params.courierPhone, confirmedAt },
        actorTipo: "repartidor",
      });

      return { claimed: true };
    },

    // #RECOGI: para el alcance actual (una sola tienda por pedido), recoger es
    // instantáneo — no hay razón operativa para dejar el pedido "parado" en
    // recogiendo, así que se valida el paso pero se persiste directo en
    // en_camino_cliente. Cuando exista soporte multi-tienda real, esto debe
    // quedarse en recogiendo hasta que TODAS las tiendas estén recogidas.
    async handleCourierPickedUp(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado, ["repartidor_asignado"], "recogida");
      if (!canTransition("repartidor_asignado", "recogiendo") || !canTransition("recogiendo", "en_camino_cliente")) {
        throw new Error("Ruta de transición repartidor_asignado -> recogiendo -> en_camino_cliente inválida.");
      }

      const attemptNumber = toNullableNumber(current.metadata_json.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "picked_up",
      });
      const pickedUpAt = new Date().toISOString();

      await writePedidoState({
        pedidoId: params.pedidoId,
        estado: "en_camino_cliente",
        metadataPatch: {
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          picked_up_at: pickedUpAt,
          courier_attempts: attempts,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: "en_camino_cliente",
        tipoEvento: "courier_picked_up",
        payload: { courierId: params.courierId, courierName: params.courierName, courierPhone: params.courierPhone, pickedUpAt },
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
      assertAllowedState(current.estado, ["en_camino_cliente"], "entrega");

      const attemptNumber = toNullableNumber(current.metadata_json.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
        attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        status: "delivered",
      });
      const deliveredAt = new Date().toISOString();

      await transitionPedidoState({
        pedidoId: params.pedidoId,
        from: current.estado,
        to: "entregado",
        metadataPatch: {
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          delivered_at: deliveredAt,
          courier_attempts: attempts,
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: "entregado",
        tipoEvento: "courier_delivered",
        payload: { courierId: params.courierId, courierName: params.courierName, courierPhone: params.courierPhone, deliveredAt },
        actorTipo: "repartidor",
      });

      // Nota: la regla de retención (borrar el pedido al llegar a entregado)
      // se implementa aparte, en la Fase 4 — todavía no aquí.

      try {
        await notifyAdmin({
          pedidoId: params.pedidoId,
          contenido:
            `Pedido entregado\n\n` +
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

    async handleCourierTimeout(params: { pedidoId: number; errorMessage?: string | null }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado, ["dispatch_repartidor_pendiente"], "timeout de repartidor");

      const attemptNumber = toNullableNumber(current.metadata_json.courier_assignment_attempt) ?? 1;
      const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
        attemptNumber,
        status: "timed_out",
      });
      const timeoutAt = new Date().toISOString();

      await writePedidoState({
        pedidoId: params.pedidoId,
        estado: current.estado,
        metadataPatch: {
          courier_attempts: attempts,
          courier_confirmation_deadline_at: null,
          last_courier_timeout_at: timeoutAt,
          last_courier_timeout_reason: params.errorMessage ?? "No se recibió #CONFIRMO dentro del deadline",
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: current.estado,
        tipoEvento: "courier_confirmation_timeout",
        payload: { timeoutAt, attemptNumber, errorMessage: params.errorMessage ?? null },
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

    // Cancelación por vencimiento de cualquiera de los tres timeouts unificados
    // de 10 min (Sección 3 del brief): tienda sin cotizar, cliente sin
    // confirmar precio final, o repartidor sin aceptar. orderTimeoutWorker.ts
    // es el único llamador de esos tres — decide QUÉ pedidos vencieron y a
    // quién avisar (cliente/tienda), este método solo mueve el estado y
    // notifica al admin. También reusado por scheduledDispatchWorker.ts para
    // el límite de 48h de "tienda nunca abrió" (mismo mecanismo, plazo
    // distinto) — genérico a propósito, no hace falta un método aparte.
    async handleOrderTimeoutExpired(params: {
      pedidoId: number;
      fromState: OrderState;
      reasonCode:
        | "store_quote_timeout"
        | "final_confirmation_timeout"
        | "courier_confirmation_timeout"
        | "store_never_opened";
      adminMessage: string;
      customerPhone: string;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado, [params.fromState], `timeout: ${params.reasonCode}`);

      await transitionPedidoState({
        pedidoId: params.pedidoId,
        from: current.estado,
        to: "cancelado",
        metadataPatch: {
          cancelled_reason: params.reasonCode,
          cancelled_at: new Date().toISOString(),
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: "cancelado",
        tipoEvento: "timeout_cancelado",
        payload: { reasonCode: params.reasonCode },
      });

      try {
        await notifyAdmin({ pedidoId: params.pedidoId, contenido: params.adminMessage });
      } catch (e: unknown) {
        console.error("[stateTransitionService] no se pudo notificar timeout al admin", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }

      // Reporte semanal (brief sección 5): contador agregado, no guarda nada
      // del pedido en sí.
      try {
        await incrementMetric("pedidos_cancelados");
      } catch (e: unknown) {
        console.error("[stateTransitionService] incrementMetric falló (pedidos_cancelados)", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }

      // Retención (CLAUDE.md Sección 4): va al final — orderTimeoutWorker.ts
      // ya encoló cualquier aviso a cliente/tienda antes de llamar aquí.
      try {
        await finalizePedidoRetention({ pedidoId: params.pedidoId, customerPhone: params.customerPhone });
      } catch (e: unknown) {
        console.error("[stateTransitionService] finalizePedidoRetention falló tras timeout", {
          pedidoId: params.pedidoId,
          message: errorMessage(e),
        });
      }
    },

    // Reservado para el futuro comando explícito de "cambio de repartidor"
    // (CLAUDE.md Sección 14, nombre exacto pendiente de definir) — un
    // repartidor que ya aceptó y no puede completar a medio pedido. No lo usa
    // el timeout automático de aceptación inicial (ver handleOrderTimeoutExpired
    // arriba), que ahora cancela directo en vez de reintentar con otro repartidor.
    async handleCourierReassignmentQueued(params: {
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
      attemptNumber: number;
    }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      assertAllowedState(current.estado, ["dispatch_repartidor_pendiente"], "reasignación de repartidor");

      const attempts = upsertCourierAttempt(getCourierAttempts(current.metadata_json), {
        attemptNumber: params.attemptNumber,
        courierId: params.courierId,
        courierName: params.courierName,
        courierPhone: params.courierPhone,
        assignedAt: new Date().toISOString(),
        status: "pending",
      });

      await writePedidoState({
        pedidoId: params.pedidoId,
        estado: current.estado,
        metadataPatch: {
          courier_assignment_attempt: params.attemptNumber,
          courier_reassignment_count: Math.max(0, params.attemptNumber - 1),
          current_courier_id: params.courierId,
          current_courier_name: params.courierName,
          current_courier_phone: params.courierPhone,
          courier_attempts: attempts,
        },
        extraUpdates: { repartidor_id: params.courierId },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: current.estado,
        tipoEvento: "courier_reassigned",
        payload: {
          courierId: params.courierId,
          courierName: params.courierName,
          courierPhone: params.courierPhone,
          attemptNumber: params.attemptNumber,
        },
      });
    },

    async handleCourierReassignmentFailed(params: { pedidoId: number; errorMessage?: string | null }): Promise<void> {
      const current = await getPedidoState(params.pedidoId);
      await writePedidoState({
        pedidoId: params.pedidoId,
        estado: current.estado,
        metadataPatch: {
          last_courier_failure_at: new Date().toISOString(),
          last_courier_failure_reason: params.errorMessage ?? "No hay repartidores disponibles para reasignación",
        },
      });

      await emitTransitionEvent({
        pedidoId: params.pedidoId,
        estadoOrigen: current.estado,
        estadoDestino: current.estado,
        tipoEvento: "courier_reassignment_failed",
        payload: { errorMessage: params.errorMessage ?? null },
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
