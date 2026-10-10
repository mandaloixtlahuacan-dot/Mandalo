import type { CatalogMode, CatalogRow, CatalogSnapshot, RawCatalogRow, StoreProfile } from "@/lib/catalogOrder/types";
import { fold, tokens } from "@/lib/catalogOrder/text";

const DRINK_SPLIT = /[,y]/;

function variantsFromName(name: string): { searchName: string; variants: string[] } {
  const match = name.match(/^(.*)\(([^)]+)\)\s*$/);
  if (!match) return { searchName: name.trim(), variants: [] };
  const variants = match[2]
    .split(/,|\by\b|\bo\b/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 1 && !/^o$/.test(fold(part)));
  return { searchName: match[1].trim(), variants };
}

function familyOf(name: string): { family: string; size: string | null } {
  const folded = fold(name);
  const piece = folded.match(/\b(\d+)\s*piezas?\b/);
  const sizeWord = folded.match(/\b(chica|grande)\b/);
  const family = folded
    .replace(/\b(chica|grande)\b/g, " ")
    .replace(/\bmarinad[oa]s?\b/g, " ")
    .replace(/\b\d+\s*piezas?\b/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const size = sizeWord?.[1] ?? (piece ? piece[1] : null);
  return { family, size };
}

function defaultUnit(profile: StoreProfile, categoria: string | null): "pz" | "kg" {
  if (profile === "carniceria" && fold(categoria ?? "") !== "extras") return "kg";
  return "pz";
}

/** Frases que el pueblo usa y que no siempre vienen en la columna alias. */
const SEEDED: Record<string, string[]> = {
  peinesillo: ["peinecillo", "peine cillo", "peinesillo", "peine"],
  diezmillo: ["diesmillo", "diez millo", "10 millo", "diezmillo", "dies millo"],
  "pulpa de puerco": ["pura de puerco", "pura de cerdo", "pulpa de cerdo", "pulpa"],
  "arrachera marinada": ["arachera", "arrachera", "arrachera marinada"],
  chamberete: ["chambarete", "chamberete"],
  "ribeye de res con hueso": ["rib eye", "ribeye", "ribeye de res"],
  "carbon fino": ["firo", "carbon", "carbones", "carbon fino", "bolsa de carbon", "carbon firo"],
  "salsa bbq": ["barbecue", "salsa barbecue", "bbq", "salsa bbq"],
  "salsa hot wings": ["salsa de alitas", "hot wings", "salsa hot wings"],
  "carne de puerco al pastor": ["pastor", "carne al pastor", "al pastor"],
  "dogo clasico": ["jocho", "jochos", "hot dog", "hotdog", "clasico", "clasicos", "dogo clasico"],
  dogoburguer: ["dogoburger", "dogo burger", "dogo burguer", "dogoburguer"],
  pizzadogo: ["pizza dogo", "pizzadogo"],
  refresco: ["manzanita", "manzanitas"],
  doridogo: ["dori dogo", "doridogo"],
  salchilocos: ["salchi locos", "salchilocas", "salchilocas"],
  "dedos de queso 6 piezas": ["dedos de keso", "dedos de queso", "media docena de dedos"],
  "boneless 10 piezas": ["boneles", "boneless"],
  "quesadilla quesaburra": ["quesaburra"],
  "quesadilla burrita": ["burrita"],
  "papas gajo 315g": ["papas gajos", "papas gajo"],
  "papas a la francesa 300g": ["papas a la francesa", "papas francesa", "francesa"],
};

function seededAliases(name: string): string[] {
  const key = fold(name);
  const found = Object.entries(SEEDED).find(([seed]) => key === seed || key.includes(seed));
  return found ? found[1] : [];
}

export function buildCatalog(
  rows: RawCatalogRow[],
  profile: StoreProfile,
  mode: CatalogMode = "priced",
): CatalogSnapshot {
  const ordered = rows
    .filter((row) => row.disponible !== false && Number.isFinite(row.id) && row.nombreProducto.trim())
    .slice()
    .sort((a, b) => a.id - b.id);

  const built: CatalogRow[] = ordered.map((row) => {
    const { searchName, variants } = variantsFromName(row.nombreProducto.trim());
    const { family, size } = familyOf(searchName);
    const columnAlias = (row.alias ?? []).map((item) => String(item).trim()).filter(Boolean);
    return {
      id: row.id,
      name: row.nombreProducto.trim(),
      precio: row.precio,
      categoria: row.categoria ?? null,
      alias: [...columnAlias, ...seededAliases(searchName)],
      disponible: row.disponible !== false,
      unit: defaultUnit(profile, row.categoria ?? null),
      family,
      size,
      variants,
      searchName,
    };
  });

  const familyCount = new Map<string, number>();
  for (const row of built) familyCount.set(row.family, (familyCount.get(row.family) ?? 0) + 1);

  return {
    profile,
    mode,
    rows: built,
    byId: new Map(built.map((row) => [row.id, row])),
  };
}

export function familyRows(catalog: CatalogSnapshot, family: string): CatalogRow[] {
  return catalog.rows.filter((row) => row.family === family);
}

export function isSizeFamily(catalog: CatalogSnapshot, family: string): boolean {
  return familyRows(catalog, family).length > 1;
}

export function rowByFoldedName(catalog: CatalogSnapshot, name: string): CatalogRow | null {
  const key = fold(name);
  return catalog.rows.find((row) => fold(row.name) === key || fold(row.searchName) === key) ?? null;
}

export function contentTokens(value: string): string[] {
  return tokens(value);
}
