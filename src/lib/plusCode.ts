/**
 * Plus codes (Open Location Code) para la dirección que manda el cliente.
 * El algoritmo es el de Google, dominio público: pares de letras y, si el
 * código viene corto («VQ43+3H»), se completa con el centro del pueblo.
 */

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_AT = 8;
const PAD = "0";
const BASE = ALPHABET.length;
const LAT_MAX = 90;
const LNG_MAX = 180;
const PAIR_LENGTH = 10;
const MAX_DIGITS = 15;
const GRID_COLS = 4;
const GRID_ROWS = 5;
const GRID_LENGTH = MAX_DIGITS - PAIR_LENGTH;
const PAIR_PRECISION = BASE ** 3;
const FINAL_LAT_PRECISION = PAIR_PRECISION * GRID_ROWS ** GRID_LENGTH;
const FINAL_LNG_PRECISION = PAIR_PRECISION * GRID_COLS ** GRID_LENGTH;
const PAIR_FIRST = BASE ** (PAIR_LENGTH / 2 - 1);

export type PlusPoint = { latitude: number; longitude: number };

type Area = PlusPoint & { codeLength: number };

function clipLat(latitude: number): number {
  return Math.min(LAT_MAX, Math.max(-LAT_MAX, latitude));
}

function wrapLng(longitude: number): number {
  let value = longitude;
  while (value < -LNG_MAX) value += 360;
  while (value >= LNG_MAX) value -= 360;
  return value;
}

export function isValidPlusCode(code: string): boolean {
  if (!code || code.indexOf(SEPARATOR) < 0 || code.indexOf(SEPARATOR) !== code.lastIndexOf(SEPARATOR)) return false;
  const at = code.indexOf(SEPARATOR);
  if (at > SEPARATOR_AT || at % 2 === 1 || code.length - at - 1 === 1) return false;
  if (code.includes(PAD)) {
    if (at < SEPARATOR_AT || code.startsWith(PAD) || !code.endsWith(SEPARATOR)) return false;
  }
  const body = code.replace(SEPARATOR, "").replace(/0/g, "");
  return [...body].every((character) => ALPHABET.includes(character.toUpperCase()));
}

export function isShortPlusCode(code: string): boolean {
  return isValidPlusCode(code) && code.indexOf(SEPARATOR) < SEPARATOR_AT;
}

export function isFullPlusCode(code: string): boolean {
  if (!isValidPlusCode(code) || isShortPlusCode(code)) return false;
  const upper = code.toUpperCase();
  const latDigit = ALPHABET.indexOf(upper.charAt(0)) * BASE;
  if (latDigit >= LAT_MAX * 2) return false;
  if (upper.length > 1) {
    const lngDigit = ALPHABET.indexOf(upper.charAt(1)) * BASE;
    if (lngDigit >= LNG_MAX * 2) return false;
  }
  return true;
}

function locationToIntegers(latitude: number, longitude: number): [number, number] {
  let latVal = Math.floor(latitude * FINAL_LAT_PRECISION) + LAT_MAX * FINAL_LAT_PRECISION;
  if (latVal < 0) latVal = 0;
  else if (latVal >= 2 * LAT_MAX * FINAL_LAT_PRECISION) latVal = 2 * LAT_MAX * FINAL_LAT_PRECISION - 1;
  let lngVal = Math.floor(longitude * FINAL_LNG_PRECISION) + LNG_MAX * FINAL_LNG_PRECISION;
  const lngSpan = 2 * LNG_MAX * FINAL_LNG_PRECISION;
  if (lngVal < 0) lngVal = (lngVal % lngSpan) + lngSpan;
  else if (lngVal >= lngSpan) lngVal %= lngSpan;
  return [latVal, lngVal];
}

export function encodePlusCode(latitude: number, longitude: number, codeLength = 10): string {
  let [latInt, lngInt] = locationToIntegers(clipLat(latitude), wrapLng(longitude));
  const length = Math.min(MAX_DIGITS, codeLength);
  const code = new Array<string>(MAX_DIGITS + 1);
  code[SEPARATOR_AT] = SEPARATOR;
  if (length > PAIR_LENGTH) {
    for (let i = GRID_LENGTH; i >= 1; i -= 1) {
      const latDigit = latInt % GRID_ROWS;
      const lngDigit = lngInt % GRID_COLS;
      code[SEPARATOR_AT + 2 + i] = ALPHABET.charAt(latDigit * GRID_COLS + lngDigit);
      latInt = Math.floor(latInt / GRID_ROWS);
      lngInt = Math.floor(lngInt / GRID_COLS);
    }
  } else {
    latInt = Math.floor(latInt / GRID_ROWS ** GRID_LENGTH);
    lngInt = Math.floor(lngInt / GRID_COLS ** GRID_LENGTH);
  }
  code[SEPARATOR_AT + 1] = ALPHABET.charAt(latInt % BASE);
  code[SEPARATOR_AT + 2] = ALPHABET.charAt(lngInt % BASE);
  latInt = Math.floor(latInt / BASE);
  lngInt = Math.floor(lngInt / BASE);
  for (let i = PAIR_LENGTH / 2 + 1; i >= 0; i -= 2) {
    code[i] = ALPHABET.charAt(latInt % BASE);
    code[i + 1] = ALPHABET.charAt(lngInt % BASE);
    latInt = Math.floor(latInt / BASE);
    lngInt = Math.floor(lngInt / BASE);
  }
  if (length >= SEPARATOR_AT) return code.slice(0, length + 1).join("");
  return code.slice(0, length).join("") + PAD.repeat(SEPARATOR_AT - length) + SEPARATOR;
}

function decodeFull(code: string): Area {
  const body = code.replace("+", "").replace(/0/g, "").toUpperCase();
  let normalLat = -LAT_MAX * PAIR_PRECISION;
  let normalLng = -LNG_MAX * PAIR_PRECISION;
  let gridLat = 0;
  let gridLng = 0;
  const digits = Math.min(body.length, PAIR_LENGTH);
  let place = PAIR_FIRST;
  for (let i = 0; i < digits; i += 2) {
    normalLat += ALPHABET.indexOf(body.charAt(i)) * place;
    normalLng += ALPHABET.indexOf(body.charAt(i + 1)) * place;
    if (i < digits - 2) place /= BASE;
  }
  let latPrecision = place / PAIR_PRECISION;
  let lngPrecision = place / PAIR_PRECISION;
  if (body.length > PAIR_LENGTH) {
    let rowPlace = GRID_ROWS ** (GRID_LENGTH - 1);
    let colPlace = GRID_COLS ** (GRID_LENGTH - 1);
    const extra = Math.min(body.length, MAX_DIGITS);
    for (let i = PAIR_LENGTH; i < extra; i += 1) {
      const digit = ALPHABET.indexOf(body.charAt(i));
      gridLat += Math.floor(digit / GRID_COLS) * rowPlace;
      gridLng += (digit % GRID_COLS) * colPlace;
      if (i < extra - 1) {
        rowPlace /= GRID_ROWS;
        colPlace /= GRID_COLS;
      }
    }
    latPrecision = rowPlace / FINAL_LAT_PRECISION;
    lngPrecision = colPlace / FINAL_LNG_PRECISION;
  }
  const latitude = normalLat / PAIR_PRECISION + gridLat / FINAL_LAT_PRECISION;
  const longitude = normalLng / PAIR_PRECISION + gridLng / FINAL_LNG_PRECISION;
  return {
    latitude: Math.min(latitude + latPrecision / 2, LAT_MAX),
    longitude: Math.min(longitude + lngPrecision / 2, LNG_MAX),
    codeLength: Math.min(body.length, MAX_DIGITS),
  };
}

/** Código completo, o el corto más cercano al punto de referencia. */
export function recoverPlusCode(code: string, reference: PlusPoint): string | null {
  const upper = code.toUpperCase();
  if (isFullPlusCode(upper)) return upper;
  if (!isShortPlusCode(upper)) return null;
  const padding = SEPARATOR_AT - upper.indexOf(SEPARATOR);
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  const latitude = clipLat(reference.latitude);
  const longitude = wrapLng(reference.longitude);
  const area = decodeFull(encodePlusCode(latitude, longitude).slice(0, padding) + upper);
  let lat = area.latitude;
  let lng = area.longitude;
  if (latitude + half < lat && lat - resolution >= -LAT_MAX) lat -= resolution;
  else if (latitude - half > lat && lat + resolution <= LAT_MAX) lat += resolution;
  if (longitude + half < lng) lng -= resolution;
  else if (longitude - half > lng) lng += resolution;
  return encodePlusCode(lat, lng, area.codeLength);
}

export function decodePlusCode(code: string, reference: PlusPoint): PlusPoint | null {
  const full = recoverPlusCode(code, reference);
  if (!full) return null;
  const area = decodeFull(full);
  if (!Number.isFinite(area.latitude) || !Number.isFinite(area.longitude)) return null;
  return { latitude: area.latitude, longitude: area.longitude };
}
