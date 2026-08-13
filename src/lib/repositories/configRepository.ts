import { getSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getEnv } from "@/lib/env";
import { normalizePhone } from "@/lib/roles";

// Config operativa mínima en BD (tabla `configuracion`, clave/valor) — hoy
// solo se usa para el teléfono de admin (brief sección 4 paso 9: "configurar
// en base de datos si no está"), para poder cambiarlo sin redeploy de Vercel.
// Cache corto en memoria: incidental, es el mismo patrón que roles.ts usa
// para el cache de tiendas/repartidores.
const CACHE_TTL_MS = 60_000;
let cache: { value: string | null; at: number } | null = null;

export async function getConfigValue(clave: string): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("configuracion").select("valor").eq("clave", clave).maybeSingle();

  // Tabla ausente (migración todavía no corrida) u otro error: no tumbar el
  // flujo por esto, el llamador cae de vuelta a la variable de entorno.
  if (error) {
    console.warn("[configRepository] no se pudo leer configuracion", { clave, message: error.message });
    return null;
  }

  const value = data?.valor ? String(data.valor).trim() || null : null;
  cache = { value, at: Date.now() };
  return value;
}

// DB primero (editable por Víctor sin redeploy), variable de entorno como
// respaldo (compatibilidad con lo que ya había antes de esta tabla).
export async function getAdminPhone(): Promise<string | null> {
  const fromDb = await getConfigValue("admin_telefono");
  const raw = fromDb || getEnv().MANDALO_ADMIN_PHONE || "";
  const normalized = normalizePhone(String(raw));
  return normalized || null;
}
