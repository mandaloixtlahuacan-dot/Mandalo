import type { SupabaseClient } from "@supabase/supabase-js";

import { APP_CATEGORIES, categoryForStore, type AppCategoryId } from "@/lib/app/categories";
import { classifyShelf, isShelfId, OTROS_CATEGORIA_LABELS, shelfOrFilter, type ShelfId } from "@/lib/app/shelves";
import { isMissingRelation, MIGRACION_MENSAJE, MIGRACION_PENDIENTE } from "@/lib/app/dbError";
import {
  checkTiendaSchedule,
  describeHorarioTienda,
  parseDiasCerrado,
} from "@/lib/services/businessHours";
import { queryListaProductos, type ListaProductoRow, type ListaSupabase } from "@/lib/repositories/pedidoRepositoryV2";

export const PAGE_SIZE = 20;

export type AppStoreCard = {
  id: number;
  nombre: string;
  categoriaId: AppCategoryId;
  abierta: boolean;
  abreTexto: string;
  horarioTexto: string;
  cotizar: boolean;
  usaLista: boolean;
};

export type AppCategoryBlock = {
  id: AppCategoryId;
  titulo: string;
  detalle: string;
  tiendas: AppStoreCard[];
};

export type CatalogProduct = {
  id: number;
  nombre: string;
  precio: number | null;
  categoria: string | null;
  anaquel: ShelfId;
};

type StoreRow = {
  id?: unknown;
  nombre?: unknown;
  categoria?: unknown;
  telefono?: unknown;
  activa?: unknown;
  hora_apertura?: unknown;
  hora_cierre?: unknown;
  dias_cerrado?: unknown;
  horario_por_dia?: unknown;
  usa_catalogo_fijo?: unknown;
  usa_lista_productos?: unknown;
};

export async function listAppCategories(supabase: SupabaseClient): Promise<AppCategoryBlock[]> {
  const { data, error } = await supabase
    .from("tiendas")
    .select("id, nombre, categoria, telefono, activa, hora_apertura, hora_cierre, dias_cerrado, horario_por_dia, usa_catalogo_fijo, usa_lista_productos")
    .eq("activa", true)
    .order("nombre", { ascending: true })
    .limit(100);
  if (error) throw error;

  const grouped = new Map<AppCategoryId, AppStoreCard[]>(APP_CATEGORIES.map((item) => [item.id, []]));
  for (const row of (data ?? []) as StoreRow[]) {
    const card = toCard(row);
    if (!card) continue;
    grouped.get(card.categoriaId)?.push(card);
  }

  return APP_CATEGORIES.map((item) => ({
    id: item.id,
    titulo: item.titulo,
    detalle: item.detalle,
    tiendas: grouped.get(item.id) ?? [],
  }));
}

export async function getAppStore(supabase: SupabaseClient, tiendaId: number): Promise<AppStoreCard | null> {
  const { data, error } = await supabase
    .from("tiendas")
    .select("id, nombre, categoria, telefono, activa, hora_apertura, hora_cierre, dias_cerrado, horario_por_dia, usa_catalogo_fijo, usa_lista_productos")
    .eq("id", tiendaId)
    .maybeSingle();
  if (error) throw error;
  const card = toCard(data as StoreRow | null);
  if (!card || data?.activa === false) return null;
  return card;
}

export async function searchStoreProducts(
  supabase: SupabaseClient,
  store: AppStoreCard,
  query: { q: string; page: number; anaquel?: string | null },
): Promise<{ productos: CatalogProduct[]; total: number; necesitaBusqueda: boolean; mensaje: string | null; anaquel: ShelfId | null }> {
  const page = Math.max(1, query.page);
  const q = query.q.trim();
  const anaquel = store.usaLista && isShelfId(query.anaquel) ? query.anaquel : null;
  if (store.usaLista || store.cotizar) {
    if (q.length >= 2) {
      try {
        const ranked = await queryListaProductos(supabase as unknown as ListaSupabase, store.id, q);
        const rows = ranked.map(fromLista).filter((row) => !anaquel || row.anaquel === anaquel);
        return { ...pageRows(rows, page, null), anaquel };
      } catch (error: unknown) {
        console.error("[app] la búsqueda rankeada falló, sigo con un filtro simple", error instanceof Error ? error.message : error);
      }
    } else if (!anaquel) {
      return {
        productos: [],
        total: 0,
        necesitaBusqueda: true,
        mensaje: "Elige un anaquel o escribe el producto.",
        anaquel: null,
      };
    }
  }

  let request = supabase
    .from("productos_tienda")
    .select("id, nombre_producto, precio, categoria", { count: "exact" })
    .eq("tienda_id", store.id)
    .eq("disponible", true);
  if (anaquel === "otros") request = request.in("categoria", OTROS_CATEGORIA_LABELS);
  if (anaquel && anaquel !== "otros") {
    const filter = shelfOrFilter(anaquel);
    if (filter) request = request.or(filter);
  }
  request = request.order("nombre_producto", { ascending: true });
  if (q) request = request.ilike("nombre_producto", `%${q.replace(/[%_]/g, "")}%`);
  const from = (page - 1) * PAGE_SIZE;
  const result = await request.range(from, from + PAGE_SIZE - 1);
  if (result.error) {
    if (isMissingRelation(result.error)) {
      return { productos: [], total: 0, necesitaBusqueda: false, mensaje: MIGRACION_MENSAJE, anaquel };
    }
    throw result.error;
  }
  const productos = ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => toProduct(row));
  const visibles = anaquel ? productos.filter((row) => row.anaquel === anaquel) : productos;
  const mensaje = anaquel === "otros" ? "Otros es farmacia, desechables y lo que no cayó en un anaquel. Si buscas por nombre, se afina." : null;
  return { productos: visibles, total: result.count ?? visibles.length, necesitaBusqueda: false, mensaje, anaquel };
}

function pageRows(
  rows: CatalogProduct[],
  page: number,
  mensaje: string | null,
): { productos: CatalogProduct[]; total: number; necesitaBusqueda: boolean; mensaje: string | null } {
  const start = (page - 1) * PAGE_SIZE;
  return {
    productos: rows.slice(start, start + PAGE_SIZE),
    total: rows.length,
    necesitaBusqueda: false,
    mensaje,
  };
}

function fromLista(row: ListaProductoRow): CatalogProduct {
  return {
    id: row.id,
    nombre: row.nombreProducto,
    precio: row.precio,
    categoria: row.categoria,
    anaquel: classifyShelf(row.nombreProducto, row.categoria),
  };
}

function toProduct(row: Record<string, unknown>): CatalogProduct {
  const nombre = String(row.nombre_producto ?? "");
  const categoria = row.categoria == null ? null : String(row.categoria);
  return {
    id: Number(row.id),
    nombre,
    precio: row.precio == null ? null : Number(row.precio),
    categoria,
    anaquel: classifyShelf(nombre, categoria),
  };
}

function toCard(row: StoreRow | null): AppStoreCard | null {
  if (!row) return null;
  const id = Number(row.id);
  const nombre = String(row.nombre ?? "").trim();
  const telefono = String(row.telefono ?? "").trim();
  if (!Number.isInteger(id) || id <= 0 || !nombre || !telefono) return null;
  if (row.activa !== true) return null;
  const categoriaId = categoryForStore({ nombre, categoria: row.categoria == null ? null : String(row.categoria) });
  if (!categoriaId) return null;
  const horaApertura = row.hora_apertura == null ? null : String(row.hora_apertura);
  const horaCierre = row.hora_cierre == null ? null : String(row.hora_cierre);
  const schedule = checkTiendaSchedule({
    horaApertura,
    horaCierre,
    diasCerrado: parseDiasCerrado(row.dias_cerrado),
    horarioPorDia: row.horario_por_dia,
  });
  const usaCatalogo = row.usa_catalogo_fijo === true;
  return {
    id,
    nombre,
    categoriaId,
    abierta: schedule.withinSchedule,
    abreTexto: schedule.withinSchedule ? "" : schedule.abreTexto,
    horarioTexto: describeHorarioTienda({
      horaApertura,
      horaCierre,
      diasCerrado: parseDiasCerrado(row.dias_cerrado),
      horarioPorDia: row.horario_por_dia,
    }),
    cotizar: !usaCatalogo,
    usaLista: row.usa_lista_productos === true || categoriaId === "abarrotes",
  };
}

export { MIGRACION_PENDIENTE };
