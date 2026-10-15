import { closestAgentProducts, foldAgent, genericDogoProduct, isGenericDogoText, isOrderVerbOnly, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import type { AgentLine, AgentPending, AgentProduct, AgentStore, AgentUnit, PendingAxis, ToolCall } from "@/lib/orderAgent/types";

export type ToolVerdict =
  | { ok: true; line?: AgentLine; removedId?: string; question?: AgentPending; search?: AgentProduct[]; finished?: boolean }
  | { ok: false; error: string; customerNote?: string };

const UNITS = new Set<AgentUnit>(["pz", "kg", "pesos", "g"]);

function asUnit(value: unknown): AgentUnit | null {
  return value === "pz" || value === "kg" || value === "pesos" || value === "g" ? value : null;
}

function saneQty(unit: AgentUnit, qty: number): boolean {
  if (!Number.isFinite(qty) || qty <= 0) return false;
  if (unit === "pz") return Number.isInteger(qty) && qty <= 40;
  if (unit === "kg") return qty <= 20;
  if (unit === "g") return qty <= 5000;
  return qty >= 10 && qty <= 3000;
}

function unitAllowed(store: AgentStore, product: AgentProduct, unit: AgentUnit): boolean {
  // En abarrotes la tienda cotiza después: el cliente puede pedir piezas, kilos o pesos.
  if (store.catalogMode === "list") return true;
  if (product.unit === "kg") return unit === "kg" || unit === "pesos" || unit === "g";
  return unit === "pz";
}

function matchVariant(product: AgentProduct, variant: string | null): string | null {
  if (!product.variants.length) return null;
  if (!variant) return null;
  return product.variants.find((option) => foldAgent(option) === foldAgent(variant)) ?? null;
}

function axisOf(text: string, explicit: unknown): PendingAxis {
  if (explicit === "number" || explicit === "size" || explicit === "flavor" || explicit === "marinade" || explicit === "brand") {
    return explicit;
  }
  const folded = foldAgent(text);
  if (/\bmarinad|\bnormal\b|\bnatural\b|\bsin marinar\b/.test(folded)) return "marinade";
  if (/\b(chica|grande|tamano)\b/.test(folded)) return "size";
  // "coca" puede ser el producto, no el eje. El sabor se declara con la palabra o con axis.
  if (/\bsabor\b/.test(folded)) return "flavor";
  if (/\bmarca\b/.test(folded)) return "brand";
  return null;
}

export function candidatesDiffer(products: AgentProduct[], ids: number[], axis: PendingAxis): boolean {
  if (!axis) return true;
  const rows = ids.map((id) => products.find((product) => product.id === id)).filter((row): row is AgentProduct => Boolean(row));
  if (!rows.length) return false;
  if (axis === "marinade") {
    const seasoned = rows.map((row) => /marinad|adobad/.test(foldAgent(`${row.name} ${row.presentation ?? ""}`)));
    return seasoned.some(Boolean) && seasoned.some((flag) => !flag);
  }
  if (axis === "size") {
    const sizes = new Set(rows.map((row) => foldAgent(row.presentation ?? "")).filter(Boolean));
    return sizes.size > 1;
  }
  if (axis === "flavor") {
    const flavors = rows.flatMap((row) => row.variants.map((variant) => foldAgent(variant)));
    return new Set(flavors).size > 1;
  }
  if (axis === "brand") {
    return new Set(rows.map((row) => foldAgent(row.brand ?? "")).filter(Boolean)).size > 1;
  }
  return ids.length > 1;
}

function sameQuestion(left: string, right: string): boolean {
  return foldAgent(left) === foldAgent(right);
}

export function validateToolCall(params: {
  call: ToolCall;
  store: AgentStore;
  products: AgentProduct[];
  cart: AgentLine[];
  pending: AgentPending | null;
  nextLineId: string;
}): ToolVerdict {
  const { call, store, products, cart, pending } = params;
  const args = call.arguments ?? {};
  if (args.store_id != null && Number(args.store_id) !== store.id) {
    return { ok: false, error: "No se cambia de tienda en este pedido. Sigue en la tienda actual." };
  }

  if (call.name === "search_products") {
    const query = String(args.query ?? "").trim();
    if (!query || isOrderVerbOnly(query)) {
      return { ok: false, error: "Esa búsqueda no trae un producto. Quita palabras como pedí, quiero o dame." };
    }
    return { ok: true };
  }

  if (call.name === "remove_line") {
    const lineId = String(args.line_id ?? "").trim();
    const productId = Number(args.product_id);
    const freeText = foldAgent(String(args.free_text ?? ""));
    const line = cart.find((item) => {
      if (lineId && item.lineId === lineId) return true;
      if (Number.isFinite(productId) && item.productId === productId) return true;
      return Boolean(freeText) && foldAgent(item.freeText ?? item.name) === freeText;
    });
    if (!line) return { ok: false, error: "Esa línea no está en el carrito." };
    return { ok: true, removedId: line.lineId };
  }

  if (call.name === "ask_customer") {
    const text = String(args.text ?? "").trim();
    if (!text) return { ok: false, error: "La pregunta va con texto." };
    if (pending && sameQuestion(text, pending.question)) {
      return { ok: false, error: "Esa pregunta ya se hizo. Usa la respuesta del cliente, no la repitas." };
    }
    const ids = Array.isArray(args.candidate_ids) ? args.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)) : [];
    const axis = axisOf(text, args.axis);
    if (axis && ids.length && !candidatesDiffer(products, ids, axis)) {
      return {
        ok: false,
        error: "Esas opciones no se diferencian en ese eje. No preguntes. Anota la que sí existe.",
      };
    }
    if (axis === "marinade" && !ids.length) {
      const named = products.filter((product) => foldAgent(text).includes(foldAgent(product.name).split(" ")[0] ?? "___"));
      if (named.length && !candidatesDiffer(products, named.map((product) => product.id), "marinade")) {
        return { ok: false, error: "No hay versión marinada y normal de ese corte. No preguntes eso." };
      }
    }
    return {
      ok: true,
      question: { question: text, candidateIds: ids, qty: null, unit: null, axis },
    };
  }

  if (call.name === "finish_cart") {
    const missingVariant = cart.find((line) => {
      if (line.productId == null) return false;
      const product = products.find((item) => item.id === line.productId);
      return Boolean(product && product.variants.length && !line.variant);
    });
    if (missingVariant) {
      return { ok: false, error: `A ${missingVariant.name} le falta el sabor o la variante. Pregúntalo o anótalo.` };
    }
    return { ok: true, finished: true };
  }

  if (call.name !== "set_cart_line") {
    return { ok: false, error: "Herramienta desconocida." };
  }

  const qty = Number(args.qty);
  const unit = asUnit(args.unit);
  if (!unit) return { ok: false, error: "La unidad tiene que ser pz, kg, pesos o g." };
  if (!saneQty(unit, qty)) return { ok: false, error: "La cantidad no es válida para esa unidad." };

  const variantText = args.variant == null ? null : String(args.variant).trim() || null;
  const note = args.note == null ? null : String(args.note).trim() || null;
  let productId = args.product_id == null ? null : Number(args.product_id);
  let freeText = args.free_text == null ? null : String(args.free_text).trim() || null;
  if (freeText && isOrderVerbOnly(freeText)) {
    return { ok: false, error: "«Pedí», «quiero» o «dame» no son un producto." };
  }
  if (freeText) freeText = stripOrderVerbs(freeText) || freeText;

  if (store.category !== "abarrotes" && freeText && isGenericDogoText(freeText)) {
    const clasico = genericDogoProduct(products);
    if (clasico) {
      productId = clasico.id;
      freeText = null;
    }
  }

  if (productId != null && Number.isFinite(productId)) {
    const product = products.find((item) => item.id === productId);
    if (!product || !product.available) {
      return { ok: false, error: `El producto ${productId} no está en esta tienda.` };
    }
    if (store.catalogMode === "fixed" && !(typeof product.price === "number" && product.price > 0)) {
      return { ok: false, error: `${product.name} no tiene precio. No lo anotes.` };
    }
    if (!unitAllowed(store, product, unit)) {
      return { ok: false, error: `${product.name} no se vende en ${unit}.` };
    }
    if (product.variants.length) {
      const variant = matchVariant(product, variantText);
      if (!variant) {
        return { ok: false, error: `${product.name} necesita una de estas variantes: ${product.variants.join(", ")}.` };
      }
      return {
        ok: true,
        line: lineFromProduct(params.nextLineId, product, qty, unit, variant, note),
      };
    }
    return {
      ok: true,
      line: lineFromProduct(params.nextLineId, product, qty, unit, null, note),
    };
  }

  if (!freeText) return { ok: false, error: "Falta product_id o el texto del producto." };
  if (store.catalogMode === "fixed" || store.category !== "abarrotes") {
    const near = closestAgentProducts(products, freeText, 2).map((product) => product.name);
    const suggestion = near.length ? ` Lo más cercano: ${near.join(" o ")}.` : "";
    const customerNote = `*${freeText}* no lo manejamos.${suggestion}`;
    return {
      ok: false,
      error: `No está en el menú: "${freeText}".${suggestion} Dile al cliente que no lo manejamos y ofrece eso. No lo anotes.`,
      customerNote,
    };
  }
  const name = freeText.replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    ok: true,
    line: {
      lineId: params.nextLineId,
      productId: null,
      freeText,
      name,
      qty,
      unit,
      variant: variantText,
      note,
      unitPrice: null,
      brand: null,
      presentation: null,
    },
  };
}

function lineFromProduct(
  lineId: string,
  product: AgentProduct,
  qty: number,
  unit: AgentUnit,
  variant: string | null,
  note: string | null,
): AgentLine {
  return {
    lineId,
    productId: product.id,
    freeText: null,
    name: variant ? `${product.name} ${variant}` : product.name,
    qty,
    unit,
    variant,
    note,
    unitPrice: product.price,
    brand: product.brand,
    presentation: product.presentation,
  };
}

export function upsertLine(cart: AgentLine[], line: AgentLine): AgentLine[] {
  const index = cart.findIndex((item) => {
    if (line.productId != null && item.productId === line.productId && (item.variant ?? null) === (line.variant ?? null) && item.unit === line.unit) {
      return true;
    }
    return line.freeText != null && item.freeText != null && foldAgent(item.freeText) === foldAgent(line.freeText);
  });
  if (index < 0) return [...cart, line];
  const next = cart.slice();
  next[index] = { ...line, lineId: cart[index].lineId };
  return next;
}
