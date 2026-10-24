import { readOpenAppOrderId } from "@/lib/app/readOrder";
import { placeAppOrder } from "@/lib/app/placeOrder";
import { productionPlacePorts } from "@/lib/app/production";
import { appJson, catchAppError, currentAppUser, migrationJson } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    if (!user) return appJson({ ok: false, mensaje: "Entra para ver tu pedido." }, 401);
    const pedidoId = await readOpenAppOrderId(getSupabaseAdmin(), user.telefono);
    return appJson({ ok: true, pedidoId });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    if (!user) return appJson({ ok: false, mensaje: "Entra o regístrate para confirmar." }, 401);
    const body = (await request.json()) as {
      tiendaId?: unknown;
      lines?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      referencia?: unknown;
    };
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const result = await placeAppOrder(
      {
        telefono: user.telefono,
        nombre: user.nombre,
        tiendaId: Number(body.tiendaId),
        lines: lines.map((line) => {
          const row = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
          return {
            productoId: Number(row.productoId),
            cantidad: Number(row.cantidad),
            extras: Array.isArray(row.extras) ? row.extras.map((item) => String(item)) : [],
            nota: String(row.nota ?? ""),
            salsa: String(row.salsa ?? ""),
          };
        }),
        latitude: finite(body.latitude),
        longitude: finite(body.longitude),
        referencia: body.referencia == null ? null : String(body.referencia),
      },
      productionPlacePorts(),
    );
    if (!result.ok) return appJson(result, result.status);
    return appJson(result);
  } catch (error: unknown) {
    return catchAppError(error);
  }
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
