/**
 * Utilidades geográficas puras — Regla de oro #1 (CLAUDE.md).
 *
 * Antes vivían inline en mandaloFlow.ts; se movieron aquí porque
 * orderTimeoutWorker.ts (y otros workers) también las necesitan para
 * construir links de mapa precisos a partir de coordenadas reales.
 */

// Centro de Ixtlahuacán del Río y radio de cobertura, calibrados con Víctor.
export const IXTLAHUACAN_CENTER = { latitude: 20.865831, longitude: -103.240017 };
export const COVERAGE_RADIUS_KM = 1.5;

// Propuesta NO activa (octubre 2026, pedido 144). El círculo de arriba ya es
// la cabecera: 1.5 km alrededor del centro calibrado con Víctor. El cuadro
// de abajo es el mismo círculo escrito como bbox, por si más adelante se
// quiere un polígono. No entra en isWithinCoverageArea. No sustituye a
// zonas_cobertura (esa lista sigue siendo solo para dirección escrita).
// Derivación: 1° de latitud ≈ 111.32 km; 1° de longitud ≈ 111.32·cos(lat).
//   dLat = 1.5 / 111.32 ≈ 0.01348
//   dLng = 1.5 / (111.32·cos(20.865831°)) ≈ 0.01442
//   lat  20.85235 … 20.87931
//   lng -103.25444 … -103.22558
export const PROPOSED_CABECERA_BBOX = {
  active: false as const,
  minLatitude: 20.85235,
  maxLatitude: 20.87931,
  minLongitude: -103.25444,
  maxLongitude: -103.22558,
};

export const COVERAGE_REJECT_MESSAGE =
  "📍 *Por ahora Mándalo solo cubre entregas dentro de Ixtlahuacán del Río.*\n\n" +
  "Tu ubicación quedó fuera de esa zona.\n\n" +
  "Mándame otra ubicación, o escríbeme tu dirección (calle y número, colonia o una referencia). Si ya no quieres el pedido, escribe *cancelar*.";
const EARTH_RADIUS_KM = 6371;

export type Coordinates = { latitude: number; longitude: number };

export function haversineDistanceKm(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

export function isWithinCoverageArea(coords: Coordinates): boolean {
  return haversineDistanceKm(coords, IXTLAHUACAN_CENTER) <= COVERAGE_RADIUS_KM;
}

/** Número finito. `null` y `""` no se vuelven 0: `Number(null)` es 0 y un pin vacío caía en el Golfo de Guinea, fuera de la cabecera. */
export function finiteGeoNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Deja el par en grados. Un entero estilo protobuf (|lat| > 90 o |lng| > 180)
 * se divide entre 1e7 una sola vez. 0,0 no es un pin.
 */
export function normalizeCoverageCoords(latitude: number, longitude: number): Coordinates | null {
  let lat = latitude;
  let lng = longitude;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    const scaledLat = lat / 1e7;
    const scaledLng = lng / 1e7;
    if (Math.abs(scaledLat) > 90 || Math.abs(scaledLng) > 180) return null;
    lat = scaledLat;
    lng = scaledLng;
  }
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}

/** Coordenadas embebidas en un link de Google Maps, cuando el objeto no trae números útiles. */
export function coordsFromMapText(text: string): Coordinates | null {
  const source = String(text ?? "");
  const patterns = [
    /[?&]q=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
    /@(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const coords = normalizeCoverageCoords(Number(match[1]), Number(match[2]));
    if (coords) return coords;
  }
  return null;
}

export function extractCoordsFromUbicacion(ubicacion: unknown): Coordinates | null {
  if (!ubicacion || typeof ubicacion !== "object") return null;
  const raw = ubicacion as Record<string, unknown>;
  const latitude = finiteGeoNumber(raw.latitude ?? raw.lat);
  const longitude = finiteGeoNumber(raw.longitude ?? raw.lng ?? raw.lon);
  const primary = latitude != null && longitude != null ? normalizeCoverageCoords(latitude, longitude) : null;
  if (primary) return primary;
  const degreesLat = finiteGeoNumber(raw.degreesLatitude);
  const degreesLng = finiteGeoNumber(raw.degreesLongitude);
  const alternate = degreesLat != null && degreesLng != null ? normalizeCoverageCoords(degreesLat, degreesLng) : null;
  if (alternate) return alternate;
  return coordsFromMapText(String(raw.url ?? ""));
}

export function buildMapsLinkFromCoords(coords: Coordinates): string {
  return `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}`;
}

// Sin el link crudo aquí a propósito: quien necesita el mapa (ej. el mensaje
// al repartidor) ya lo arma aparte con resolveMapsLink/buildMapsLinkFromCoords
// a partir de lat/lng reales — meterlo también en el texto de dirección
// producía el mismo link duplicado dos veces en el mismo mensaje.
export function buildAddressTextFromCoords(): string {
  return "Ubicación compartida por GPS 📍";
}

// Solo devuelve link de mapa si hay coordenadas GPS reales — nunca a partir
// de texto libre. Antes intentaba un link "de búsqueda" geocodificado desde
// addressText cuando faltaban coordenadas, pero además tenía un bug real:
// `Number(null)` da `0` en JS, y `0` SÍ es finito, así que un pedido sin GPS
// (latitud/longitud null en BD) pasaba el chequeo igual y generaba un link
// a 0,0 — un punto en el océano, no una dirección real. Con dirección
// escrita (sin GPS), el repartidor recibe solo el texto, sin ningún link.
export function resolveMapsLink(params: {
  latitud?: number | null;
  longitud?: number | null;
}): string | null {
  const { latitud, longitud } = params;
  if (typeof latitud === "number" && Number.isFinite(latitud) && typeof longitud === "number" && Number.isFinite(longitud)) {
    return buildMapsLinkFromCoords({ latitude: latitud, longitude: longitud });
  }
  return null;
}
