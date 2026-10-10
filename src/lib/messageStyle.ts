/**
 * Presentación de los mensajes de WhatsApp. No decide el pedido:
 * solo cómo se ve la línea y cómo se ignoran palomitas o emojis
 * si el cliente copia una línea del bot.
 */

export function normalizeProductLabel(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type EmojiRule = { emoji: string; test: RegExp };

// El orden importa: "papas gajo" es 🍟, no verdura; "manzanita" es refresco, no fruta.
const PRODUCT_EMOJI_RULES: EmojiRule[] = [
  { emoji: "🌭", test: /\b(hot\s*dogs?|hotdogs?|dogos?|dogo|salchichas?)\b/ },
  { emoji: "🍔", test: /\b(hamburguesas?|burger)\b/ },
  { emoji: "🍟", test: /\b(papas?\s+gajo|papas?\s+a\s+la\s+francesa|papas?\s+francesas?|salchi\s*locos)\b/ },
  { emoji: "🍗", test: /\b(boneless|alitas)\b/ },
  { emoji: "🌮", test: /\bpastor\b/ },
  { emoji: "🔥", test: /\b(carbon|firo|fino)\b/ },
  { emoji: "🍜", test: /\b(maruchan|maruchanes|ramen|sopas?|instantanea)\b/ },
  { emoji: "🥤", test: /\b(refrescos?|refa|coca|cocas|coquita|pepsi|sprite|fanta|sidral|squirt|seven|mirinda|manzanitas?|red\s*bull|redbull|monster|agua|aguas|jugo|jugos|horchata|jamaica|tamarindo)\b/ },
  { emoji: "🧴", test: /\b(cloro|cloralex|pinol|fabuloso|limpiador|limpiadores|suavitel|fab)\b/ },
  { emoji: "🧼", test: /\b(jabon|jabones|detergente|zote|ariel|roma|ace)\b/ },
  { emoji: "🧻", test: /\b(papel|higienico|higienicos|servilletas?|sanitas)\b/ },
  { emoji: "🥛", test: /\bleches?\b/ },
  { emoji: "🥚", test: /\bhuevos?\b/ },
  { emoji: "🍞", test: /\b(pan|bolillos?|teleras?|birotes?)\b/ },
  { emoji: "🫓", test: /\btortillas?\b/ },
  { emoji: "🍌", test: /\b(frutas?|platanos?|naranjas?|limones?|manzanas?|sandia|melon|pina|mangos?|papayas?|guayaba|uvas?)\b/ },
  { emoji: "🍅", test: /\b(verduras?|jitomates?|tomates?|cebollas?|cebollin|chiles?|lechugas?|cilantro|perejil|zanahorias?|pepinos?|aguacates?|ajos?|calabazas?|elotes?|repollo|coles?|brocoli|chayotes?|ejotes?|nopales?|papas?)\b/ },
  { emoji: "🧀", test: /\b(jamon|queso|quesos|lacteo|lacteos|crema)\b/ },
  { emoji: "🫙", test: /\b(salsas?|salsa|catsup|ketchup|mayonesa|mostaza|aceite)\b/ },
  { emoji: "🥩", test: /\b(carne|carnes|bistec|bisteces|diezmillo|pulpa|costilla|costillas|res|puerco|arrachera|ribeye|chamberete|cocido|peinesillo|molida|chorizos?)\b/ },
];

const DEFAULT_PRODUCT_EMOJI = "🛍️";

/** Un emoji por producto, según el nombre y, si viene, la categoría. */
export function productEmoji(name: string, category?: string | null): string {
  const blob = normalizeProductLabel(`${category ?? ""} ${name}`);
  if (!blob) return DEFAULT_PRODUCT_EMOJI;
  for (const rule of PRODUCT_EMOJI_RULES) {
    if (rule.test.test(blob)) return rule.emoji;
  }
  return DEFAULT_PRODUCT_EMOJI;
}

/** Varios productos o opciones, cada uno en su línea y con aire entre ellos. */
export function joinBlocks(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join("\n\n");
}

/** Línea confirmada: palomita, un emoji y el producto en negrita. */
export function formatCheckedLine(text: string, category?: string | null): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return clean;
  const body = clean.includes("*") ? clean : `*${clean}*`;
  return `✅ ${productEmoji(clean, category)} ${body}`;
}

export function formatNameQtyLine(name: string, cantidad: number | null, hideQty: boolean): string {
  const label = name.trim() || "producto";
  const text = cantidad == null || hideQty ? label : `${label} x${cantidad}`;
  return formatCheckedLine(text, label);
}

export function formatCheckedLines(lines: string[]): string {
  return joinBlocks(
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("✅") ? line : formatCheckedLine(line.replace(/^[-•]\s*/, "")))),
  );
}

/**
 * Si el cliente copia «✅ 🥤 Coca-Cola 2 litros», el parser ve el producto,
 * no la palomita ni el emoji. El *negrita* de WhatsApp también se quita.
 */
export function stripBotDecorations(text: string): string {
  return String(text ?? "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

/** Parte una pregunta larga en bloques cortos, sin cambiar las palabras. */
export function presentFollowUp(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return flat;
  const emojiMatch = flat.match(/(\p{Extended_Pictographic}+)$/u);
  const emoji = emojiMatch?.[1] ?? "";
  let body = emoji ? flat.slice(0, -emoji.length).trim() : flat;
  const followMatch = body.match(/(Con eso ya (?:la|lo|los|las) anoto y seguimos el mandado\.)$/);
  const follow = followMatch?.[1] ?? "";
  if (follow) body = body.slice(0, -follow.length).trim();
  const exampleMatch = body.match(/(Por ejemplo .+)$/);
  const example = exampleMatch?.[1] ?? "";
  if (example) body = body.slice(0, -example.length).trim();
  const lines = [emoji ? `${emoji} *${body}*` : `*${body}*`];
  if (example) lines.push("", example);
  if (follow) lines.push("", follow);
  return lines.join("\n");
}
