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

export function buildAddressTextFromCoords(coords: Coordinates): string {
  return `Ubicación compartida por GPS: ${buildMapsLinkFromCoords(coords)}`;
}

// Preferimos un link de mapa preciso construido desde coordenadas reales (GPS)
// sobre un link "de búsqueda" geocodificado a partir de texto libre (impreciso).
export function resolveMapsLink(params: {
  latitud?: number | null;
  longitud?: number | null;
  addressText?: string | null;
}): string | null {
  const lat = Number(params.latitud);
  const lng = Number(params.longitud);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return buildMapsLinkFromCoords({ latitude: lat, longitude: lng });
  }
  const addressText = String(params.addressText ?? "").trim();
  return addressText
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`
    : null;
}
