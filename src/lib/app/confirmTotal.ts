import type { PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import { samePhone } from "@/lib/app/phone";

export type ConfirmTotalResult =
  | { ok: true; mensaje: string }
  | { ok: false; status: number; code: string; mensaje: string };

/**
 * El SÍ del precio final, el mismo corte del bot: solo abarrotes en
 * `confirmado_tiendas`. La tienda y el repartidor siguen por WhatsApp.
 */
export async function confirmQuotedTotal(
  params: { pedidoId: number; telefono: string },
  ports: {
    getPedido(pedidoId: number): Promise<PedidoFullRecord | null>;
    offer(pedido: PedidoFullRecord): Promise<void>;
  },
): Promise<ConfirmTotalResult> {
  const pedido = await ports.getPedido(params.pedidoId);
  if (!pedido || !samePhone(pedido.clienteTelefono, params.telefono)) {
    return { ok: false, status: 404, code: "NO_ENCONTRADO", mensaje: "No encontré ese pedido en tu cuenta." };
  }
  if (pedido.tienda?.usaCatalogoFijo) {
    return { ok: false, status: 409, code: "MENU_FIJO", mensaje: "Este pedido lo confirma la tienda. No hace falta otro sí." };
  }
  if (pedido.estado !== "confirmado_tiendas") {
    return { ok: false, status: 409, code: "ESTADO", mensaje: "Este pedido todavía no está esperando tu sí al total." };
  }
  if (!pedido.items.length) {
    return { ok: false, status: 409, code: "VACIO", mensaje: "El pedido no tiene productos." };
  }
  await ports.offer(pedido);
  return { ok: true, mensaje: "Listo. Ya estamos buscando repartidor. Te escribimos por WhatsApp." };
}
