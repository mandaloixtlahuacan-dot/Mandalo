/**
 * Carga la lista de abarrotes de una tienda.
 * Por defecto solo imprime el diff. Escribe con --apply (hace falta la migración
 * 20261009_productos_lista_abarrotes.sql ya corrida en Supabase).
 *
 *   npx tsx scripts/import-store-products.ts 1 ./lista.csv
 *   npx tsx scripts/import-store-products.ts 1 ./lista.txt --apply
 *
 * CSV con encabezado: nombre,marca,presentacion,categoria,alias
 * alias se separa con | o ;
 * Texto plano: un producto por línea, o nombre | marca | presentacion | categoria
 */
import { readFileSync } from "node:fs";
import { parseStoreProductText, type ListaProducto } from "../src/lib/storeProductList";

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const positional = process.argv.slice(2).filter((item) => !item.startsWith("--"));
  const tiendaId = Number(arg("tienda") ?? positional[0]);
  const file = arg("file") ?? positional[1];
  const apply = process.argv.includes("--apply");
  if (!Number.isFinite(tiendaId) || tiendaId <= 0 || !file) {
    console.error("Uso: npx tsx scripts/import-store-products.ts <tiendaId> <archivo.csv|txt> [--apply]");
    process.exit(1);
  }
  const rows = parseStoreProductText(readFileSync(file, "utf8"));
  console.log(`Tienda ${tiendaId}. ${rows.length} productos en el archivo. ${apply ? "SE VA A ESCRIBIR." : "Dry-run, no se escribe."}`);
  for (const row of rows) {
    console.log(`- ${[row.nombre, row.marca, row.presentacion].filter(Boolean).join(" · ")}${row.alias?.length ? ` (${row.alias.join(", ")})` : ""}`);
  }
  if (!apply) return;

  const { getSupabaseAdmin } = await import("../src/lib/supabaseAdmin");
  const supabase = getSupabaseAdmin();
  const existing = await supabase
    .from("productos_tienda")
    .select("id, nombre_producto, marca, presentacion")
    .eq("tienda_id", tiendaId);
  if (existing.error) throw existing.error;
  const current = (existing.data ?? []) as Array<{ id: number; nombre_producto: string; marca: string | null; presentacion: string | null }>;
  const key = (nombre: string, marca?: string | null, presentacion?: string | null) =>
    `${nombre.trim().toLowerCase()}|${(marca ?? "").trim().toLowerCase()}|${(presentacion ?? "").trim().toLowerCase()}`;
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const match = current.find((item) => key(item.nombre_producto, item.marca, item.presentacion) === key(row.nombre, row.marca, row.presentacion));
    const payload = {
      tienda_id: tiendaId,
      nombre_producto: row.nombre,
      marca: row.marca || null,
      presentacion: row.presentacion || null,
      categoria: row.categoria || null,
      alias: row.alias ?? [],
      disponible: true,
    };
    if (match) {
      const result = await supabase.from("productos_tienda").update(payload).eq("id", match.id);
      if (result.error) throw result.error;
      updated += 1;
    } else {
      const result = await supabase.from("productos_tienda").insert(payload);
      if (result.error) throw result.error;
      inserted += 1;
    }
  }
  const flag = await supabase.from("tiendas").update({ usa_lista_productos: true }).eq("id", tiendaId);
  if (flag.error) {
    console.error("No se pudo prender usa_lista_productos. ¿Ya corriste la migración?", flag.error.message);
  }
  console.log(`Listo. Nuevos: ${inserted}. Actualizados: ${updated}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

export type { ListaProducto };
