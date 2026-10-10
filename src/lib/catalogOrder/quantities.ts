import type { SellUnit, StoreProfile } from "@/lib/catalogOrder/types";
import { fold } from "@/lib/catalogOrder/text";

const SMALL: Record<string, number> = {
  un: 1, una: 1, uno: 1, unos: 1, unas: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
  ochenta: 80, noventa: 90,
};

const HUNDRED: Record<string, number> = {
  cien: 100, ciento: 100,
  doscientos: 200, doscientas: 200,
  trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};

const WORDS: Record<string, number> = { ...SMALL, ...HUNDRED };
const WORD_RE = Object.keys(WORDS).sort((a, b) => b.length - a.length).join("|");

export type QtyHit = {
  qty: number;
  unit: SellUnit | null;
  /** Número que es tamaño (alitas de 10), no cantidad de órdenes. */
  pieceSize: number | null;
  rest: string;
};

function strip(text: string, pattern: RegExp): string {
  return text.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

/** Lee un número en palabras (1–999 y mil), con «y» entre decenas y unidades. */
function parseNumberTokens(words: string[]): { value: number; used: number } | null {
  let index = 0;
  let total = 0;
  let current = 0;
  let saw = false;
  while (index < words.length) {
    const word = words[index];
    if (word === "y") {
      if (!saw) return null;
      const next = words[index + 1];
      if (!next || (SMALL[next] == null && HUNDRED[next] == null && next !== "mil")) break;
      index += 1;
      continue;
    }
    if (word === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      saw = true;
      index += 1;
      continue;
    }
    if (HUNDRED[word] != null) {
      current += HUNDRED[word];
      saw = true;
      index += 1;
      continue;
    }
    if (SMALL[word] != null) {
      current += SMALL[word];
      saw = true;
      index += 1;
      continue;
    }
    break;
  }
  if (!saw) return null;
  return { value: total + current, used: index };
}

function trailingNumber(words: string[]): { value: number; count: number } | null {
  let best: { value: number; count: number } | null = null;
  const max = Math.min(8, words.length);
  for (let len = 1; len <= max; len += 1) {
    const slice = words.slice(words.length - len);
    const parsed = parseNumberTokens(slice);
    if (parsed && parsed.used === slice.length) best = { value: parsed.value, count: len };
  }
  return best;
}

function pesosAmount(text: string): { qty: number; consume: RegExp } | null {
  const digit = text.match(/(?:\$\s*)(\d+(?:\.\d+)?)(?:\s*pesos)?\b/)
    ?? text.match(/\bde a\s+(\d+(?:\.\d+)?)(?:\s*pesos)?\b/)
    ?? text.match(/\b(\d+(?:\.\d+)?)\s*pesos\b/);
  if (digit) {
    return {
      qty: Number(digit[1]),
      consume: /(?:\$\s*|de a\s+)?\d+(?:\.\d+)?\s*pesos\b|\$\s*\d+(?:\.\d+)?|\bde a\s+\d+(?:\.\d+)?\b/,
    };
  }
  const pesosAt = text.search(/\bpesos\b/);
  if (pesosAt >= 0) {
    const before = text.slice(0, pesosAt).trim().split(/\s+/).filter(Boolean);
    const number = trailingNumber(before);
    if (number && number.value > 0) {
      return { qty: number.value, consume: new RegExp(`(?:${WORD_RE})(?:\\s+(?:y\\s+)?(?:${WORD_RE}|mil))*\\s+pesos\\b`) };
    }
  }
  const deA = text.match(/\bde a\s+((?:[a-z]+\s+){0,6}[a-z]+)\b/);
  if (deA) {
    const words = deA[1].trim().split(/\s+/);
    const parsed = parseNumberTokens(words);
    if (parsed && parsed.used > 0) {
      const phrase = words.slice(0, parsed.used).join(" ");
      return { qty: parsed.value, consume: new RegExp(`\\bde a\\s+${phrase}\\b`) };
    }
  }
  return null;
}

function cuartosAmount(text: string): { qty: number; span: string } | null {
  if (/\bkilos?\s+y\s*cuartos?\b/.test(text)) return null;
  const match = text.match(/(?:^|\s)((?:y\s+)?(?:(?:[a-z]+|\d+(?:\.\d+)?)\s+)?)cuartos?\b/);
  if (!match || match.index == null) return null;
  const prefix = (match[1] ?? "").trim();
  const words = prefix.split(/\s+/).filter(Boolean);
  const numberWord = [...words].reverse().find((word) => word !== "y");
  let qty = 0.25;
  if (numberWord) {
    if (/^\d/.test(numberWord)) qty = Number(numberWord) * 0.25;
    else {
      const parsed = parseNumberTokens([numberWord]);
      if (!parsed) return null;
      qty = parsed.value * 0.25;
    }
  }
  return { qty, span: match[0] };
}

export function parseQuantity(raw: string, profile: StoreProfile): QtyHit {
  let text = fold(raw).replace(/¼/g, " 1/4 ").replace(/½/g, " 1/2 ").replace(/¾/g, " 3/4 ");
  text = text.replace(/\s+/g, " ").trim();

  const pesos = pesosAmount(text);
  if (pesos && pesos.qty > 0) {
    return { qty: pesos.qty, unit: "pesos", pieceSize: null, rest: strip(strip(text, pesos.consume), /\bde a\b/) };
  }

  const grams = text.match(/\b(\d+(?:\.\d+)?)\s*(g|gr|gramos)\b/);
  if (grams) {
    const qty = Number(grams[1]) / 1000;
    return { qty, unit: "kg", pieceSize: null, rest: strip(text, /\b\d+(?:\.\d+)?\s*(g|gr|gramos)\b/) };
  }

  const fraction = text.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  if (fraction) {
    const den = Number(fraction[2]);
    const qty = den > 0 ? Number(fraction[1]) / den : 0;
    return { qty, unit: "kg", pieceSize: null, rest: strip(text, /\b\d+\s*\/\s*\d+\b/) };
  }

  const cuartos = cuartosAmount(text);
  if (cuartos) {
    return { qty: cuartos.qty, unit: "kg", pieceSize: null, rest: strip(text, new RegExp(cuartos.span.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) };
  }

  const kilosY = text.match(new RegExp(`\\b(${WORD_RE}|\\d+)\\s+kilos?\\s+y\\s+medio\\b`));
  if (kilosY) {
    const base = WORDS[kilosY[1]] ?? Number(kilosY[1]);
    return { qty: base + 0.5, unit: "kg", pieceSize: null, rest: strip(text, new RegExp(`\\b(${WORD_RE}|\\d+)\\s+kilos?\\s+y\\s+medio\\b`)) };
  }
  if (/\bkilo y medio\b|\bymedio\b/.test(text)) {
    return { qty: 1.5, unit: "kg", pieceSize: null, rest: strip(text, /\b(un |una )?kilo y medio\b|\bymedio\b/) };
  }
  if (/\bkilo y cuarto\b|\bycuarto\b/.test(text)) {
    const base = /\b(dos|2)\b/.test(text) ? 2 : 1;
    return { qty: base + 0.25, unit: "kg", pieceSize: null, rest: strip(text, /\b(un |una |dos )?kilos? y cuarto\b|\bycuarto\b/) };
  }

  if (/\bmedia docena\b/.test(text)) {
    const dedos = /\bdedos?\b/.test(text);
    return {
      qty: dedos ? 1 : 6,
      unit: profile === "carniceria" ? "kg" : "pz",
      pieceSize: dedos ? 6 : null,
      rest: strip(text, /\bmedia docena\b/),
    };
  }

  if (/\bmedio kilo\b|\bmedia kilo\b/.test(text)) {
    return { qty: 0.5, unit: "kg", pieceSize: null, rest: strip(text, /\bmedio kilo\b|\bmedia kilo\b/) };
  }
  if (/^medio\b|\bmedio de\b|^y\s+medio\b/.test(text) || (/\bmedio\b/.test(text) && profile === "carniceria")) {
    if (/\bmedio\b/.test(text)) {
      return { qty: 0.5, unit: "kg", pieceSize: null, rest: strip(text, /\bmedio\b/) };
    }
  }

  if (/\bun par\b/.test(text)) {
    return { qty: 2, unit: null, pieceSize: null, rest: strip(text, /\bun par\b/) };
  }

  if (/\balitas?\b/.test(text)) {
    const piece = text.match(/\b(\d+)\b/);
    if (piece) {
      const n = Number(piece[1]);
      const known = [5, 10, 15, 20, 30];
      if (known.includes(n)) {
        return { qty: 1, unit: "pz", pieceSize: n, rest: strip(text, new RegExp(`\\b${n}\\b`)).replace(/\bpiezas?\b/, " ").trim() };
      }
      return { qty: 1, unit: "pz", pieceSize: n, rest: strip(text, new RegExp(`\\b${n}\\b`)) };
    }
  }

  const words = text.split(/\s+/).filter(Boolean);
  for (let start = 0; start < words.length; start += 1) {
    const parsed = parseNumberTokens(words.slice(start));
    if (!parsed) continue;
    const after = words.slice(start + parsed.used).join(" ");
    const phrase = words.slice(start, start + parsed.used).join(" ");
    if (/^(kg|kilos?)\b/.test(after)) {
      return { qty: parsed.value, unit: "kg", pieceSize: null, rest: strip(text, new RegExp(`\\b${phrase}\\b`)) };
    }
    return { qty: parsed.value, unit: null, pieceSize: null, rest: strip(text, new RegExp(`\\b${phrase}\\b`)) };
  }
  const digit = text.match(/\b(\d+(?:\.\d+)?)\b/);
  if (digit) {
    const qty = Number(digit[1]);
    const after = text.slice((digit.index ?? 0) + digit[1].length);
    if (/^\s*(kg|kilo|kilos)\b/.test(after)) {
      return { qty, unit: "kg", pieceSize: null, rest: strip(text, /\b\d+(?:\.\d+)?\s*(kg|kilos?)\b/) };
    }
    return { qty, unit: null, pieceSize: null, rest: strip(text, /\b\d+(?:\.\d+)?\b/) };
  }

  return { qty: 1, unit: null, pieceSize: null, rest: text };
}
