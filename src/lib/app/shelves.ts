/**
 * Anaqueles de Peke's. Reglas fijas, sin IA.
 *
 * Primero el nombre (incluye abreviaturas reales del catálogo: Sh shampoo,
 * Ds desodorante, Det detergente, Jt jabón de tocador). Si el nombre no cae
 * en ninguna, se usa `productos_tienda.categoria` cuando esa etiqueta ya
 * está mapeada. Lo demás queda en Otros (farmacia, desechables, cables).
 *
 * La columna `categoria_app` está propuesta y no se lee: hasta que Víctor
 * la llene, esto se calcula en cada consulta.
 */

export const SHELF_IDS = [
  "bebidas",
  "botanas",
  "dulces",
  "lacteos",
  "panaderia",
  "despensa",
  "sazonadores",
  "enlatados",
  "limpieza",
  "higiene",
  "bebes",
  "mascotas",
  "otros",
] as const;

export type ShelfId = (typeof SHELF_IDS)[number];

export type ShelfVisual = {
  id: ShelfId;
  titulo: string;
  icono: string;
};

export const PEKES_SHELVES: ShelfVisual[] = [
  { id: "bebidas", titulo: "Bebidas", icono: "🥤" },
  { id: "botanas", titulo: "Botanas", icono: "🍿" },
  { id: "dulces", titulo: "Dulces", icono: "🍬" },
  { id: "lacteos", titulo: "Lácteos", icono: "🥛" },
  { id: "panaderia", titulo: "Panadería", icono: "🍞" },
  { id: "despensa", titulo: "Despensa", icono: "🛒" },
  { id: "sazonadores", titulo: "Sazonadores", icono: "🧂" },
  { id: "enlatados", titulo: "Enlatados", icono: "🫙" },
  { id: "limpieza", titulo: "Limpieza", icono: "🧹" },
  { id: "higiene", titulo: "Higiene", icono: "🧴" },
  { id: "bebes", titulo: "Bebés", icono: "🍼" },
  { id: "mascotas", titulo: "Mascotas", icono: "🐾" },
  { id: "otros", titulo: "Otros", icono: "📦" },
];

type NameRule = { id: Exclude<ShelfId, "otros">; prefixes: string[]; words: string[]; includes: string[] };

/** Orden de especificidad. No es el orden de las pestañas. */
const NAME_RULES: NameRule[] = [
  { id: "bebes", prefixes: [], words: ["panal", "bebe", "bebes", "gerber", "bbtips", "ricitos"], includes: ["huggies", "kleen bebe"] },
  { id: "mascotas", prefixes: [], words: ["perro", "gato", "mascota", "ganador", "minino", "whiskas", "pedigree"], includes: ["dog chow", "cat chow"] },
  {
    id: "bebidas",
    prefixes: ["jugo"],
    words: ["coca", "pepsi", "agua", "jugo", "monster", "cerveza", "vino", "sidral", "squirt", "fanta", "boing", "jumex", "ciel", "nescafe", "cafe", "zuko", "tang"],
    includes: ["coca cola", "powerade", "gatorade", "fuzetea", "del valle", "electropura", "bonafont", "topo chico", "red bull", "refresco"],
  },
  {
    id: "botanas",
    prefixes: [],
    words: ["takis", "sabritas", "ruffles", "doritos", "papas", "barcel", "cheetos", "fritos"],
    includes: ["totopos", "tostitos", "cacahuate", "palomita", "crujitos"],
  },
  {
    id: "dulces",
    prefixes: ["gall", "ch", "bon"],
    words: ["chocolate", "dulce", "gomita", "paleta", "galleta", "galletas", "marias", "oreo", "halls", "chicle", "nito", "helado", "holanda", "gamesa", "marinela"],
    includes: ["chupa chups", "bon o bon", "jelly bean", "ricolino", "mazapan"],
  },
  {
    id: "higiene",
    prefixes: ["sh", "ds", "jt", "jb", "ac", "jl", "cp", "pd", "hig", "th"],
    words: ["shampoo", "desodorante", "jabon", "dove", "saba", "kotex", "nivea", "jergens", "hinds", "perfume", "gillette"],
    includes: ["pasta dental", "papel higien", "cepillo dental", "gel de afeit", "micelar"],
  },
  {
    id: "limpieza",
    prefixes: ["det", "st", "lp"],
    words: ["cloro", "pinol", "ariel", "persil", "downy", "vanish", "axion", "harpic", "fabuloso", "lysol"],
    includes: ["suavizante", "lavatrast", "aromatizante", "air wick", "maestro limpio", "cloralex", "bolsa para basura"],
  },
  {
    id: "lacteos",
    prefixes: ["crema"],
    words: ["leche", "yogurt", "yogur", "oikos", "queso", "mantequilla", "lala", "yoplait", "danone", "yakult", "kefir"],
    includes: ["media crema", "crema lala", "crema batida"],
  },
  {
    id: "panaderia",
    prefixes: ["pan"],
    words: ["bimbo", "tortilla", "sandwich", "bolillo", "tostada", "pan", "muffin"],
    includes: ["tia rosa"],
  },
  {
    id: "sazonadores",
    prefixes: [],
    words: ["oregano", "comino", "pimienta", "canela", "sal", "knorr", "maggi", "achiote"],
    includes: ["sazonador", "consome", "condimento"],
  },
  { id: "enlatados", prefixes: ["atun"], words: ["atun", "sardina"], includes: ["enlatad"] },
  {
    id: "despensa",
    prefixes: ["sopa", "ssa"],
    words: ["arroz", "frijol", "frijoles", "aceite", "azucar", "harina", "sopa", "fideo", "pasta", "salsa", "avena", "miel", "vinagre", "mole"],
    includes: ["mayonesa", "catsup", "cereal"],
  },
];

const CATEGORIA_FALLBACK: Record<string, ShelfId> = {
  dulceria: "dulces",
  galletas: "dulces",
  "harinas y galletas": "dulces",
  ricolino: "dulces",
  gamesa: "dulces",
  holanda: "dulces",
  marinela: "dulces",
  mondelez: "dulces",
  "flanes y gelatinas": "dulces",
  bebidas: "bebidas",
  "vinos y licores": "bebidas",
  "coca cola": "bebidas",
  cerveza: "bebidas",
  pepsi: "bebidas",
  jugos: "bebidas",
  te: "bebidas",
  "cafes y chocolates": "bebidas",
  lacteos: "lacteos",
  lala: "lacteos",
  danone: "lacteos",
  refrigerados: "lacteos",
  sabritas: "botanas",
  barcel: "botanas",
  botana: "botanas",
  botanas: "botanas",
  bimbo: "panaderia",
  "tia rosa": "panaderia",
  pan: "panaderia",
  panque: "panaderia",
  "el panque": "panaderia",
  tostadas: "panaderia",
  "la integral": "panaderia",
  especies: "sazonadores",
  sazonadores: "sazonadores",
  condimentos: "sazonadores",
  "chiles y semillas": "sazonadores",
  enlatados: "enlatados",
  "san marcos": "enlatados",
  "pastas y consome": "despensa",
  salsas: "despensa",
  aceites: "despensa",
  cereales: "despensa",
  granos: "despensa",
  aderezos: "despensa",
  endulsantes: "despensa",
  "sopa intantanea": "despensa",
  fud: "despensa",
  verdura: "despensa",
  "carnes frias": "despensa",
  detergentes: "limpieza",
  "suavizantes de telas": "limpieza",
  "limpiadores de piso": "limpieza",
  blanqueadores: "limpieza",
  "lavatrastes liquido": "limpieza",
  "lavatrastes polvo": "limpieza",
  aromatizantes: "limpieza",
  "velas/aromatizantes": "limpieza",
  insecticidas: "limpieza",
  bano: "limpieza",
  banos: "limpieza",
  "javon en polvo y liq": "limpieza",
  "higiene y belleza": "higiene",
  "shampoo y acondicion": "higiene",
  perfumeria: "higiene",
  "jabon de barra y ban": "higiene",
  higienicos: "higiene",
  desodorantes: "higiene",
  "desodorantes y crema": "higiene",
  bebes: "bebes",
  panales: "bebes",
  mascotas: "mascotas",
};

/** Etiquetas tal como vienen en `productos_tienda.categoria`, para filtrar Otros. */
export const OTROS_CATEGORIA_LABELS = [
  "farmacia",
  "medicina y salud",
  "desechables",
  "jarceria",
  "papeleria",
  "cigarros",
  "cables y cargadores",
  "otros",
  "otras",
  "ofertas",
  "cajas",
  "recargas",
];

const FALLBACK_LABELS: Record<ShelfId, string[]> = {
  bebidas: ["bebidas", "vinos y licores", "coca cola", "cerveza", "pepsi", "jugos", "te", "cafes y chocolates"],
  botanas: ["sabritas", "barcel", "botana", "botanas"],
  dulces: ["dulceria", "galletas", "harinas y galletas", "Ricolino", "gamesa", "holanda", "marinela", "mondelez", "flanes y gelatinas"],
  lacteos: ["lacteos", "Lala", "danone", "refrigerados"],
  panaderia: ["bimbo", "tia rosa", "pan", "panque", "el panque", "tostadas", "la integral"],
  despensa: ["pastas y consome", "salsas", "aceites", "cereales", "granos", "aderezos", "endulsantes", "sopa intantanea", "fud", "verdura", "carnes frias"],
  sazonadores: ["especies", "sazonadores", "condimentos", "chiles y semillas"],
  enlatados: ["enlatados", "san marcos"],
  limpieza: ["detergentes", "suavizantes de telas", "limpiadores de piso", "blanqueadores", "lavatrastes liquido", "lavatrastes polvo", "aromatizantes", "velas/aromatizantes", "insecticidas", "baño", "baños", "javon en polvo y liq"],
  higiene: ["higiene y belleza", "shampoo y acondicion", "perfumeria", "jabon de barra y bañ", "higienicos", "desodorantes", "desodorantes y crema"],
  bebes: ["bebes", "pañales", "PAÑales"],
  mascotas: ["mascotas"],
  otros: OTROS_CATEGORIA_LABELS,
};

export function foldShelfText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isShelfId(value: string | null | undefined): value is ShelfId {
  return (SHELF_IDS as readonly string[]).includes(String(value ?? ""));
}

export function shelfVisual(id: ShelfId): ShelfVisual {
  return PEKES_SHELVES.find((item) => item.id === id) ?? PEKES_SHELVES[PEKES_SHELVES.length - 1];
}

export function classifyShelf(nombre: string, categoria?: string | null): ShelfId {
  const name = foldShelfText(nombre);
  const padded = ` ${name} `;
  for (const rule of NAME_RULES) {
    if (rule.prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix} `))) return rule.id;
    if (rule.words.some((word) => padded.includes(` ${foldShelfText(word)} `))) return rule.id;
    if (rule.includes.some((piece) => name.includes(foldShelfText(piece)))) return rule.id;
  }
  const stored = foldShelfText(categoria ?? "");
  if (stored && CATEGORIA_FALLBACK[stored]) return CATEGORIA_FALLBACK[stored];
  return "otros";
}

/** Filtro PostgREST `or` para hojear un anaquel sin bajar los 12,500 nombres. */
export function shelfOrFilter(id: ShelfId): string | null {
  if (id === "otros") return null;
  const rule = NAME_RULES.find((item) => item.id === id);
  const parts: string[] = [];
  for (const label of FALLBACK_LABELS[id]) parts.push(`categoria.eq.${quoteOr(label)}`);
  for (const prefix of rule?.prefixes ?? []) parts.push(`nombre_producto.ilike.${quoteOr(`${prefix} *`)}`);
  for (const word of rule?.words ?? []) {
    if (word.length < 4) continue;
    parts.push(`nombre_producto.ilike.${quoteOr(`* ${word} *`)}`);
    parts.push(`nombre_producto.ilike.${quoteOr(`${word} *`)}`);
  }
  for (const piece of rule?.includes ?? []) {
    if (piece.length < 4) continue;
    parts.push(`nombre_producto.ilike.${quoteOr(`*${piece}*`)}`);
  }
  return parts.join(",");
}

function quoteOr(value: string): string {
  if (/[*,.()"\\\s]/.test(value)) return `"${value.replace(/"/g, "")}"`;
  return value;
}
