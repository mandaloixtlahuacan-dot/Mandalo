import { nicheIdForCategoria, type StoreNicheId } from "@/lib/customerUx";

/** Las tres entradas fijas de la app. El id es el nicho que ya usa el bot. */
export const APP_CATEGORIES = [
  {
    id: "abarrotes",
    titulo: "Abarrotes",
    detalle: "Mini Super Peke's",
    cotizarPorDefecto: true,
  },
  {
    id: "carnicerias",
    titulo: "Carnicería",
    detalle: "La Central",
    cotizarPorDefecto: false,
  },
  {
    id: "restaurantes",
    titulo: "Restaurantes",
    detalle: "George y Conyorch",
    cotizarPorDefecto: false,
  },
] as const;

export type AppCategoryId = (typeof APP_CATEGORIES)[number]["id"];

const NAME_HINTS: Array<{ id: AppCategoryId; pattern: RegExp }> = [
  { id: "abarrotes", pattern: /peke/i },
  { id: "carnicerias", pattern: /central/i },
  { id: "restaurantes", pattern: /george|conyorch/i },
];

/**
 * Primero la categoría guardada en `tiendas.categoria` (la misma regla del bot).
 * Si viene vacía, el nombre conocido alcanza: Peke's, La Central, George, Conyorch.
 */
export function categoryForStore(store: { nombre: string; categoria: string | null }): AppCategoryId | null {
  const fromCategoria = nicheIdForCategoria(store.categoria);
  if (fromCategoria === "abarrotes" || fromCategoria === "carnicerias" || fromCategoria === "restaurantes") {
    return fromCategoria;
  }
  if (fromCategoria) return null;
  const hint = NAME_HINTS.find((item) => item.pattern.test(store.nombre));
  return hint?.id ?? null;
}

export function categoryTitle(id: StoreNicheId | AppCategoryId): string {
  return APP_CATEGORIES.find((item) => item.id === id)?.titulo ?? id;
}
