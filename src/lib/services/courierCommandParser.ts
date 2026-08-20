import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";
import { getPedidoById, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";

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
      action: "invalid" | "ignored" | "already_taken";
      courierMessage: string;
      pedidoId?: number | null;
    };

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

      if (parsed.type === "CONFIRMO") {
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
      }

      if (parsed.type === "RECOGI") {
        await transitionService.handleCourierPickedUp({
          pedidoId: pedido.id,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.telefono,
        });
        return { ok: true, action: "picked_up", ...resultBase };
      }

      await transitionService.handleCourierDelivered({
        pedidoId: pedido.id,
        courierId: courier.id,
        courierName: courier.nombre,
        courierPhone: courier.telefono,
      });
      return { ok: true, action: "delivered", ...resultBase };
    },
  };
}
