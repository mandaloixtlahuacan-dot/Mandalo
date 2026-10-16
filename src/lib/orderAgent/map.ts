import type { CartLine, CatalogSnapshot, PendingCatalogAsk, SellUnit } from "@/lib/catalogOrder/types";
import type { PendingAsk } from "@/lib/clarificationAnswers";
import type { PedidoItemInput } from "@/lib/services/captureEngine";
import type { AgentClarification, AgentLine, AgentPending, AgentProduct, AgentUnit, PendingAxis } from "@/lib/orderAgent/types";

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
  const text = String(unit ?? "").trim().toLowerCase();
  if (text === "kg" || text === "kilo" || text === "kilos") return "kg";
  if (text === "pesos") return "pesos";
  if (text === "g" || text === "gr" || text === "gramo" || text === "gramos") return "g";
  if (text === "l" || text === "lt" || text === "lts" || text === "litro" || text === "litros") return "l";
  return "pz";
}

function packFromUnit(unit: string | null | undefined): string | null {
  const text = String(unit ?? "").trim().toLowerCase();
  if (text === "paquete" || text === "paquetes") return "paquete";
  if (text === "bolsa" || text === "bolsas") return "bolsa";
  if (text === "caja" || text === "cajas") return "caja";
  if (text === "botella" || text === "botellas") return "botella";
  if (text === "lata" || text === "latas") return "lata";
  return null;
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

function asAxis(value: unknown): PendingAxis {
  if (value === "number" || value === "size" || value === "flavor" || value === "marinade" || value === "brand") return value;
  return null;
}

function storedClarification(item: AgentClarification): NonNullable<PendingAsk["agentQueue"]>[number] {
  return {
    question: item.question,
    candidateIds: item.candidateIds,
    qty: item.qty,
    unit: item.unit,
    axis: item.axis,
    query: item.query ?? null,
  };
}

function readClarification(item: NonNullable<PendingAsk["agentQueue"]>[number]): AgentClarification {
  const unit = item.unit;
  return {
    question: item.question,
    candidateIds: Array.isArray(item.candidateIds) ? item.candidateIds.filter((id) => Number.isFinite(id)) : [],
    qty: typeof item.qty === "number" && item.qty > 0 ? item.qty : null,
    unit: unit === "kg" || unit === "pesos" || unit === "g" || unit === "l" || unit === "pz" ? unit : null,
    axis: asAxis(item.axis),
    query: item.query ?? null,
  };
}

/** Lo que se guarda en snapshot_json.pendingAsk para retomar la cola sin el modelo. */
export function snapshotFieldsFromAgentPending(pending: AgentPending): Pick<
  PendingAsk,
  "question" | "count" | "agentUnit" | "agentQty" | "agentAxis" | "agentQuery" | "agentQueue"
> {
  const queue = (pending.queue ?? []).map(storedClarification);
  return {
    question: pending.question,
    count: 1 + queue.length,
    agentUnit: pending.unit,
    agentQty: pending.qty,
    agentAxis: pending.axis,
    agentQuery: pending.query ?? null,
    agentQueue: queue,
  };
}

export function agentPendingFromStoredAsk(stored: PendingAsk | null | undefined): AgentPending | null {
  if (!stored?.question) return null;
  const unit = stored.agentUnit;
  const catalogUnit = stored.catalog?.unit;
  return {
    question: stored.question,
    candidateIds: stored.catalog?.candidateIds ?? [],
    qty: stored.agentQty ?? stored.catalog?.qty ?? null,
    unit:
      unit === "kg" || unit === "pesos" || unit === "g" || unit === "l" || unit === "pz"
        ? unit
        : catalogUnit === "kg" || catalogUnit === "pesos"
          ? catalogUnit
          : "pz",
    axis: asAxis(stored.agentAxis),
    query: stored.agentQuery ?? null,
    queue: (stored.agentQueue ?? []).map(readClarification).filter((item) => item.question && item.candidateIds.length),
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
    presentation: item.presentacion ?? packFromUnit(item.unidad),
  }));
}
