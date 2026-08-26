import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import { getPedidoById, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import type { OrderState } from "@/lib/orderStateMachine";

type CourierRow = {
  id?: unknown;
  nombre?: unknown;
  telefono?: unknown;
  activo?: unknown;
};

export type CourierCommandType = "CONFIRMO" | "RECOGI" | "ENTREGADO";

export type CourierCommandParseResult =
  | {
      ok: true;
      action: "confirmed" | "picked_up" | "delivered";
      pedidoId: number;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
      tiendaId: number | null;
      tiendaNombre: string | null;
      tiendaTelefono: string | null;
    }
  | {
      ok: false;
      action: "invalid" | "ignored" | "already_taken" | "stale_state";
      courierMessage: string;
      pedidoId?: number | null;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Antes de esto, si el pedido ya no estaba en el estado que espera
// handleCourierConfirm/PickedUp/Delivered (assertAllowedState en
// stateTransitionService.ts), la excepción se propagaba sin atrapar hasta el
// try/catch del webhook, que solo evita un 500 hacia Whapi — el repartidor se
// quedaba sin ninguna respuesta en WhatsApp, ni de éxito ni de error (bug
// confirmado en auditoría agosto 2026). Esta función arma el mensaje más
// preciso posible según el estado REAL del pedido en ese momento (no el que
// tenía cuando se leyó al inicio del comando), para los casos que van más
// allá de la ventana de carrera que ya cubre el claim atómico de #CONFIRMO.
function buildStaleOrderMessage(pedidoId: number, currentEstado: OrderState | null, requestedAction: CourierCommandType): string {
  if (currentEstado === "cancelado") {
    return `⚠️ El pedido ${pedidoId} ya fue cancelado. No hace falta que hagas nada más.`;
  }
  if (currentEstado === "entregado") {
    return `⚠️ El pedido ${pedidoId} ya está marcado como entregado.`;
  }
  if (requestedAction === "CONFIRMO" && currentEstado && currentEstado !== "dispatch_repartidor_pendiente") {
    return `⚠️ El pedido ${pedidoId} ya fue tomado por otro repartidor.`;
  }
  if (requestedAction === "RECOGI" && currentEstado === "en_camino_cliente") {
    return `⚠️ El pedido ${pedidoId} ya está marcado como recogido.`;
  }
  if (currentEstado) {
    return `⚠️ El pedido ${pedidoId} ya no está en el paso esperado para ese comando (estado actual: ${currentEstado}). Si tienes dudas, contacta al administrador.`;
  }
  return `⚠️ No pude confirmar el estado actual del pedido ${pedidoId}. Contacta al administrador antes de continuar.`;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function parseStrictCourierCommand(text: string): { type: CourierCommandType; orderRef: number } | null {
  const normalized = String(text ?? "").trim().toUpperCase();
  const match = normalized.match(/^#(CONFIRMO|RECOGI|ENTREGADO)\s+(\d+)$/i);
  if (!match) return null;
  return {
    type: match[1].toUpperCase() as CourierCommandType,
    orderRef: Number(match[2]),
  };
}

async function findCourierByPhone(phone: string): Promise<{
  id: number | null;
  nombre: string;
  telefono: string;
} | null> {
  const supabase = getSupabaseAdmin();
  const phoneNorm = normalizePhone(phone);
  const phone10 = phoneNorm.length <= 10 ? phoneNorm : phoneNorm.slice(-10);
  const { data, error } = await supabase
    .from("repartidores")
    .select("id, nombre, telefono, activo")
    .limit(500);
  if (error) throw error;

  const hit = (data ?? []).find((row) => {
    const courier = row as CourierRow;
    if (courier.activo !== true) return false;
    const w = normalizePhone(String(courier.telefono ?? ""));
    const w10 = w.length <= 10 ? w : w.slice(-10);
    return w === phoneNorm || (w10 && phone10 && w10 === phone10);
  }) as CourierRow | undefined;

  if (!hit) return null;
  return {
    id: toNullableNumber(hit.id),
    nombre: cleanText(hit.nombre) ?? "Repartidor",
    telefono: normalizePhone(String(hit.telefono ?? "")),
  };
}

function validateCourierAssignment(params: {
  pedido: PedidoFullRecord;
  courier: { id: number | null; telefono: string };
}): boolean {
  const assignedCourierId =
    params.pedido.repartidorId ?? toNullableNumber(params.pedido.metadata.current_courier_id);
  const assignedCourierPhone = normalizePhone(String(params.pedido.metadata.current_courier_phone ?? ""));
  const senderPhone = normalizePhone(params.courier.telefono);

  if (assignedCourierId != null && params.courier.id != null) {
    return assignedCourierId === params.courier.id;
  }

  if (assignedCourierPhone) {
    const sender10 = senderPhone.length <= 10 ? senderPhone : senderPhone.slice(-10);
    const assigned10 = assignedCourierPhone.length <= 10 ? assignedCourierPhone : assignedCourierPhone.slice(-10);
    return senderPhone === assignedCourierPhone || sender10 === assigned10;
  }

  return true;
}

export function createCourierCommandParser() {
  const transitionService = createStateTransitionService();

  return {
    async handleIncomingCommand(params: {
      senderPhone: string;
      text: string;
    }): Promise<CourierCommandParseResult> {
      const parsed = parseStrictCourierCommand(params.text);
      if (!parsed) {
        return {
          ok: false,
          action: "invalid",
          courierMessage:
            "⚠️ Comando inválido.\n\nUsa uno de estos formatos:\n#CONFIRMO 123\n#RECOGI 123\n#ENTREGADO 123",
        };
      }

      const courier = await findCourierByPhone(params.senderPhone);
      if (!courier) {
        return {
          ok: false,
          action: "invalid",
          courierMessage:
            "⚠️ No pude validar tu número como repartidor activo. Usa tu número registrado o contacta al administrador.",
        };
      }

      const pedido = await getPedidoById(parsed.orderRef);
      if (!pedido) {
        return {
          ok: false,
          action: "invalid",
          courierMessage: `⚠️ No encontré el pedido ${parsed.orderRef}. Verifica el ID e intenta de nuevo.`,
        };
      }

      if (!validateCourierAssignment({ pedido, courier })) {
        return {
          ok: false,
          action: "invalid",
          pedidoId: pedido.id,
          courierMessage: "⚠️ Ese pedido no está asignado a tu número. Verifica el comando o contacta al administrador.",
        };
      }

      const resultBase = {
        pedidoId: pedido.id,
        courierId: courier.id,
        courierName: courier.nombre,
        courierPhone: courier.telefono,
        tiendaId: pedido.tienda?.tiendaId ?? null,
        tiendaNombre: pedido.tienda?.nombre ?? null,
        tiendaTelefono: pedido.tienda?.telefono ?? null,
      };

      // Las tres transiciones exigen un estado previo específico
      // (assertAllowedState en stateTransitionService.ts) y truenan si el
      // pedido ya no está ahí — cualquier excepción (no solo esa) se atrapa
      // aquí para que el repartidor SIEMPRE reciba algo, nunca silencio.
      if (parsed.type === "CONFIRMO") {
        try {
          const { claimed } = await transitionService.handleCourierConfirm({
            pedidoId: pedido.id,
            courierId: courier.id,
            courierName: courier.nombre,
            courierPhone: courier.telefono,
          });
          if (!claimed) {
            return {
              ok: false,
              action: "already_taken",
              pedidoId: pedido.id,
              courierMessage: `⚠️ El pedido ${pedido.id} ya fue tomado por otro repartidor.`,
            };
          }
          return { ok: true, action: "confirmed", ...resultBase };
        } catch (e: unknown) {
          console.error("[courierCommandParser] handleCourierConfirm falló", { pedidoId: pedido.id, message: errorMessage(e) });
          const fresh = await getPedidoById(pedido.id).catch(() => null);
          return {
            ok: false,
            action: "stale_state",
            pedidoId: pedido.id,
            courierMessage: buildStaleOrderMessage(pedido.id, fresh?.estado ?? null, "CONFIRMO"),
          };
        }
      }

      if (parsed.type === "RECOGI") {
        try {
          await transitionService.handleCourierPickedUp({
            pedidoId: pedido.id,
            courierId: courier.id,
            courierName: courier.nombre,
            courierPhone: courier.telefono,
          });
          return { ok: true, action: "picked_up", ...resultBase };
        } catch (e: unknown) {
          console.error("[courierCommandParser] handleCourierPickedUp falló", { pedidoId: pedido.id, message: errorMessage(e) });
          const fresh = await getPedidoById(pedido.id).catch(() => null);
          return {
            ok: false,
            action: "stale_state",
            pedidoId: pedido.id,
            courierMessage: buildStaleOrderMessage(pedido.id, fresh?.estado ?? null, "RECOGI"),
          };
        }
      }

      try {
        await transitionService.handleCourierDelivered({
          pedidoId: pedido.id,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.telefono,
        });
        return { ok: true, action: "delivered", ...resultBase };
      } catch (e: unknown) {
        console.error("[courierCommandParser] handleCourierDelivered falló", { pedidoId: pedido.id, message: errorMessage(e) });
        const fresh = await getPedidoById(pedido.id).catch(() => null);
        return {
          ok: false,
          action: "stale_state",
          pedidoId: pedido.id,
          courierMessage: buildStaleOrderMessage(pedido.id, fresh?.estado ?? null, "ENTREGADO"),
        };
      }
    },
  };
}
