import type { CatalogPriceRow } from "@/lib/catalogQuantities";
import { stripBotDecorations } from "@/lib/messageStyle";
import type { PedidoItemInput } from "@/lib/services/captureEngine";

/**
 * Correcciones del cliente antes del sí de la lista: quitar, sumar una,
 * cambiar cantidad o tamaño, o cambiar un producto por otro.
 * Se aplican sobre lo que ya estaba anotado. El texto que sobra (un producto
 * nuevo) lo lee quien llama.
 */

export type EditOp =
  | { kind: "remove"; target: string; mode?: "one" | "all" | "ask" }
  | { kind: "increment"; target: string | null; by: number }
  | { kind: "replace"; from: string; to: string }
  | { kind: "setQty"; target: string | null; qty: number; unit: string | null }
  | { kind: "resize"; target: string | null; size: string };

export type EditPlan = {
  ops: EditOp[];
  /** El mensaje solo corrige. No hay un producto nuevo que volver a leer. */
  editsOnly: boolean;
  /** Lo que queda del mensaje después de sacar las correcciones. */
  remainder: string;
};

export type AddedLine = {
  item: PedidoItemInput | null;
  aside: string | null;
};

const NUM: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

const SIZE_WORDS = ["chica", "chico", "grande", "mediana", "mediano", "sencilla", "sencillo", "doble", "triple"];

const LEFTOVER_SKIP = new Set([
  "si", "ok", "va", "dale", "confirmo", "confirmar", "pero", "por", "favor", "gracias",
  "y", "e", "tambien", "mas", "otro", "otra", "otros", "otras", "el", "la", "los", "las",
  "un", "una", "uno", "de", "del", "que", "sean", "sea", "a", "me", "te", "lo", "al",
  "kilo", "kilos", "kg", "gramo", "gramos", "pieza", "piezas",
]);

const DRINK = new Set([
  "refresco", "refrescos", "coca", "cocas", "coquita", "coquitas", "pepsi", "sprite",
  "manzana", "manzanita", "manzanitas", "mirinda", "seven", "chesco", "chescos",
]);

function norm(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlePhrase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const upper = prev[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + cost);
      corner = upper;
    }
  }
  return prev[right.length];
}

export function wordsAreClose(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  return editDistance(left, right) <= 2;
}

function qtyOf(raw: string): { qty: number; unit: string | null } {
  if (raw === "kilo y medio") return { qty: 1.5, unit: "kilo" };
  if (raw === "medio kilo") return { qty: 0.5, unit: "kilo" };
  const qty = NUM[raw] ?? Number(raw);
  return { qty, unit: null };
}

function unitOf(raw: string | undefined, fallback: string | null): string | null {
  if (!raw) return fallback;
  if (raw === "kg" || raw === "kilo" || raw === "kilos") return "kilo";
  if (raw.startsWith("gramo")) return "gramo";
  return fallback;
}

function wantedSize(size: string): string {
  const word = norm(size);
  if (word === "chico" || word === "chicos") return "chica";
  if (word === "mediano" || word === "medianos") return "mediana";
  if (word === "sencillo" || word === "sencillos") return "sencilla";
  if (word === "chicas") return "chica";
  if (word === "grandes") return "grande";
  if (word === "medianas") return "mediana";
  if (word === "sencillas") return "sencilla";
  if (word === "dobles") return "doble";
  if (word === "triples") return "triple";
  return word;
}

function stripSize(value: string): string {
  return norm(value)
    .replace(/\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blob(item: PedidoItemInput): string {
  return norm(`${item.nombre_producto} ${item.marca ?? ""}`);
}

function itemIsDrink(item: PedidoItemInput): boolean {
  return blob(item)
    .split(" ")
    .some((word) => DRINK.has(word));
}

function matchesTarget(item: PedidoItemInput, target: string): boolean {
  const useful = norm(target)
    .split(" ")
    .filter((word) => word.length >= 3 && !LEFTOVER_SKIP.has(word));
  if (!useful.length) return false;
  const hay = blob(item);
  return useful.every((token) => {
    const stem = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
    if (hay.includes(token) || (stem.length >= 4 && hay.includes(stem))) return true;
    if (token === "manzanita" || token === "manzana") return hay.includes("manzana") || hay.includes("manzanita");
    if (token === "coquita" || token === "coca" || token === "cocas") return /\bcocas?\b|\bcoquita/.test(hay);
    return hay.split(" ").some((word) => wordsAreClose(word, token) || wordsAreClose(word, stem));
  });
}

function poolFor(items: PedidoItemInput[], target: string | null): PedidoItemInput[] {
  if (!target) return items;
  const token = norm(target).split(" ").filter((word) => !LEFTOVER_SKIP.has(word)).at(-1) ?? "";
  if (token === "refresco" || token === "refrescos") return items.filter(itemIsDrink);
  return items.filter((item) => matchesTarget(item, target));
}

function sameItem(left: PedidoItemInput, right: PedidoItemInput): boolean {
  return norm(left.nombre_producto) === norm(right.nombre_producto) && norm(left.marca ?? "") === norm(right.marca ?? "");
}

function blank(source: string, re: RegExp, onMatch: (match: RegExpMatchArray) => void): string {
  return source.replace(re, (...args: unknown[]) => {
    const full = String(args[0]);
    const groups = args.slice(1, -2) as string[];
    onMatch(Object.assign([full, ...groups], { index: args.at(-2), input: source }) as RegExpMatchArray);
    return " ".repeat(full.length);
  });
}

const REMOVAL_SKIP = new Set([
  ...LEFTOVER_SKIP,
  "mal", "aparte", "error", "equivocado", "equivocaste", "equivocacion",
  "quita", "quitame", "quitar", "quitalo", "quitala", "quiteme", "quitale",
  "borra", "borrar", "borrame", "borralo", "borrala",
  "elimina", "eliminar", "eliminalo", "eliminame",
  "pedido", "nada",
  "pieza", "piezas", "litro", "litros", "lata", "latas", "bote", "botes",
  "garrafa", "garrafas",
]);

const REMOVE_VERB =
  "quiet[ao]|kita|quit[aeo]\\w*|borr(?:ar|a|ame|alo|ala|amelo|amela)?|elimina(?:r|me|lo|la|melo|mela)?|ya no quiero|ya no";
const REMOVE_STOP = "y|tambien|ademas|agrega\\w*|anade\\w*|ponle|sumale";

function removalRegex(): RegExp {
  return new RegExp(
    `\\b(?:${REMOVE_VERB})\\s+((?:el |la |los |las |un |una |al )?(?:(?!\\b(?:${REMOVE_STOP})\\b)[a-z0-9]+)(?:\\s+(?!\\b(?:${REMOVE_STOP})\\b)[a-z0-9]+){0,16})`,
    "g",
  );
}

function sinRegex(): RegExp {
  return /\bsin\s+(?:el |la |los |las |un |una )?(?!marinar\b|marinad\w*|lactosa\b)([a-z][a-z0-9]{3,}(?:\s+[a-z0-9]+){0,6})/g;
}

export function removalTokens(target: string): string[] {
  return norm(target)
    .split(" ")
    .filter((token) => token.length >= 3 && !REMOVAL_SKIP.has(token) && !/^\d+$/.test(token));
}

function scoreRemoval(item: PedidoItemInput, tokens: string[]): number {
  const hay = norm(`${item.nombre_producto} ${item.marca ?? ""} ${item.presentacion ?? ""} ${item.unidad ?? ""}`);
  let score = 0;
  for (const token of tokens) {
    const stem = token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
    if (hay.includes(token) || (stem.length >= 4 && hay.includes(stem))) {
      score += 1;
      continue;
    }
    if (hay.split(" ").some((word) => wordsAreClose(word, token) || wordsAreClose(word, stem))) score += 1;
  }
  return score;
}

/** Una sola línea: la que más se parece a todo el texto, no todas las que comparten la primera palabra. */
export function pickRemoval(items: PedidoItemInput[], target: string): { index: number | null; ambiguous: boolean } {
  const tokens = removalTokens(target);
  if (!tokens.length || tokens.every((token) => token === "pedido" || token === "nada")) {
    return { index: null, ambiguous: false };
  }
  const scored = items.map((item, index) => ({ index, score: scoreRemoval(item, tokens) }));
  const best = scored.reduce((max, row) => Math.max(max, row.score), 0);
  const floor = tokens.length >= 2 ? 2 : 1;
  if (best < floor) return { index: null, ambiguous: false };
  const winners = scored.filter((row) => row.score === best);
  if (winners.length !== 1) return { index: null, ambiguous: true };
  return { index: winners[0].index, ambiguous: false };
}

export function removalTargets(message: string): string[] {
  const text = norm(message);
  const targets: string[] = [];
  for (const re of [removalRegex(), sinRegex()]) {
    for (const match of text.matchAll(re)) {
      const target = match[1]?.trim();
      if (target && removalTokens(target).length) targets.push(target);
    }
  }
  return targets;
}

const REMOVE_VERB_RAW =
  "qu[ií]t[aeoáéó]\\w*|b[oó]rr(?:ar|a|ame|alo|ala|amelo|amela)?|elimina(?:r|me|lo|la|melo|mela)?|ya no quiero|ya no";

function removalRegexRaw(): RegExp {
  return new RegExp(
    `\\b(?:${REMOVE_VERB_RAW})\\s+((?:el |la |los |las |un |una |al )?(?:(?!\\b(?:y|tambi[eé]n|adem[aá]s|agrega\\w*|a[nñ]ade\\w*|ponle|sumale)\\b)[\\p{L}\\p{N}]+)(?:\\s+(?!\\b(?:y|tambi[eé]n|adem[aá]s|agrega\\w*|a[nñ]ade\\w*|ponle|sumale)\\b)[\\p{L}\\p{N}]+){0,16})`,
    "giu",
  );
}

function sinRegexRaw(): RegExp {
  return /\bsin\s+(?:el |la |los |las |un |una )?(?!marinar\b|marinad\w*|lactosa\b)([\p{L}][\p{L}\p{N}]{3,}(?:\s+[\p{L}\p{N}]+){0,6})/giu;
}

export function stripRemovalPhrases(message: string): string {
  return message.replace(removalRegexRaw(), " ").replace(sinRegexRaw(), " ").replace(/[ \t]+/g, " ").trim();
}

export function planCustomerEdits(message: string): EditPlan {
  const ops: EditOp[] = [];
  let rest = norm(stripBotDecorations(message));

  rest = blank(
    rest,
    /\b(?:cambial[oa]s?|cambiame|cambiale|cambia)\s+(?:el |la |los |las |un |una |unos |unas )?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\s+por\s+(?:el |la |los |las |un |una |unos |unas )?([a-z0-9]+(?:\s+[a-z0-9]+){0,4})/g,
    (match) => {
      const from = match[1]?.trim();
      const to = match[2]?.trim();
      if (from && to) ops.push({ kind: "replace", from, to });
    },
  );

  rest = blank(rest, removalRegex(), (match) => {
    const target = match[1]?.trim();
    if (target && removalTokens(target).some((token) => token !== "pedido" && token !== "nada")) {
      const verb = (match[0] ?? "").split(" ")[0] ?? "";
      const uncertain = /^(quiet|kita)/.test(verb) || /\bdigo\b/.test(target);
      const mode = uncertain ? "ask" : /^(un|una)\b/.test(target) ? "one" : "all";
      ops.push({ kind: "remove", target: target.replace(/\bdigo\b/g, "dogo"), mode });
    }
  });

  rest = blank(rest, sinRegex(), (match) => {
    const target = match[1]?.trim();
    if (target && removalTokens(target).length) ops.push({ kind: "remove", target });
  });

  rest = blank(
    rest,
    /\bcambia(?:r|me|le|lo|la)?\s+(?:el |la |los |las |un |una )?([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\s+a\s+(\d+(?:\.\d+)?)\s*(litros?|ml|kilos?|kg|gramos?|g)\b/g,
    (match) => {
      const target = match[1]?.trim();
      const unit = match[3] === "g" ? "g" : match[3];
      if (target && match[2]) ops.push({ kind: "resize", target, size: `${match[2]} ${unit}` });
    },
  );

  rest = blank(
    rest,
    /\b(?:agregale|ponle|sumale|echale|metele)\s+otr[ao]s?(?:\s+(?:dos|tres|cuatro|cinco|\d+))?\s+(?:(?:kilos?|kg|gramos?)\s+)?(?:de\s+)?([a-z][a-z0-9]{2,})/g,
    (match) => {
      const byRaw = match[0].match(/\b(dos|tres|cuatro|cinco|\d+)\b/);
      const by = byRaw ? (NUM[byRaw[1]] ?? Number(byRaw[1])) : 1;
      ops.push({ kind: "increment", target: match[1], by: Number.isFinite(by) && by > 0 ? by : 1 });
    },
  );

  rest = blank(rest, /\b(?:una|otro|otra)\s+mas(?:\s+de\s+([a-z][a-z0-9]{2,}))?/g, (match) => {
    ops.push({ kind: "increment", target: match[1]?.trim() || null, by: 1 });
  });

  rest = blank(
    rest,
    /\botr[ao]s?\s+(?!vez\b)(?:(dos|tres|cuatro|cinco|\d+)\s+)?(?:(?:kilos?|kg|gramos?)\s+)?(?:de\s+)?([a-z][a-z0-9]{2,})\b(?!\s+(?!y\b|e\b|tambien\b|ademas\b|seria\b|serian\b|seran\b|pero\b)[a-z]{3,})/g,
    (match) => {
      const by = match[1] ? (NUM[match[1]] ?? Number(match[1])) : 1;
      const target = match[2];
      if (!target || LEFTOVER_SKIP.has(target) || target === "vez") return;
      ops.push({ kind: "increment", target, by: Number.isFinite(by) && by > 0 ? by : 1 });
    },
  );

  rest = blank(
    rest,
    /\b(?:que sean|mejor sean|dejalo en|dejala en|cambialo a|cambiala a)\s+(kilo y medio|medio kilo|\d+(?:\.\d+)?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)(?:\s+(kilos?|kg|gramos?))?(?:\s+de\s+((?:arrachera|chorizo|bistec|diezmillo|costilla|refresco|coca|pepsi|papas?|hamburguesa|[a-z]{4,})(?:\s+[a-z]{3,}){0,3}))?/g,
    (match) => {
      const parsed = qtyOf(match[1]);
      ops.push({
        kind: "setQty",
        target: match[3]?.trim() || null,
        qty: parsed.qty,
        unit: unitOf(match[2], parsed.unit),
      });
    },
  );

  rest = blank(
    rest,
    /\bcambia(?:r|me|le|lo|la)?\s+(?:el |la |los |las )?(?:de\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\s+a\s+(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/g,
    (match) => {
      const target = match[1]?.trim();
      if (target && target !== "a") ops.push({ kind: "resize", target, size: match[2] });
    },
  );

  rest = blank(
    rest,
    /\b(?:cambial[oa](?:me|la|lo)?|que sea|mejor)\s+(?:a\s+)?(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/g,
    (match) => {
      ops.push({ kind: "resize", target: null, size: match[1] });
    },
  );

  const leftover = rest
    .split(" ")
    .filter((token) => token.length >= 4 && !LEFTOVER_SKIP.has(token));
  return {
    ops,
    editsOnly: ops.length > 0 && leftover.length === 0,
    remainder: rest.replace(/\s+/g, " ").trim(),
  };
}

function resizeItem(item: PedidoItemInput, size: string, catalog: CatalogPriceRow[] | null | undefined): void {
  const wanted = wantedSize(size);
  const bare = stripSize(item.nombre_producto);
  const row = (catalog ?? []).find((candidate) => {
    const name = norm(candidate.nombreProducto);
    return stripSize(candidate.nombreProducto) === bare && name.includes(wanted);
  });
  if (row) {
    item.nombre_producto = row.nombreProducto;
    return;
  }
  if (SIZE_WORDS.some((word) => norm(item.nombre_producto).includes(word))) {
    item.nombre_producto = item.nombre_producto.replace(
      /\b(chicas|chicos|chica|chico|grandes|grande|medianas|medianos|mediana|mediano|sencillas|sencillos|sencilla|sencillo|dobles|doble|triples|triple)\b/i,
      wanted,
    );
    return;
  }
  item.presentacion = wanted;
}

export function applyCustomerEdits(params: {
  prior: PedidoItemInput[];
  working?: PedidoItemInput[];
  plan: EditPlan;
  catalog?: CatalogPriceRow[] | null;
  resolveAddition?: (phrase: string) => AddedLine;
}): { items: PedidoItemInput[]; note: string | null } {
  const items = (params.working ?? params.prior).map((item) => ({ ...item }));
  const notes: string[] = [];
  const resolve = params.resolveAddition;

  const pushNew = (phrase: string, qty: number) => {
    if (items.some((item) => matchesTarget(item, phrase) || (phrase === "refresco" && itemIsDrink(item) && poolFor(items, phrase).length === 1))) {
      return;
    }
    const added = resolve?.(phrase);
    if (added?.item) {
      items.push({ ...added.item, cantidad: added.item.cantidad ?? qty });
      if (added.aside) notes.push(added.aside);
      return;
    }
    if (added?.aside) {
      notes.push(added.aside);
      return;
    }
    if (params.catalog?.length) {
      notes.push("¿Te refieres a algo del menú?");
      return;
    }
    items.push({ nombre_producto: titlePhrase(phrase), cantidad: qty });
  };

  for (const op of params.plan.ops) {
    if (op.kind !== "replace") continue;
    const donor = items.find((item) => matchesTarget(item, op.from));
    const next = items.filter((item) => !matchesTarget(item, op.from));
    items.splice(0, items.length, ...next);
    if (!items.some((item) => matchesTarget(item, op.to))) {
      const before = items.length;
      pushNew(op.to, donor?.cantidad ?? 1);
      const added = items[items.length - 1];
      if (items.length > before && added && donor) {
        if (!added.presentacion && donor.presentacion) added.presentacion = donor.presentacion;
        if (!added.unidad && donor.unidad) added.unidad = donor.unidad;
        if (added.cantidad == null && donor.cantidad != null) added.cantidad = donor.cantidad;
      }
    }
  }

  for (const op of params.plan.ops) {
    if (op.kind !== "increment") continue;
    const pool = poolFor(items, op.target);
    if (!op.target && items.length !== 1) {
      notes.push("¿Una más de cuál?");
      continue;
    }
    if (op.target && pool.length > 1) {
      notes.push("¿Una más de cuál?");
      continue;
    }
    if (pool.length === 1) {
      const current = pool[0];
      const previous = params.prior.find(
        (item) => sameItem(item, current) || (op.target != null && matchesTarget(item, op.target) && matchesTarget(current, op.target)),
      );
      if (previous) {
        const base = typeof previous.cantidad === "number" && previous.cantidad > 0 ? previous.cantidad : 1;
        current.cantidad = base + op.by;
      } else {
        current.cantidad = op.by;
      }
      continue;
    }
    if (op.target) pushNew(op.target, op.by);
  }

  for (const op of params.plan.ops) {
    if (op.kind !== "setQty") continue;
    const pool = poolFor(items, op.target);
    if (pool.length !== 1) {
      notes.push("¿De cuál cambio la cantidad?");
      continue;
    }
    pool[0].cantidad = op.qty;
    if (op.unit) pool[0].unidad = op.unit;
  }

  for (const op of params.plan.ops) {
    if (op.kind !== "resize") continue;
    const pool = poolFor(items, op.target);
    const sized = pool.filter((item) => SIZE_WORDS.some((word) => norm(`${item.nombre_producto} ${item.presentacion ?? ""}`).includes(word)));
    const chosen = pool.length === 1 ? pool : sized.length === 1 ? sized : [];
    if (chosen.length !== 1) {
      notes.push("¿Cuál cambio de tamaño?");
      continue;
    }
    const weighed = op.size.match(/^(\d+(?:\.\d+)?)\s*(kilos?|kg|gramos?|g)$/);
    if (weighed) {
      const qty = Number(weighed[1]);
      const raw = weighed[2];
      chosen[0].cantidad = qty;
      chosen[0].unidad = raw.startsWith("kilo") || raw === "kg" ? "kilo" : raw.startsWith("gram") || raw === "g" ? "gramo" : raw.startsWith("litro") ? "litro" : raw;
      if (norm(chosen[0].presentacion ?? "") === norm(op.size)) chosen[0].presentacion = null;
      continue;
    }
    resizeItem(chosen[0], op.size, params.catalog);
  }

  for (const op of params.plan.ops) {
    if (op.kind !== "remove") continue;
    const picked = pickRemoval(items, op.target);
    if (picked.ambiguous) {
      notes.push("¿Cuál quito?");
      continue;
    }
    if (picked.index == null) continue;
    const current = items[picked.index];
    const qty = typeof current.cantidad === "number" && current.cantidad > 0 ? current.cantidad : 1;
    if (op.mode === "ask") {
      notes.push(`¿Quito el ${current.nombre_producto} o dejo menos? Tienes ${qty}.`);
      continue;
    }
    if (op.mode === "one" && qty > 1) {
      current.cantidad = qty - 1;
      continue;
    }
    items.splice(picked.index, 1);
  }

  return { items, note: [...new Set(notes)].join(" ") || null };
}

/** Pregunta que quedó pendiente porque el cambio no decía de cuál producto. */
export function pendingEditNote(message: string, items: PedidoItemInput[]): string | null {
  const plan = planCustomerEdits(message);
  const notes: string[] = [];
  for (const op of plan.ops) {
    if (op.kind === "increment") {
      const pool = poolFor(items, op.target);
      if ((!op.target && items.length !== 1) || (op.target && pool.length > 1)) notes.push("¿Una más de cuál?");
    }
    if (op.kind === "setQty") {
      const pool = poolFor(items, op.target);
      if (pool.length !== 1) notes.push("¿De cuál cambio la cantidad?");
    }
    if (op.kind === "resize" && op.target == null && items.length > 1) {
      const sized = items.filter((item) =>
        SIZE_WORDS.some((word) => norm(`${item.nombre_producto} ${item.presentacion ?? ""}`).includes(word)),
      );
      if (sized.length !== 1) notes.push("¿Cuál cambio de tamaño?");
    }
    if (op.kind === "resize" && op.target) {
      const pool = poolFor(items, op.target);
      if (pool.length !== 1) notes.push("¿Cuál cambio de tamaño?");
    }
    if (op.kind === "remove" && pickRemoval(items, op.target).ambiguous) notes.push("¿Cuál quito?");
  }
  return [...new Set(notes)].join(" ") || null;
}
