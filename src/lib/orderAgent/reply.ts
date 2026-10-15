import type { StoreKind } from "@/lib/categoryCopy";
import { formatCatalogFinalTicket, formatPreConfirmFeeNote } from "@/lib/customerUx";
import { formatProductListConfirm, type PedidoItemInput } from "@/lib/services/captureEngine";
import { formatMoney } from "@/lib/ordenes";
import type { AgentLine, AgentStore, OrderCategory } from "@/lib/orderAgent/types";

function kindOf(category: OrderCategory): StoreKind {
  return category;
}

function qtyLabel(line: AgentLine): string {
  if (line.unit === "kg") {
    if (Math.abs(line.qty - 0.25) < 0.001) return "¼ kg";
    if (Math.abs(line.qty - 0.5) < 0.001) return "½ kg";
    if (Math.abs(line.qty - 0.75) < 0.001) return "¾ kg";
    const qty = Number.isInteger(line.qty) ? String(line.qty) : String(line.qty);
    return `${qty} kg`;
  }
  if (line.unit === "pesos") return `$${Number.isInteger(line.qty) ? line.qty : line.qty} de`;
  if (line.unit === "g") return `${line.qty} g`;
  if (Math.abs(line.qty - 1) < 0.001) return "";
  return `${line.qty}`;
}

export function agentLineLabel(line: AgentLine): string {
  const qty = qtyLabel(line);
  if (line.unit === "pesos") return `${qty} ${line.name}`.replace(/\s+/g, " ").trim();
  if (!qty) return line.name;
  if (line.unit === "pz") return `${qty} ${line.name}`;
  return `${qty} de ${line.name}`;
}

export function itemsFromAgentLines(lines: AgentLine[]): PedidoItemInput[] {
  return lines.map((line) => ({
    nombre_producto: line.name,
    marca: line.brand,
    presentacion: line.variant ?? line.presentation,
    cantidad: line.qty,
    unidad: line.unit === "kg" ? "kilo" : line.unit === "g" ? "g" : line.unit === "pesos" ? "pesos" : "pz",
    notas: line.note,
  }));
}

/** El total sale del precio del catálogo. El modelo no lo calcula. */
export function priceAgentCart(lines: AgentLine[]): { lines: string[]; subtotal: number | null } {
  let subtotal = 0;
  let complete = lines.length > 0;
  const rendered = lines.map((line) => {
    const label = agentLineLabel(line);
    if (line.unit === "pesos") {
      subtotal += line.qty;
      return `${label} — ${formatMoney(line.qty)}`;
    }
    if (line.unitPrice == null || !Number.isFinite(line.unitPrice)) {
      complete = false;
      return label;
    }
    const kilos = line.unit === "g" ? line.qty / 1000 : line.qty;
    const lineTotal = Math.round(line.unitPrice * kilos * 100) / 100;
    subtotal += lineTotal;
    return `${label} — ${formatMoney(lineTotal)}`;
  });
  return { lines: rendered, subtotal: complete ? Math.round(subtotal * 100) / 100 : null };
}

export function renderAgentReply(params: {
  store: AgentStore;
  cart: AgentLine[];
  question: string | null;
  aside: string | null;
}): string {
  const question = params.question?.trim() || "";
  const aside = params.aside?.trim() || "";
  if (!params.cart.length && question) return [aside, question].filter(Boolean).join("\n\n");
  if (!params.cart.length) {
    const invite = params.store.category === "carniceria"
      ? "Dime el corte y los kilos, o cuántos pesos."
      : params.store.category === "restaurante"
        ? "Dime qué se te antoja del menú y cuántos."
        : "Dime qué se te antoja, con marca y tamaño si lo tienes.";
    return [aside, question, invite].filter(Boolean).join("\n\n");
  }
  const priced = priceAgentCart(params.cart);
  const list = params.store.catalogMode === "fixed"
    ? formatCatalogFinalTicket({
        itemLines: priced.lines,
        subtotal: priced.subtotal,
        kind: kindOf(params.store.category),
      })
    : `${formatProductListConfirm(itemsFromAgentLines(params.cart), "abarrotes")}\n\n${formatPreConfirmFeeNote("cotiza_tienda")}`;
  if (question) return [aside, question].filter(Boolean).join("\n\n");
  return [aside, list].filter(Boolean).join("\n\n");
}
