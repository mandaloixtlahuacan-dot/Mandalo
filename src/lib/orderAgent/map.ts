import type { CartLine, CatalogSnapshot, PendingCatalogAsk, SellUnit } from "@/lib/catalogOrder/types";
import type { PedidoItemInput } from "@/lib/services/captureEngine";
import type { AgentLine, AgentPending, AgentProduct, AgentUnit } from "@/lib/orderAgent/types";

export function agentProductsFromCatalog(catalog: CatalogSnapshot): AgentProduct[] {
  return catalog.rows.map((row) => ({
    id: row.id,
    name: row.name,
    price: Number.isFinite(row.precio) ? row.precio : null,
    available: row.disponible,
    unit: row.unit,
    variants: row.variants,
    brand: null,
    presentation: row.size,
    alias: row.alias,
    category: row.categoria,
  }));
}

function agentUnit(unit: string | null | undefined): AgentUnit {
  if (unit === "kg" || unit === "kilo" || unit === "kilos") return "kg";
  if (unit === "pesos") return "pesos";
  if (unit === "g") return "g";
  return "pz";
}

export function agentLinesFromCatalogCart(cart: CartLine[], catalog: CatalogSnapshot): AgentLine[] {
  return cart.map((line, index) => {
    const row = catalog.byId.get(line.productId);
    return {
      lineId: `l${index + 1}`,
      productId: line.productId,
      freeText: null,
      name: line.variant && row ? `${row.searchName} ${line.variant}` : row?.name ?? "producto",
      qty: line.qty,
      unit: line.unit,
      variant: line.variant,
      note: line.notes,
      unitPrice: row && Number.isFinite(row.precio) ? row.precio : null,
      brand: null,
      presentation: row?.size ?? null,
    };
  });
}

export function catalogCartFromAgent(lines: AgentLine[]): CartLine[] {
  const cart: CartLine[] = [];
  for (const line of lines) {
    if (line.productId == null) continue;
    const unit: SellUnit = line.unit === "pesos" ? "pesos" : line.unit === "kg" || line.unit === "g" ? "kg" : "pz";
    const qty = line.unit === "g" ? line.qty / 1000 : line.qty;
    cart.push({
      productId: line.productId,
      qty,
      unit,
      variant: line.variant,
      notes: line.note,
    });
  }
  return cart;
}

export function agentPendingFromCatalog(pending: PendingCatalogAsk | null): AgentPending | null {
  if (!pending) return null;
  return {
    question: pending.question,
    candidateIds: pending.candidateIds,
    qty: pending.qty,
    unit: pending.unit,
    axis: null,
  };
}

export function catalogPendingFromAgent(pending: AgentPending | null): PendingCatalogAsk | null {
  if (!pending) return null;
  const unit: SellUnit = pending.unit === "kg" || pending.unit === "pesos" ? pending.unit : "pz";
  return {
    sourceText: pending.question,
    candidateIds: pending.candidateIds,
    qty: pending.qty && pending.qty > 0 ? pending.qty : 1,
    unit,
    variant: null,
    family: null,
    question: pending.question,
    count: 1,
  };
}

export function agentLinesFromItems(items: PedidoItemInput[]): AgentLine[] {
  return items.map((item, index) => ({
    lineId: `l${index + 1}`,
    productId: null,
    freeText: item.nombre_producto,
    name: [item.nombre_producto, item.marca, item.presentacion].filter((part) => part && String(part).trim()).join(" "),
    qty: item.cantidad && item.cantidad > 0 ? item.cantidad : 1,
    unit: agentUnit(item.unidad),
    variant: null,
    note: item.notas ?? null,
    unitPrice: null,
    brand: item.marca ?? null,
    presentation: item.presentacion ?? null,
  }));
}
