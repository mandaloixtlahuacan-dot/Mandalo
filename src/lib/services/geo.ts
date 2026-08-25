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

export function extractCoordsFromUbicacion(ubicacion: unknown): Coordinates | null {
  if (!ubicacion || typeof ubicacion !== "object") return null;
  const raw = ubicacion as { latitude?: unknown; longitude?: unknown };
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
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
