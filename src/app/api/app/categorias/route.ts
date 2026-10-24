import { listAppCategories } from "@/lib/app/catalog";
import { appJson, catchAppError } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const categorias = await listAppCategories(getSupabaseAdmin());
    return appJson({ ok: true, categorias });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
