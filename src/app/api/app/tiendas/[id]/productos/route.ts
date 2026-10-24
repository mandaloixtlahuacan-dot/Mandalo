import { getAppStore, PAGE_SIZE, searchStoreProducts } from "@/lib/app/catalog";
import { appJson, catchAppError } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const tiendaId = Number(id);
    if (!Number.isInteger(tiendaId) || tiendaId <= 0) return appJson({ ok: false, mensaje: "Tienda inválida." }, 400);
    const supabase = getSupabaseAdmin();
    const tienda = await getAppStore(supabase, tiendaId);
    if (!tienda) return appJson({ ok: false, mensaje: "Esa tienda no está activa." }, 404);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const q = url.searchParams.get("q") ?? "";
    const anaquel = url.searchParams.get("anaquel");
    const result = await searchStoreProducts(supabase, tienda, { q, page: Number.isFinite(page) ? page : 1, anaquel });
    return appJson({ ok: true, tienda, pageSize: PAGE_SIZE, page: Math.max(1, page || 1), ...result });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
