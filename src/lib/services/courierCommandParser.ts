import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizePhone } from "@/lib/roles";
import { createStateTransitionService } from "@/lib/services/stateTransitionService";

type CourierRow = {
  id?: unknown;
  nombre?: unknown;
  whatsapp?: unknown;
  activo?: unknown;
};

type PedidoCourierRow = {
  id?: unknown;
  legacy_pedido_id?: unknown;
  estado_flujo?: unknown;
  repartidor_id?: unknown;
  snapshot_json?: unknown;
};

export type CourierCommandType = "CONFIRMO" | "RECOGI" | "ENTREGADO";

export type CourierCommandParseResult =
  | {
      ok: true;
      action: "confirmed" | "picked_up" | "delivered";
      pedidoId: number;
      legacyOrderId: number | null;
      courierId: number | null;
      courierName: string;
      courierPhone: string;
      businessId: number | null;
      businessName: string | null;
      businessPhone: string | null;
    }
  | {
      ok: false;
      action: "invalid" | "ignored";
      courierMessage: string;
      pedidoId?: number | null;
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
  whatsapp: string;
} | null> {
  const supabase = getSupabaseAdmin();
  const phoneNorm = normalizePhone(phone);
  const phone10 = phoneNorm.length <= 10 ? phoneNorm : phoneNorm.slice(-10);
  const { data, error } = await supabase.from("repartidores").select("id, nombre, whatsapp, activo").limit(500);
  if (error) throw error;

  const hit = (data ?? []).find((row) => {
    const courier = row as CourierRow;
    if (courier.activo !== true) return false;
    const w = normalizePhone(String(courier.whatsapp ?? ""));
    const w10 = w.length <= 10 ? w : w.slice(-10);
    return w === phoneNorm || (w10 && phone10 && w10 === phone10);
  }) as CourierRow | undefined;

  if (!hit) return null;
  return {
    id: toNullableNumber(hit.id),
    nombre: cleanText(hit.nombre) ?? "Repartidor",
    whatsapp: normalizePhone(String(hit.whatsapp ?? "")),
  };
}

async function findPedidoForCourierCommand(orderRef: number): Promise<{
  id: number;
  legacyOrderId: number | null;
  estadoFlujo: string;
  repartidorId: number | null;
  snapshot: Record<string, unknown>;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("pedidos_v2")
    .select("id, legacy_pedido_id, estado_flujo, repartidor_id, snapshot_json")
    .or(`id.eq.${orderRef},legacy_pedido_id.eq.${orderRef}`)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as PedidoCourierRow;
  return {
    id: Number(row.id),
    legacyOrderId: toNullableNumber(row.legacy_pedido_id),
    estadoFlujo: String(row.estado_flujo ?? ""),
    repartidorId: toNullableNumber(row.repartidor_id),
    snapshot: asRecord(row.snapshot_json),
  };
}

function validateCourierAssignment(params: {
  pedido: {
    repartidorId: number | null;
    snapshot: Record<string, unknown>;
  };
  courier: {
    id: number | null;
    whatsapp: string;
  };
}): boolean {
  const assignedCourierId = toNullableNumber(
    params.pedido.snapshot.current_courier_id ?? params.pedido.repartidorId,
  );
  const assignedCourierPhone = normalizePhone(String(params.pedido.snapshot.current_courier_phone ?? ""));
  const senderPhone = normalizePhone(params.courier.whatsapp);

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

      const pedido = await findPedidoForCourierCommand(parsed.orderRef);
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

      if (parsed.type === "CONFIRMO") {
        await transitionService.handleCourierConfirm({
          pedidoId: pedido.id,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.whatsapp,
        });
        return {
          ok: true,
          action: "confirmed",
          pedidoId: pedido.id,
          legacyOrderId: pedido.legacyOrderId,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.whatsapp,
          businessId: toNullableNumber(pedido.snapshot.businessId ?? pedido.snapshot.business_id),
          businessName: cleanText(pedido.snapshot.businessName ?? pedido.snapshot.business_name),
          businessPhone: cleanText(pedido.snapshot.businessPhone ?? pedido.snapshot.business_phone),
        };
      }

      if (parsed.type === "RECOGI") {
        await transitionService.handleCourierPickedUp({
          pedidoId: pedido.id,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.whatsapp,
        });
        return {
          ok: true,
          action: "picked_up",
          pedidoId: pedido.id,
          legacyOrderId: pedido.legacyOrderId,
          courierId: courier.id,
          courierName: courier.nombre,
          courierPhone: courier.whatsapp,
          businessId: toNullableNumber(pedido.snapshot.businessId ?? pedido.snapshot.business_id),
          businessName: cleanText(pedido.snapshot.businessName ?? pedido.snapshot.business_name),
          businessPhone: cleanText(pedido.snapshot.businessPhone ?? pedido.snapshot.business_phone),
        };
      }

      await transitionService.handleCourierDelivered({
        pedidoId: pedido.id,
        courierId: courier.id,
        courierName: courier.nombre,
        courierPhone: courier.whatsapp,
      });
      return {
        ok: true,
        action: "delivered",
        pedidoId: pedido.id,
        legacyOrderId: pedido.legacyOrderId,
        courierId: courier.id,
        courierName: courier.nombre,
        courierPhone: courier.whatsapp,
        businessId: toNullableNumber(pedido.snapshot.businessId ?? pedido.snapshot.business_id),
        businessName: cleanText(pedido.snapshot.businessName ?? pedido.snapshot.business_name),
        businessPhone: cleanText(pedido.snapshot.businessPhone ?? pedido.snapshot.business_phone),
      };
    },
  };
}

