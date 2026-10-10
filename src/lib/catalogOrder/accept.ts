/**
 * Chequeo del carrito que devolvió el modelo.
 * No recalcula cantidades ni cambia productos: solo acepta o rechaza.
 */
import type { AiOutput, CartLine, CatalogSnapshot, SellUnit } from "@/lib/catalogOrder/types";
import { fold } from "@/lib/catalogOrder/text";

export function pesosToKg(amount: number, precio: number): number {
  return Math.round((amount / precio) * 100) / 100;
}

function allowedUnit(rowUnit: "pz" | "kg", unit: string): unit is SellUnit {
  if (rowUnit === "kg") return unit === "kg" || unit === "pesos";
  return unit === "pz";
}

export function checkAiOutput(output: AiOutput, catalog: CatalogSnapshot): { cart: CartLine[]; errors: string[] } {
  const errors: string[] = [];
  const cart: CartLine[] = [];
  for (const line of output.cart) {
    const row = catalog.byId.get(line.product_id);
    if (!row || !row.disponible) {
      errors.push(`el id ${line.product_id} no está en el menú`);
      continue;
    }
    if (!Number.isFinite(line.qty) || line.qty <= 0) {
      errors.push(`la cantidad de ${row.name} no es un número positivo`);
      continue;
    }
    if (!allowedUnit(row.unit, line.unit)) {
      errors.push(`${row.name} no se vende en ${line.unit}`);
      continue;
    }
    if (line.unit === "pesos" && !(row.precio > 0)) {
      errors.push(`${row.name} no tiene precio para pasar pesos a kilos`);
      continue;
    }
    let variant: string | null = line.variant?.trim() ? line.variant.trim() : null;
    if (row.variants.length) {
      const match = row.variants.find((option) => fold(option) === fold(variant ?? ""));
      if (!match) {
        errors.push(`${row.name} necesita un sabor del menú`);
        continue;
      }
      variant = match;
    } else variant = null;
    cart.push({ productId: row.id, qty: line.qty, unit: line.unit, variant, notes: null });
  }
  if (output.question) {
    const text = output.question.text.trim();
    if (!text) errors.push("la pregunta está vacía");
    for (const id of output.question.candidate_ids) {
      if (!catalog.byId.get(id)) errors.push(`la pregunta cita el id ${id}, que no está en el menú`);
    }
  }
  if (errors.length) return { cart: [], errors };
  return { cart, errors: [] };
}
