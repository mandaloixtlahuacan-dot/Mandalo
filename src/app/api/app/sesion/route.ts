import { deleteSession, loginAppUser } from "@/lib/app/auth";
import { APP_SESSION_COOKIE } from "@/lib/app/auth";
import { applySessionCookie, appJson, catchAppError, clearSessionCookie, currentAppUser, migrationJson } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    return appJson({ ok: true, usuario: user });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { telefono?: unknown; password?: unknown };
    const result = await loginAppUser(getSupabaseAdmin(), {
      telefono: String(body.telefono ?? ""),
      password: String(body.password ?? ""),
    });
    if (!result.ok) return appJson({ ok: false, code: result.code, mensaje: result.mensaje }, result.status);
    return applySessionCookie(appJson({ ok: true, usuario: result.user }), result.cookie);
  } catch (error: unknown) {
    return catchAppError(error);
  }
}

export async function DELETE() {
  try {
    const jar = await cookies();
    await deleteSession(getSupabaseAdmin(), jar.get(APP_SESSION_COOKIE)?.value);
    return clearSessionCookie(appJson({ ok: true }));
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
