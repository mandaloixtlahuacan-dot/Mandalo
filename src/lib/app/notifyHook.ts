import type { OrderState } from "@/lib/orderStateMachine";

/**
 * Aviso push después de un cambio de estado. Nunca tumba al bot:
 * si la tabla no existe, si faltan llaves o si el envío falla, se anota
 * y el flujo de WhatsApp sigue igual.
 */
export async function scheduleAppPush(params: {
  pedidoId: number;
  estado: OrderState;
  previousEstado: string | null;
}): Promise<void> {
  if (!params.previousEstado || params.previousEstado === params.estado) return;
  try {
    const mod = await import("@/lib/app/orderPush");
    await mod.notifyAppPushForOrderState({
      pedidoId: params.pedidoId,
      estado: params.estado,
      previousEstado: params.previousEstado,
    });
  } catch (error: unknown) {
    console.error("[app-push] no se pudo avisar", error instanceof Error ? error.message : error);
  }
}
