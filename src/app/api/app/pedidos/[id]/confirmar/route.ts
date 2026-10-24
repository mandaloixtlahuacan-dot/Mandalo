import { confirmQuotedTotal } from "@/lib/app/confirmTotal";
import { AppNoCourierError, productionConfirmPorts, productionGetPedido } from "@/lib/app/production";
import { appJson, catchAppError, currentAppUser, migrationJson } from "@/lib/app/routeKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    if (!user) return appJson({ ok: false, mensaje: "Entra para confirmar." }, 401);
    const { id } = await context.params;
    const pedidoId = Number(id);
    const result = await confirmQuotedTotal(
      { pedidoId, telefono: user.telefono },
      { getPedido: productionGetPedido, offer: productionConfirmPorts },
    );
    if (!result.ok) return appJson(result, result.status);
    return appJson(result);
  } catch (error: unknown) {
    if (error instanceof AppNoCourierError) {
      return appJson({
        ok: true,
        mensaje: "Ahorita no hay repartidor en horario. El pedido se canceló y no se te cobra. Te escribimos por WhatsApp.",
      });
    }
    return catchAppError(error);
  }
}
