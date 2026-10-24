import { matchCatalogProduct, type CatalogPriceRow } from "@/lib/catalogQuantities";

export type StoreNameLine = {
  /** Texto que se guarda en pedido_items.nombre_producto y ve la tienda. */
  nombre: string;
  /** true cuando el extra no cupo en el nombre sin romper el pareo del menú. */
  notasAparte: boolean;
};

function extrasText(extras: string[], nota: string): string {
  const parts = extras.map((item) => item.trim()).filter(Boolean);
  const note = nota.trim();
  if (note) parts.push(`nota: ${note}`);
  return parts.join(", ");
}

/**
 * El nombre de catálogo va primero, exacto, para que George y La Central
 * sigan pareando el menú. El extra se pega entre paréntesis solo si ese
 * texto sigue cayendo en el mismo producto. Si no, el nombre se queda
 * exacto y la nota sale en un segundo WhatsApp a la tienda.
 * En abarrotes no hay menú fijo: el paréntesis siempre va en el renglón.
 */
export function composeStoreItemName(
  nombreProducto: string,
  extras: string[],
  nota: string,
  catalog: CatalogPriceRow[] | null,
): StoreNameLine {
  const base = nombreProducto.trim();
  const suffix = extrasText(extras, nota);
  if (!suffix) return { nombre: base, notasAparte: false };
  const withNote = `${base} (${suffix})`;
  if (!catalog) return { nombre: withNote, notasAparte: false };
  const matched = matchCatalogProduct(catalog, withNote);
  if (matched && matched.nombreProducto.trim().toLowerCase() === base.toLowerCase()) {
    return { nombre: withNote, notasAparte: false };
  }
  return { nombre: base, notasAparte: true };
}

export function formatSeparateNotes(pedidoId: number, lines: string[]): string {
  return `📝 *Notas del pedido #${pedidoId}*\n\n${lines.join("\n")}\n\nSon extras del cliente. El producto de arriba es el del menú.`;
}
