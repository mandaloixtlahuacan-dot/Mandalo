import { decideCoverage, coverageRuleNote } from "@/lib/app/coverage";
import { appJson, catchAppError } from "@/lib/app/routeKit";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { latitude?: unknown; longitude?: unknown; referencia?: unknown };
    const latitude = finite(body.latitude);
    const longitude = finite(body.longitude);
    const zonesResult = await getSupabaseAdmin().from("zonas_cobertura").select("nombre").eq("activa", true).limit(500);
    const zones = zonesResult.error
      ? null
      : ((zonesResult.data ?? []) as Array<{ nombre?: unknown }>).map((row) => String(row.nombre ?? "")).filter(Boolean);
    const decision = decideCoverage({
      latitude,
      longitude,
      referencia: body.referencia == null ? null : String(body.referencia),
      zones,
    });
    return appJson({ ok: decision.ok, decision, nota: coverageRuleNote() }, decision.ok ? 200 : 400);
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
