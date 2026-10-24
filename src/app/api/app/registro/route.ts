import { registerAppUser } from "@/lib/app/auth";
import { applySessionCookie, appJson, catchAppError } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { nombre?: unknown; telefono?: unknown; password?: unknown };
    const result = await registerAppUser(getSupabaseAdmin(), {
      nombre: String(body.nombre ?? ""),
      telefono: String(body.telefono ?? ""),
      password: String(body.password ?? ""),
    });
    if (!result.ok) return appJson({ ok: false, code: result.code, mensaje: result.mensaje }, result.status);
    return applySessionCookie(appJson({ ok: true, usuario: result.user }), result.cookie);
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
