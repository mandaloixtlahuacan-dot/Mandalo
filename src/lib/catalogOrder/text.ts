const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "uno", "unos", "unas",
  "y", "o", "e", "con", "sin", "por", "para", "que", "se", "al", "lo", "los",
  "quiero", "dame", "ponme", "tambien", "ademas", "mas", "solo", "nomas",
  "mejor", "porfa", "favor", "me", "das", "manda", "mandas", "oye", "este",
  "eh", "ok", "va", "kilo", "kilos", "kg", "gramo", "gramos", "pieza", "piezas",
  "orden", "serian", "seria", "por", "favor", "otra", "otro", "otras", "otros",
  "igual", "refiero", "perdon", "disculpa", "para", "asada", "bolsa", "paquete",
  "porfavor", "gracias", "tambien", "quiero", "manda", "mandas", "unas", "unos",
]);

export function fold(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[¿?¡!""«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clave fonética corta: c/s/z, ll/y, b/v, h muda, qu/k, letras dobles. */
export function phonetic(value: string): string {
  let text = fold(value);
  text = text.replace(/ll/g, "y");
  text = text.replace(/qu/g, "k");
  text = text.replace(/v/g, "b");
  text = text.replace(/z/g, "s");
  text = text.replace(/c(?=[ei])/g, "s");
  text = text.replace(/c/g, "k");
  text = text.replace(/h/g, "");
  text = text.replace(/(.)\1+/g, "$1");
  return text.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function compact(value: string): string {
  return phonetic(value).replace(/\s+/g, "");
}

export function tokens(value: string): string[] {
  return fold(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP.has(token) && !/^\d+$/.test(token));
}

export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = row[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = saved;
    }
  }
  return row[right.length];
}

export function fuzzyIncludes(haystack: string, needle: string): boolean {
  const hay = fold(haystack);
  const pin = fold(needle);
  if (!pin) return false;
  if (hay.includes(pin)) return true;
  const hayTokens = tokens(hay);
  const pinTokens = tokens(pin);
  if (!pinTokens.length) return hay.includes(pin);
  return pinTokens.every((token) => hayTokens.some((item) => item === token || editDistance(compact(item), compact(token)) <= 1));
}
