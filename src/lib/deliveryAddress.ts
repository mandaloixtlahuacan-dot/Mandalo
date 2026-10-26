/**
 * Dirección que el cliente manda en vez del pin de WhatsApp.
 * Acepta calle y número, link de Maps y plus code. Si el punto cae
 * fuera de Ixtlahuacán del Río, no se guarda.
 */

import { coordsFromMapText, isWithinCoverageArea, IXTLAHUACAN_CENTER, type Coordinates } from "@/lib/services/geo";
import { decodePlusCode } from "@/lib/plusCode";

export const ADDRESS_UNCONFIRMED_MARK = "dirección por confirmar";

const MAPS_URL =
  /(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\/?[^\s]*/i;

const PLUS_CODE = /\b([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,8})\b/i;

const STREET_TYPE =
  /\b(calle|avenida|av|privada|cerrada|andador|boulevard|blvd|libramiento|carretera|carr|camino|colonia|fraccionamiento|km)\b/;

const STRONG = /\b(calle|avenida|av|colonia|frente a|esquina|domicilio|entre la)\b/;
const WEAK = /\b(col|numero|num|mz|manzana|lote|casa|centro)\b/;
const NAMED = /\b(hidalgo|juarez|morelos|allende|reforma|ixtlahuacan)\b/;

const OUTSIDE_PLACES = [
  "guadalajara",
  "zapopan",
  "tonala",
  "tlaquepaque",
  "tlajomulco",
  "acatic",
  "zapotlanejo",
  "tepatitlan",
  "membrillos",
  "cuquio",
  "yahualica",
  "colotlan",
];

const FILLER = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "y", "a", "en", "al",
  "por", "con", "mi", "tu", "su", "es", "jal", "jalisco", "mexico", "rio",
  "numero", "num", "no", "casa",
]);

export type DeliveryRead =
  | { kind: "coords"; text: string; latitude: number; longitude: number }
  | { kind: "link"; text: string }
  | { kind: "street"; text: string }
  | { kind: "outside" }
  | { kind: "refuse_pin" }
  | { kind: "unparsed" };

function fold(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function withUnconfirmedMark(text: string): string {
  const body = clean(text);
  if (!body) return `(${ADDRESS_UNCONFIRMED_MARK})`;
  if (body.toLowerCase().includes(ADDRESS_UNCONFIRMED_MARK)) return body;
  return `${body}\n(${ADDRESS_UNCONFIRMED_MARK})`;
}

function houseNumber(text: string): boolean {
  return /\b\d{1,4}\b/.test(text);
}

function roadToward(text: string, place: string): boolean {
  if (!/\b(?:libramiento|carretera|carr|camino|km|rumbo|hacia)\b/.test(text)) return false;
  return new RegExp(`\\ba\\s+${place}\\b`).test(text);
}

function outsideTown(text: string): boolean {
  if (/ixtlahuacan de los membrillos/.test(text)) return true;
  for (const place of OUTSIDE_PLACES) {
    if (!new RegExp(`\\b${place}\\b`).test(text)) continue;
    if (roadToward(text, place)) continue;
    return true;
  }
  return false;
}

function localityInTown(locality: string): boolean {
  const text = fold(locality);
  if (!text) return true;
  if (/ixtlahuacan de los membrillos/.test(text)) return false;
  return /\bixtlahuacan\b/.test(text);
}

function covered(coords: Coordinates): boolean {
  return isWithinCoverageArea(coords);
}

function streetLike(text: string, locating: boolean): boolean {
  if (!text || text.length > 180) return false;
  const strong = STRONG.test(text);
  const weak = WEAK.test(text);
  const named = NAMED.test(text);
  const numbered = /\b\d{1,5}\b/.test(text);
  if (locating) {
    if (strong || weak) return true;
    if (numbered && named) return true;
    if (!houseNumber(text)) return false;
    if (STREET_TYPE.test(text)) return true;
    const words = text.split(" ").filter((word) => word.length >= 4 && !FILLER.has(word) && !/^\d+$/.test(word));
    return words.length > 0;
  }
  if (weak && !strong) return false;
  if (strong) return true;
  return numbered && named;
}

function refusesPin(text: string): boolean {
  if (/^(no|nel|nop|nope|no gracias|no quiero|no puedo|no tengo|no se|no se como|no me sale|no traigo)$/.test(text)) {
    return true;
  }
  if (text.length > 80) return false;
  return (
    /\b(no puedo|no quiero|no tengo|no se como|no me sale)\b/.test(text) &&
    /\b(gps|pin|ubicacion|mapa|mandar|enviar|compartir)\b/.test(text)
  ) || /\b(sin gps|sin pin|sin ubicacion)\b/.test(text);
}

export function classifyDeliveryText(message: string, locating: boolean): DeliveryRead {
  const raw = clean(message);
  const text = fold(raw);
  const link = raw.match(MAPS_URL);
  if (link) {
    const url = link[0].replace(/[),.;]+$/, "");
    const coords = coordsFromMapText(url);
    if (coords) {
      if (!covered(coords)) return { kind: "outside" };
      return { kind: "coords", text: "Ubicación de Google Maps 📍", latitude: coords.latitude, longitude: coords.longitude };
    }
    return { kind: "link", text: url };
  }

  const plus = raw.toUpperCase().match(PLUS_CODE);
  if (plus) {
    const code = plus[1];
    const after = raw.slice((plus.index ?? 0) + plus[0].length);
    if (!localityInTown(after)) return { kind: "outside" };
    const coords = decodePlusCode(code, IXTLAHUACAN_CENTER);
    if (!coords || !covered(coords)) return { kind: "outside" };
    return { kind: "coords", text: raw, latitude: coords.latitude, longitude: coords.longitude };
  }

  if (locating && outsideTown(text)) return { kind: "outside" };
  if (streetLike(text, locating)) return { kind: "street", text: raw };
  if (locating && refusesPin(text)) return { kind: "refuse_pin" };
  return { kind: "unparsed" };
}
