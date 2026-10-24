import { PROPOSED_CABECERA_BBOX } from "@/lib/services/geo";

/**
 * Mapa de la app.
 *
 * Por defecto OpenStreetMap + Nominatim. No hace falta API key.
 * `PROPOSED_CABECERA_BBOX` sigue apagado para aceptar o rechazar pedidos.
 * Aquí solo acota la búsqueda de calles a la cabecera de Ixtlahuacán del Río.
 *
 * Para volver a Google más adelante, en Vercel:
 *   NEXT_PUBLIC_MAP_PROVIDER=google
 *   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
 * Sin las dos, se queda en OSM.
 */

export const NOMINATIM_DEBOUNCE_MS = 1100;
export const NOMINATIM_USER_AGENT = "Mandalo/1.0 (pedidos en Ixtlahuacan del Rio; https://mandalo1.vercel.app/app)";
export const NOMINATIM_REFERER = "https://mandalo1.vercel.app/app";

export type MapProviderId = "osm" | "google";

export type GeocodeHit = {
  latitude: number;
  longitude: number;
  direccion: string;
};

export type MapPlace = GeocodeHit;

let nominatimChain: Promise<void> = Promise.resolve();
let nominatimNextAt = 0;

/** Una búsqueda a la vez, con al menos NOMINATIM_DEBOUNCE_MS entre llamadas reales. */
export function waitNominatimSlot(): Promise<void> {
  const scheduled = nominatimChain.then(() => {
    const now = Date.now();
    const start = Math.max(now, nominatimNextAt);
    nominatimNextAt = start + NOMINATIM_DEBOUNCE_MS;
    const delay = start - now;
    if (delay <= 0) return undefined;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });
  });
  nominatimChain = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

export function resolveMapProvider(env: { provider?: string | null; googleKey?: string | null }): MapProviderId {
  const provider = String(env.provider ?? "").trim().toLowerCase();
  const key = String(env.googleKey ?? "").trim();
  if (provider === "google" && key) return "google";
  return "osm";
}

export function nominatimHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": NOMINATIM_USER_AGENT,
    Referer: NOMINATIM_REFERER,
  };
}

/** viewbox = oeste, norte, este, sur. bounded=1 no sale de ese cuadro. */
export function coverageViewBox(): string {
  const box = PROPOSED_CABECERA_BBOX;
  return `${box.minLongitude},${box.maxLatitude},${box.maxLongitude},${box.minLatitude}`;
}

export function nominatimSearchUrl(query: string): string {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", `${query.trim()}, Ixtlahuacán del Río, Jalisco`);
  url.searchParams.set("viewbox", coverageViewBox());
  url.searchParams.set("bounded", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "mx");
  url.searchParams.set("addressdetails", "0");
  return url.toString();
}

/** Sin `lat` y `lng`, no es reverso. `Number(null)` es 0 y 0 sí es finito. */
export function parseGeocodeRequest(searchParams: URLSearchParams): { q: string; latitude: number | null; longitude: number | null } {
  const q = (searchParams.get("q") ?? "").trim();
  const latText = searchParams.get("lat");
  const lngText = searchParams.get("lng");
  if (latText == null || lngText == null || latText.trim() === "" || lngText.trim() === "") {
    return { q, latitude: null, longitude: null };
  }
  const latitude = Number(latText);
  const longitude = Number(lngText);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { q, latitude: null, longitude: null };
  return { q, latitude, longitude };
}

export function nominatimReverseUrl(latitude: number, longitude: number): string {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "0");
  return url.toString();
}

export function readNominatimHits(payload: unknown): GeocodeHit[] {
  const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const hits: GeocodeHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { lat?: unknown; lon?: unknown; display_name?: unknown };
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    const direccion = String(item.display_name ?? "").trim();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !direccion) continue;
    hits.push({ latitude, longitude, direccion });
  }
  return hits.slice(0, 5);
}
