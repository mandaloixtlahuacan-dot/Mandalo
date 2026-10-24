import { matchCoverageZone } from "@/lib/services/validationEngine";
import {
  COVERAGE_RADIUS_KM,
  IXTLAHUACAN_CENTER,
  PROPOSED_CABECERA_BBOX,
  haversineDistanceKm,
  isWithinCoverageArea,
  normalizeCoverageCoords,
  type Coordinates,
} from "@/lib/services/geo";

/**
 * Cobertura de la app.
 *
 * El pin usa la misma regla activa del bot: círculo de 1.5 km alrededor
 * de IXTLAHUACAN_CENTER (`isWithinCoverageArea`). `PROPOSED_CABECERA_BBOX`
 * sigue apagado; no se usa para aceptar ni rechazar.
 *
 * `zonas_cobertura` es una lista de calles, no un polígono. Sirve cuando
 * no hay pin (el mapa no cargó) y la referencia escrita coincide. Si la
 * tabla no responde, un pin dentro del radio sigue siendo válido.
 */

export type CoverageInput = {
  latitude: number | null;
  longitude: number | null;
  referencia: string | null;
  /** null = la tabla no sirvió. [] = sirvió y no hay calles. */
  zones: string[] | null;
};

export type CoverageOk = {
  ok: true;
  latitude: number | null;
  longitude: number | null;
  zona: string | null;
  regla: "radio" | "zona" | "radio_y_zona";
  distanciaKm: number | null;
  aviso: string | null;
};

export type CoverageFail = { ok: false; mensaje: string; regla: "radio" | "zona" | "sin_datos" };

export function decideCoverage(input: CoverageInput): CoverageOk | CoverageFail {
  const coords = readCoords(input.latitude, input.longitude);
  const zona = input.referencia && input.zones ? matchCoverageZone(input.referencia, input.zones) : null;
  const avisoZonas = input.zones == null ? "La lista de calles no respondió. El pin se valida con el radio de 1.5 km." : null;

  if (coords && isWithinCoverageArea(coords)) {
    return {
      ok: true,
      latitude: coords.latitude,
      longitude: coords.longitude,
      zona,
      regla: zona ? "radio_y_zona" : "radio",
      distanciaKm: roundKm(haversineDistanceKm(coords, IXTLAHUACAN_CENTER)),
      aviso: avisoZonas,
    };
  }

  if (coords && !isWithinCoverageArea(coords)) {
    return {
      ok: false,
      regla: "radio",
      mensaje: `Ese punto está fuera de la cabecera de Ixtlahuacán del Río. Por ahora cubrimos ${COVERAGE_RADIUS_KM} km alrededor del centro.`,
    };
  }

  if (zona) {
    return {
      ok: true,
      latitude: null,
      longitude: null,
      zona,
      regla: "zona",
      distanciaKm: null,
      aviso: "Sin pin. La calle está en la lista de cobertura.",
    };
  }

  if (input.zones == null) {
    return {
      ok: false,
      regla: "sin_datos",
      mensaje: "No pude leer las zonas y no hay un pin dentro del pueblo. Marca el punto o pega las coordenadas.",
    };
  }

  return {
    ok: false,
    regla: "zona",
    mensaje: "Esa dirección no está en la zona de cobertura. Mueve el pin dentro del pueblo o escribe una calle que sí cubrimos.",
  };
}

export function coverageRuleNote(): string {
  return `Radio activo: ${COVERAGE_RADIUS_KM} km desde ${IXTLAHUACAN_CENTER.latitude}, ${IXTLAHUACAN_CENTER.longitude}. El bbox propuesto está ${PROPOSED_CABECERA_BBOX.active ? "activo" : "apagado"}.`;
}

function readCoords(latitude: number | null, longitude: number | null): Coordinates | null {
  if (latitude == null || longitude == null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return normalizeCoverageCoords(latitude, longitude);
}

function roundKm(value: number): number {
  return Math.round(value * 100) / 100;
}
