import type { OrderState } from "@/lib/orderStateMachine";

export type TrackingStep = {
  id: string;
  titulo: string;
  detalle: string;
  hecho: boolean;
  actual: boolean;
  destacado: boolean;
};

const FLOW: Array<{ id: string; estados: OrderState[]; titulo: string; detalle: string; destacado?: boolean }> = [
  {
    id: "recibido",
    estados: ["confirmacion_cliente", "esperando_apertura_tienda", "pendiente_tiendas", "ajuste_producto"],
    titulo: "Pedido recibido",
    detalle: "Ya lo tenemos. Si la tienda está cerrada, sale en cuanto se pueda.",
  },
  {
    id: "tienda",
    estados: ["confirmado_tiendas"],
    titulo: "La tienda confirmó",
    detalle: "Ya cotizó o confirmó el pedido.",
  },
  {
    id: "repartidor",
    estados: ["dispatch_repartidor_pendiente", "repartidor_asignado"],
    titulo: "Repartidor",
    detalle: "Estamos consiguiendo quién te lo lleve.",
  },
  {
    id: "camino",
    estados: ["recogiendo", "en_camino_cliente"],
    titulo: "Tu pedido va en camino",
    detalle: "El repartidor ya lo recogió y va hacia tu casa.",
    destacado: true,
  },
  {
    id: "entregado",
    estados: ["entregado"],
    titulo: "Entregado",
    detalle: "Gracias por tu compra y por confiar en nosotros.",
  },
];

export function trackingSteps(estado: OrderState): TrackingStep[] {
  if (estado === "cancelado") {
    return [
      {
        id: "cancelado",
        titulo: "Pedido cancelado",
        detalle: "Este pedido ya no sigue. Si quieres, arma otro.",
        hecho: true,
        actual: true,
        destacado: false,
      },
    ];
  }
  const index = Math.max(
    0,
    FLOW.findIndex((step) => step.estados.includes(estado)),
  );
  return FLOW.map((step, stepIndex) => ({
    id: step.id,
    titulo: step.titulo,
    detalle: step.detalle,
    hecho: stepIndex < index,
    actual: stepIndex === index,
    destacado: step.destacado === true && stepIndex === index,
  }));
}

export function trackingHeadline(estado: OrderState, tiendaNombre: string): string {
  if (estado === "en_camino_cliente" || estado === "recogiendo") return "Tu pedido va en camino";
  if (estado === "entregado") return "Ya se entregó";
  if (estado === "cancelado") return "Se canceló";
  if (estado === "confirmado_tiendas") return `${tiendaNombre} ya respondió`;
  if (estado === "esperando_apertura_tienda") return "Quedó programado";
  if (estado === "pendiente_tiendas" || estado === "ajuste_producto") return "La tienda lo está viendo";
  if (estado === "dispatch_repartidor_pendiente" || estado === "repartidor_asignado") return "Buscando repartidor";
  return "Recibimos tu pedido";
}
