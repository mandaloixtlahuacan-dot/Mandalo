import { wordsAreClose } from "@/lib/orderEdits";

export type ListaProducto = {
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  categoria?: string | null;
  alias?: string[];
  precio?: number | null;
};

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(value: string): string[] {
  return norm(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

function tokenHits(hay: string, value: string | null | undefined): number {
  const text = norm(value ?? "");
  if (!text) return 0;
  if (hay.includes(text)) return 3;
  let hits = 0;
  for (const token of tokensOf(text)) {
    const stem = token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token;
    if (hay.includes(token) || hay.includes(stem)) hits += 1;
    else if (hay.split(" ").some((word) => wordsAreClose(word, token) || wordsAreClose(word, stem))) hits += 1;
  }
  return hits;
}

export function matchLista(text: string, rows: ListaProducto[]): ListaProducto[] {
  const hay = norm(text);
  if (!hay || !rows.length) return [];
  const scored = rows
    .map((row) => {
      let score = tokenHits(hay, row.nombre);
      score += tokenHits(hay, row.marca) > 0 ? 2 : 0;
      score += tokenHits(hay, row.presentacion) > 0 ? 1 : 0;
      for (const alias of row.alias ?? []) score += tokenHits(hay, alias) > 0 ? 3 : 0;
      return { row, score };
    })
    .filter((entry) => entry.score >= 2);
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].score;
  return scored.filter((entry) => entry.score >= best - 1).slice(0, 5).map((entry) => entry.row);
}

function sameProduct(left: ListaProducto, itemName: string, itemBrand: string | null | undefined): boolean {
  const nameHit = tokenHits(norm(`${itemName} ${itemBrand ?? ""}`), left.nombre) > 0;
  const brand = norm(left.marca ?? "");
  if (!brand) return nameHit;
  return nameHit && (norm(itemBrand ?? "").includes(brand) || norm(itemName).includes(brand) || !norm(itemBrand ?? ""));
}

export const LISTA_UNKNOWN_NOTE = "_Lo anoto así y la tienda confirma._";

const ORDER_NOISE = new Set([
  "quiero", "quisiera", "dame", "traeme", "anota", "anotame", "agrega", "agregame",
  "tambien", "ademas", "porfa", "favor", "kilo", "kilos", "litro", "litros", "pieza", "piezas",
]);

export function unknownFromLista(message: string, rows: ListaProducto[], items: Array<{ nombre_producto: string }>): { nombre_producto: string } | null {
  if (!rows.length) return null;
  const hay = norm(message);
  if (!/\b(quiero|dame|traeme|anota|agrega)\b/.test(hay)) return null;
  if (matchLista(message, rows).length) return null;
  const tokens = hay.split(" ").filter((token) => token.length >= 4 && !ORDER_NOISE.has(token) && !/^\d+$/.test(token));
  if (!tokens.length) return null;
  const covered = items.some((item) => tokens.some((token) => norm(item.nombre_producto).includes(token)));
  if (covered) return null;
  const nombre = tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
  return { nombre_producto: nombre };
}

export function applyListaToItems(
  items: Array<{ nombre_producto: string; marca?: string | null; presentacion?: string | null; notas?: string | null }>,
  rows: ListaProducto[],
  message: string,
): { items: typeof items; note: string | null } {
  if (!rows.length) return { items, note: null };
  let note: string | null = null;
  const next = items.map((item) => {
    const hits = matchLista(`${item.nombre_producto} ${item.marca ?? ""} ${message}`, rows).filter((row) =>
      sameProduct(row, item.nombre_producto, item.marca),
    );
    if (!hits.length) {
      const mentioned = tokenHits(norm(message), item.nombre_producto) > 0 || tokenHits(norm(message), item.marca) > 0;
      if (mentioned && matchLista(message, rows).length === 0) note = LISTA_UNKNOWN_NOTE;
      return item;
    }
    if (hits.length === 1) {
      return {
        ...item,
        marca: item.marca || hits[0].marca || null,
        presentacion: item.presentacion || hits[0].presentacion || null,
      };
    }
    return item;
  });
  return { items: next, note };
}

export function listaChoiceForItem(
  item: { nombre_producto: string; marca?: string | null; presentacion?: string | null },
  rows: ListaProducto[],
): { title: string; emoji: string; choices: string[] } | null {
  const hits = matchLista(`${item.nombre_producto} ${item.marca ?? ""}`, rows).filter((row) =>
    sameProduct(row, item.nombre_producto, item.marca),
  );
  if (hits.length < 2) return null;
  const options = [...new Set(hits.map((row) => [row.marca, row.presentacion].filter(Boolean).join(" ")).filter(Boolean))].slice(0, 5);
  if (options.length < 2) return null;
  const title = item.marca
    ? `¿Cuál ${item.nombre_producto} ${item.marca}?`
    : `¿Cuál ${item.nombre_producto}?`;
  return { title, emoji: "🥛", choices: options };
}

function splitCsv(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      cols.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cols.push(current.trim());
  return cols;
}

export function parseStoreProductText(raw: string): ListaProducto[] {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (!lines.length) return [];
  const header = norm(lines[0]);
  const csv = header.includes("nombre") && lines[0].includes(",");
  const body = csv ? lines.slice(1) : lines;
  const headers = csv ? splitCsv(lines[0]).map((cell) => norm(cell)) : [];
  const rows: ListaProducto[] = [];
  for (const line of body) {
    if (csv) {
      const cols = splitCsv(line);
      const at = (name: string) => {
        const index = headers.indexOf(name);
        return index >= 0 ? cols[index] ?? "" : "";
      };
      const nombre = at("nombre") || cols[0] || "";
      if (!nombre) continue;
      const alias = at("alias")
        .split(/[|;]/)
        .map((part) => part.trim())
        .filter(Boolean);
      rows.push({
        nombre,
        marca: at("marca") || null,
        presentacion: at("presentacion") || null,
        categoria: at("categoria") || null,
        alias,
      });
      continue;
    }
    if (line.includes("|")) {
      const [nombre, marca, presentacion, categoria] = line.split("|").map((part) => part.trim());
      if (!nombre) continue;
      rows.push({ nombre, marca: marca || null, presentacion: presentacion || null, categoria: categoria || null, alias: [] });
      continue;
    }
    rows.push({ nombre: line, alias: [] });
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${norm(row.nombre)}|${norm(row.marca ?? "")}|${norm(row.presentacion ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function listaNamesForPrompt(rows: ListaProducto[], message: string): string[] {
  const hits = matchLista(message, rows);
  const names = (hits.length ? hits : []).map((row) =>
    [row.nombre, row.marca, row.presentacion].filter(Boolean).join(" "),
  );
  return names.slice(0, 8);
}
