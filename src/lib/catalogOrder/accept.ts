/**
 * Chequeo mínimo del carrito que devolvió el modelo.
 * No reescribe líneas válidas, no repone lo que el modelo quitó
 * y no cambia un paquete que el modelo ya eligió.
 */
import { fold } from "@/lib/catalogOrder/text";
import type { AiOutput, AiPendingLine, CartLine, CatalogSnapshot, SellUnit } from "@/lib/catalogOrder/types";

export type AcceptedQuestion = {
  text: string;
  candidateIds: number[];
  qty: number | null;
  unit: SellUnit | null;
  sourceText: string | null;
};

export type CheckResult = {
  cart: CartLine[];
  errors: string[];
  /** Líneas que siguen sin resolverse. Si hay alguna, no se confirma el pedido. */
  pending: AcceptedQuestion[];
  question: AcceptedQuestion | null;
  notOnMenu: string[];
};

export function pesosToKg(amount: number, precio: number): number {
  return Math.round((amount / precio) * 100) / 100;
}

function allowedUnit(rowUnit: "pz" | "kg", unit: string): unit is SellUnit {
  if (rowUnit === "kg") return unit === "kg" || unit === "pesos";
  return unit === "pz";
}

function asUnit(value: unknown): SellUnit | null {
  return value === "pz" || value === "kg" || value === "pesos" ? value : null;
}

function pendingFrom(item: AiPendingLine): AcceptedQuestion | null {
  const text = String(item.text ?? "").trim();
  if (!text) return null;
  const ids = Array.isArray(item.candidate_ids)
    ? item.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];
  const qty = item.qty == null || !Number.isFinite(Number(item.qty)) ? null : Number(item.qty);
  return {
    text,
    candidateIds: ids,
    qty,
    unit: asUnit(item.unit),
    sourceText: item.source_text?.trim() ? item.source_text.trim() : null,
  };
}

export function checkAiOutput(output: AiOutput, catalog: CatalogSnapshot): CheckResult {
  const errors: string[] = [];
  const cart: CartLine[] = [];
  const asks: AcceptedQuestion[] = [];

  for (const line of output.cart ?? []) {
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
    if (line.unit === "pz" && !Number.isInteger(line.qty)) {
      errors.push(`${row.name} en piezas tiene que ser un número entero`);
      continue;
    }
    let variant: string | null = null;
    if (row.variants.length) {
      const match = row.variants.find((option) => fold(option) === fold(line.variant ?? ""));
      if (!match) {
        asks.push({
          text: `¿Cuál sabor: ${row.variants.join(", ")}?`,
          candidateIds: [row.id],
          qty: line.qty,
          unit: line.unit,
          sourceText: null,
        });
        continue;
      }
      variant = match;
    }
    cart.push({ productId: row.id, qty: line.qty, unit: line.unit, variant, notes: null });
  }

  const declared = Array.isArray(output.pending) && output.pending.length
    ? output.pending
    : output.question
      ? [output.question]
      : [];
  const pending = [...asks];
  for (const item of declared) {
    const row = pendingFrom(item);
    if (!row) continue;
    row.candidateIds = row.candidateIds.filter((id) => catalog.byId.has(id));
    pending.push(row);
  }

  const notOnMenu = (output.not_on_menu ?? []).map((item) => String(item).trim()).filter(Boolean);
  return { cart, errors, pending, question: pending[0] ?? null, notOnMenu };
}
