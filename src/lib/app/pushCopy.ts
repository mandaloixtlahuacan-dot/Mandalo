import type { OrderState } from "@/lib/orderStateMachine";

export type AppPushNotice = {
  title: string;
  body: string;
  url: string;
  tag: string;
  highlight: boolean;
};

/**
 * Avisos de la app. El bot no guarda el estado `recogiendo`: #RECOGI
 * pasa directo a `en_camino_cliente`. Por eso ese salto manda los dos
 * avisos, y «Tu pedido va en camino» va marcado para destacarse.
 */
export function pushNoticesForState(estado: OrderState, pedidoId: number): AppPushNotice[] {
  const url = `/app/pedido/${pedidoId}`;
  if (estado === "esperando_apertura_tienda") {
    return [
      {
        title: "Recibimos tu pedido",
        body: `Pedido #${pedidoId}. Lo mandamos en cuanto se pueda repartir.`,
        url,
        tag: `pedido-${pedidoId}-recibido`,
        highlight: false,
      },
    ];
  }
  if (estado === "pendiente_tiendas") {
    return [
      {
        title: "Recibimos tu pedido",
        body: `Pedido #${pedidoId}. La tienda lo está revisando.`,
        url,
        tag: `pedido-${pedidoId}-recibido`,
        highlight: false,
      },
    ];
  }
  if (estado === "confirmado_tiendas") {
    return [
      {
        title: "La tienda ya respondió",
        body: `Pedido #${pedidoId}. La tienda confirmó o cotizó.`,
        url,
        tag: `pedido-${pedidoId}-cotizado`,
        highlight: false,
      },
    ];
  }
  if (estado === "en_camino_cliente") {
    return [
      {
        title: "Pedido recogido",
        body: `El repartidor ya recogió tu pedido #${pedidoId}.`,
        url,
        tag: `pedido-${pedidoId}-recogido`,
        highlight: false,
      },
      {
        title: "Tu pedido va en camino",
        body: `Pedido #${pedidoId} ya va hacia tu casa.`,
        url,
        tag: `pedido-${pedidoId}-en-camino`,
        highlight: true,
      },
    ];
  }
  if (estado === "entregado") {
    return [
      {
        title: "Pedido entregado",
        body: "Gracias por tu compra y por confiar en nosotros.",
        url,
        tag: `pedido-${pedidoId}-entregado`,
        highlight: false,
      },
    ];
  }
  return [];
}
