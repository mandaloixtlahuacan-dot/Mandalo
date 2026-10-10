import type { SellUnit, StoreProfile } from "@/lib/catalogOrder/types";
import { fold } from "@/lib/catalogOrder/text";

const WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, unos: 1, unas: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
  cien: 100, ciento: 100,
};

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

export function parseQuantity(raw: string, profile: StoreProfile): QtyHit {
  let text = fold(raw).replace(/¼/g, " 1/4 ").replace(/½/g, " 1/2 ").replace(/¾/g, " 3/4 ");
  text = text.replace(/\s+/g, " ").trim();

  const pesosDigit = text.match(/(?:\$\s*|de a\s+)(\d+(?:\.\d+)?)(?:\s*pesos)?\b/) ?? text.match(/\b(\d+(?:\.\d+)?)\s*pesos\b/);
  const pesosWord = text.match(new RegExp(`\\b(${WORD_RE})\\s+pesos\\b`));
  if (pesosDigit || pesosWord) {
    const qty = pesosDigit ? Number(pesosDigit[1]) : WORDS[pesosWord![1]] ?? 0;
    const rest = strip(text, /(?:\$\s*|de a\s+)?\d+(?:\.\d+)?\s*pesos\b|\b(?:cien|ciento|cincuenta|[a-z]+)\s+pesos\b|\$\s*\d+(?:\.\d+)?/);
    return { qty, unit: "pesos", pieceSize: null, rest: strip(rest, /\bde a\b/) };
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

  if (/\b(un|una)\s+cuarto\b|\bcuarto\b/.test(text) && !/\bkilo y cuarto\b|\by cuarto\b/.test(text)) {
    return { qty: 0.25, unit: "kg", pieceSize: null, rest: strip(text, /\b(un|una)\s+cuarto\b|\bcuarto\b/) };
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
  if (/^medio\b|\bmedio de\b/.test(text) || /\bmedio\b/.test(text) && profile === "carniceria") {
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

  const word = text.match(new RegExp(`\\b(${WORD_RE})\\b`));
  if (word && WORDS[word[1]] != null) {
    const qty = WORDS[word[1]];
    return { qty, unit: null, pieceSize: null, rest: strip(text, new RegExp(`\\b${word[1]}\\b`)) };
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
