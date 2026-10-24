import type { SupabaseClient } from "@supabase/supabase-js";

import { APP_CATEGORIES, categoryForStore, type AppCategoryId } from "@/lib/app/categories";
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
  query: { q: string; page: number },
): Promise<{ productos: CatalogProduct[]; total: number; necesitaBusqueda: boolean; mensaje: string | null }> {
  const page = Math.max(1, query.page);
  const q = query.q.trim();
  if (store.usaLista || store.cotizar) {
    if (q.length < 2) {
      return {
        productos: [],
        total: 0,
        necesitaBusqueda: true,
        mensaje: "Escribe el producto. Son miles y aquí se buscan de uno en uno.",
      };
    }
    try {
      const ranked = await queryListaProductos(supabase as unknown as ListaSupabase, store.id, q);
      return pageRows(ranked.map(fromLista), page, null);
    } catch (error: unknown) {
      console.error("[app] la búsqueda rankeada falló, sigo con un filtro simple", error instanceof Error ? error.message : error);
    }
  }

  let request = supabase
    .from("productos_tienda")
    .select("id, nombre_producto, precio, categoria", { count: "exact" })
    .eq("tienda_id", store.id)
    .eq("disponible", true)
    .order("nombre_producto", { ascending: true });
  if (q) request = request.ilike("nombre_producto", `%${q.replace(/[%_]/g, "")}%`);
  const from = (page - 1) * PAGE_SIZE;
  const result = await request.range(from, from + PAGE_SIZE - 1);
  if (result.error) {
    if (isMissingRelation(result.error)) {
      return { productos: [], total: 0, necesitaBusqueda: false, mensaje: MIGRACION_MENSAJE };
    }
    throw result.error;
  }
  const productos = ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    nombre: String(row.nombre_producto ?? ""),
    precio: row.precio == null ? null : Number(row.precio),
    categoria: row.categoria == null ? null : String(row.categoria),
  }));
  return { productos, total: result.count ?? productos.length, necesitaBusqueda: false, mensaje: null };
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
