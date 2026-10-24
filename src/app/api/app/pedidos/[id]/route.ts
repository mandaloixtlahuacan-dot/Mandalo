import { readAppOrder } from "@/lib/app/readOrder";
import { appJson, catchAppError, currentAppUser, migrationJson } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    if (!user) return appJson({ ok: false, mensaje: "Entra para ver el pedido." }, 401);
    const { id } = await context.params;
    const pedidoId = Number(id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) return appJson({ ok: false, mensaje: "Pedido inválido." }, 400);
    const pedido = await readAppOrder(getSupabaseAdmin(), pedidoId, user.telefono);
    if (!pedido) {
      return appJson(
        {
          ok: false,
          code: "CERRADO",
          mensaje: "Este pedido ya no está en la lista. Si se entregó o se canceló, el sistema lo cierra y no guarda el historial.",
        },
        404,
      );
    }
    return appJson({ ok: true, pedido });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
