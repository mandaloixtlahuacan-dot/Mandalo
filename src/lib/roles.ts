import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type ActorRole = "cliente" | "tienda" | "repartidor";

export type ActorIdentity =
  | { role: "cliente"; telefono: string }
  | { role: "tienda"; telefono: string; negocioId: number }
  | { role: "repartidor"; telefono: string; repartidorId: number };

export function normalizePhone(raw: string) {
  // El proveedor/WhatsApp puede mandar formatos como "521234...@c.us" o con "+".
  return String(raw ?? "").replace(/[^\d]/g, "");
}

function last10Digits(raw: string) {
  const n = normalizePhone(raw);
  return n.length <= 10 ? n : n.slice(-10);
}

type ActorPhoneRow = {
  id?: unknown;
  whatsapp?: unknown;
};

type ActorsCache = {
  at: number;
  negocios: ActorPhoneRow[];
  repartidores: ActorPhoneRow[];
};

let cache: ActorsCache | null = null;

async function getActorsCache(): Promise<ActorsCache> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache; // 60s

  const supabase = getSupabaseAdmin();
  const [{ data: negocios, error: e1 }, { data: repartidores, error: e2 }] =
    await Promise.all([
      supabase.from("negocios").select("id, whatsapp").limit(1000),
      supabase.from("repartidores").select("id, whatsapp").limit(1000),
    ]);
  if (e1) throw e1;
  if (e2) throw e2;

  cache = {
    at: now,
    negocios: (negocios ?? []) as ActorPhoneRow[],
    repartidores: (repartidores ?? []) as ActorPhoneRow[],
  };
  return cache;
}

/**
 * Regla:
 * - Si el número está en `negocios.whatsapp` => TIENDA
 * - Si está en `repartidores.whatsapp` => REPARTIDOR
 * - En otro caso => CLIENTE
 */
export async function detectActorByPhone(telefono: string): Promise<ActorIdentity> {
  const tel = normalizePhone(telefono);
  if (!tel) return { role: "cliente", telefono: String(telefono ?? "") };

  // En producción es común que los teléfonos tengan formatos distintos entre el proveedor y tu DB.
  // Para evitar falsos negativos, traemos la lista y comparamos normalizando a solo dígitos.
  // Regla flexible adicional: si coinciden los ÚLTIMOS 10 dígitos, cuenta como match.
  const actors = await getActorsCache();
  const tel10 = last10Digits(tel);

  const negocio = actors.negocios.find(
    (n) => {
      const db = normalizePhone(String(n.whatsapp ?? ""));
      return db === tel || last10Digits(db) === tel10;
    },
  );
  if (negocio?.id) return { role: "tienda", telefono: tel, negocioId: Number(negocio.id) };

  const repartidor = actors.repartidores.find(
    (r) => {
      const db = normalizePhone(String(r.whatsapp ?? ""));
      return db === tel || last10Digits(db) === tel10;
    },
  );
  if (repartidor?.id)
    return { role: "repartidor", telefono: tel, repartidorId: Number(repartidor.id) };

  return { role: "cliente", telefono: tel };
}
