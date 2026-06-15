import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

type GenericSupabaseClient = SupabaseClient;

let client: GenericSupabaseClient | null = null;

export function getSupabaseAdmin(): GenericSupabaseClient {
  if (client) return client;
  const env = getEnv();
  // Nota: sin tipos generados (Database), mantenemos el cliente genérico
  // y hacemos narrowing local al consumir resultados.
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
