import { isMissingRelation, MIGRACION_MENSAJE, MIGRACION_PENDIENTE } from "@/lib/app/dbError";
import { appJson, catchAppError, currentAppUser, migrationJson } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null;
  return appJson({
    ok: true,
    vapidPublicKey: publicKey,
    listo: Boolean(publicKey && process.env.VAPID_PRIVATE_KEY?.trim() && process.env.VAPID_SUBJECT?.trim()),
  });
}

export async function POST(request: Request) {
  try {
    const user = await currentAppUser();
    if (user === "missing") return migrationJson();
    if (!user) return appJson({ ok: false, mensaje: "Entra para activar los avisos." }, 401);
    const body = (await request.json()) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = String(body.endpoint ?? "").trim();
    const p256dh = String(body.keys?.p256dh ?? "").trim();
    const auth = String(body.keys?.auth ?? "").trim();
    if (!endpoint || !p256dh || !auth) return appJson({ ok: false, mensaje: "La suscripción llegó incompleta." }, 400);
    const saved = await getSupabaseAdmin().from("push_subscriptions").upsert(
      { usuario_id: user.id, endpoint, p256dh, auth },
      { onConflict: "endpoint" },
    );
    if (saved.error) {
      if (isMissingRelation(saved.error)) {
        return appJson({ ok: false, code: MIGRACION_PENDIENTE, mensaje: MIGRACION_MENSAJE }, 503);
      }
      return appJson({ ok: false, mensaje: "No pude guardar el aviso en este teléfono." }, 500);
    }
    return appJson({ ok: true });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await currentAppUser();
    if (!user || user === "missing") return appJson({ ok: true });
    const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = String(body.endpoint ?? "").trim();
    if (!endpoint) return appJson({ ok: true });
    await getSupabaseAdmin().from("push_subscriptions").delete().eq("endpoint", endpoint).eq("usuario_id", user.id);
    return appJson({ ok: true });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
