import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type ActorRole = "cliente" | "tienda" | "repartidor";

export type ActorIdentity =
  | { role: "cliente"; telefono: string }
  | { role: "tienda"; telefono: string; tiendaId: number }
  | { role: "repartidor"; telefono: string; repartidorId: number };

export function normalizePhone(raw: string) {
  // El proveedor/WhatsApp puede mandar formatos como "521234...@c.us" o con "+".
  return String(raw ?? "").replace(/[^\d]/g, "");
}

// WhatsApp México suele usar 52 + 10 dígitos (a veces 521 + 10) — WAAPI
// necesita ese prefijo internacional en el `to` de cada envío saliente.
export function ensureMxWhatsappIntl(raw: string) {
  const d = normalizePhone(String(raw ?? ""));
  if (d.length === 10) return `52${d}`;
  if (d.length === 12 && d.startsWith("52")) return d;
  if (d.length === 13 && d.startsWith("521")) return d;
  return d;
}

function last10Digits(raw: string) {
  const n = normalizePhone(raw);
  return n.length <= 10 ? n : n.slice(-10);
}

type ActorPhoneRow = {
  id?: unknown;
  telefono?: unknown;
};

type ActorsCache = {
  at: number;
  tiendas: ActorPhoneRow[];
  repartidores: ActorPhoneRow[];
};

let cache: ActorsCache | null = null;

async function getActorsCache(): Promise<ActorsCache> {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache; // 60s

  const supabase = getSupabaseAdmin();
  const [{ data: tiendas, error: e1 }, { data: repartidores, error: e2 }] =
    await Promise.all([
      supabase.from("tiendas").select("id, telefono").limit(1000),
      supabase.from("repartidores").select("id, telefono").limit(1000),
    ]);
  if (e1) throw e1;
  if (e2) throw e2;

  cache = {
    at: now,
    tiendas: (tiendas ?? []) as ActorPhoneRow[],
    repartidores: (repartidores ?? []) as ActorPhoneRow[],
  };
  return cache;
}

/**
 * Regla:
 * - Si el número está en `tiendas.telefono` => TIENDA
 * - Si está en `repartidores.telefono` => REPARTIDOR
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

  const tienda = actors.tiendas.find(
    (n) => {
      const db = normalizePhone(String(n.telefono ?? ""));
      return db === tel || last10Digits(db) === tel10;
    },
  );
  if (tienda?.id) return { role: "tienda", telefono: tel, tiendaId: Number(tienda.id) };

  const repartidor = actors.repartidores.find(
    (r) => {
      const db = normalizePhone(String(r.telefono ?? ""));
      return db === tel || last10Digits(db) === tel10;
    },
  );
  if (repartidor?.id)
    return { role: "repartidor", telefono: tel, repartidorId: Number(repartidor.id) };

  return { role: "cliente", telefono: tel };
}
