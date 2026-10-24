/** Kilos de la carnicería en la app. El bot sigue usando su propio parser. */

export const MAX_KILOS = 10;
export const KILO_PRESETS = [0.25, 0.5, 1, 2] as const;

const FRACTIONS: Array<{ value: number; label: string }> = [
  { value: 0.25, label: "¼" },
  { value: 0.5, label: "½" },
  { value: 0.75, label: "¾" },
];

export function roundKilos(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Acepta 0.5, 0,5, 1/2, ¼ y «2 kg». Rechaza 0, negativos y más de 10 kg. */
export function parseKilos(raw: unknown): number | null {
  if (typeof raw === "number") return accept(raw);
  const text = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return null;
  const glyph = FRACTIONS.find((item) => text === item.label || text === `${item.label} kg`);
  if (glyph) return glyph.value;
  const body = text.replace(/\s*kg$/, "").trim().replace(",", ".");
  const fraction = body.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const den = Number(fraction[2]);
    if (!den) return null;
    return accept(Number(fraction[1]) / den);
  }
  if (!/^\d+(\.\d+)?$/.test(body)) return null;
  return accept(Number(body));
}

function accept(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_KILOS) return null;
  const rounded = roundKilos(value);
  if (rounded <= 0 || rounded > MAX_KILOS) return null;
  return rounded;
}

/** «¼ kg», «½ kg», «1 kg», «1.5 kg». */
export function formatKilos(kilos: number): string {
  const rounded = roundKilos(kilos);
  const known = FRACTIONS.find((item) => Math.abs(item.value - rounded) < 0.001);
  if (known) return `${known.label} kg`;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${text} kg`;
}

export function butcherLine(nombre: string, kilos: number): string {
  return `${formatKilos(kilos)} ${nombre.trim()}`;
}

const LEADING = /^(¼|½|¾|\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)\s*kg\b/i;

export function leadingKilos(nombre: string): number | null {
  const match = nombre.trim().match(LEADING);
  if (!match) return null;
  return parseKilos(match[1]);
}

/** El nombre ya dice los mismos kilos, así que no se vuelve a escribir «x0.5». */
export function nameAlreadyShowsKilos(nombre: string, cantidad: number): boolean {
  const shown = leadingKilos(nombre);
  if (shown == null || !Number.isFinite(cantidad)) return false;
  return Math.abs(shown - roundKilos(cantidad)) < 0.001;
}
