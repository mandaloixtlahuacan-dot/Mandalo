import { whatsappTo } from "@/lib/app/phone";
import type { PlacePorts } from "@/lib/app/placeOrder";
import { enqueueOutboundMessage } from "@/lib/repositories/outboxRepository";
import { getPedidoById, type PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import { cancelBecauseNoCourier, findAvailableCouriers, offerOrderToCouriers } from "@/lib/services/courierHandoff";
import { dispatchCotizacionToStore } from "@/lib/services/storeDispatch";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export class AppNoCourierError extends Error {
  constructor() {
    super("SIN_REPARTIDOR");
    this.name = "AppNoCourierError";
  }
}

async function enqueueCustomer(pedidoId: number, telefono: string, body: string, key: string): Promise<void> {
  await enqueueOutboundMessage({
    pedidoId,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    destinatarioId: null,
    telefonoDestino: whatsappTo(telefono),
    payload: { body },
    idempotencyKey: key,
  });
}

export function productionPlacePorts(): PlacePorts {
  return {
    supabase: getSupabaseAdmin(),
    enqueue: enqueueOutboundMessage,
    dispatch: dispatchCotizacionToStore,
    findCouriers: () => findAvailableCouriers(),
    cancelNoCourier: async (pedido) => {
      await cancelBecauseNoCourier({
        pedido,
        customerPhone: pedido.clienteTelefono,
        notifyStore: false,
        deliverCustomer: (body) => enqueueCustomer(pedido.id, pedido.clienteTelefono, body, `pedido:${pedido.id}:app:sin-repartidor:v1`),
      });
    },
  };
}

export async function productionConfirmPorts(pedido: PedidoFullRecord): Promise<void> {
  const couriers = await findAvailableCouriers();
  if (!couriers.length) {
    await cancelBecauseNoCourier({
      pedido,
      customerPhone: pedido.clienteTelefono,
      notifyStore: Boolean(pedido.tienda?.telefono),
      deliverCustomer: (body) => enqueueCustomer(pedido.id, pedido.clienteTelefono, body, `pedido:${pedido.id}:app:sin-repartidor:v1`),
    });
    throw new AppNoCourierError();
  }
  await offerOrderToCouriers({
    pedido,
    customerPhone: pedido.clienteTelefono,
    couriers,
    actorTipo: "cliente",
    deliverCustomer: (body) => enqueueCustomer(pedido.id, pedido.clienteTelefono, body, `pedido:${pedido.id}:app:total-confirmado:v1`),
  });
}

export async function productionGetPedido(pedidoId: number): Promise<PedidoFullRecord | null> {
  return getPedidoById(pedidoId);
}
