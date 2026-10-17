import { rankListaCandidates } from "@/lib/storeProductSearch";
import type { ListaProducto } from "@/lib/storeProductList";
import type { AgentProduct } from "@/lib/orderAgent/types";

export function foldAgent(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ORDER_VERBS = /\b(pedi|pediste|pedimos|pedido|quiero|quisiera|dame|denme|traeme|anota|anotame|agrega|agregame)\b/g;

export function stripOrderVerbs(text: string): string {
  return foldAgent(text).replace(ORDER_VERBS, " ").replace(/\s+/g, " ").trim();
}

export function isOrderVerbOnly(text: string): boolean {
  const folded = foldAgent(text);
  if (!folded) return true;
  return stripOrderVerbs(folded).length === 0;
}

function asLista(product: AgentProduct): ListaProducto & { id: number } {
  return {
    id: product.id,
    nombre: product.name,
    marca: product.brand,
    presentacion: product.presentation,
    categoria: product.category,
    alias: [...(product.alias ?? []), ...(product.variants ?? [])],
    precio: product.price,
  };
}

export function searchAgentProducts(products: AgentProduct[], query: string, limit = 8): AgentProduct[] {
  const cleaned = stripOrderVerbs(query);
  if (!cleaned) return [];
  const byId = new Map(products.map((product) => [product.id, product]));
  const ranked = rankListaCandidates(products.map(asLista), cleaned, limit);
  const found: AgentProduct[] = [];
  for (const row of ranked) {
    const id = (row as ListaProducto & { id?: number }).id;
    const product = id != null ? byId.get(id) : undefined;
    if (product && product.available) found.push(product);
  }
  return found;
}

export function closestAgentProducts(products: AgentProduct[], query: string, limit = 2): AgentProduct[] {
  return searchAgentProducts(products, query, Math.max(limit, 4)).slice(0, limit);
}

const GENERIC_DOGO = /^(?:(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+)?(?:dogo|dogos|hot dog|hotdog|hotdogs|jocho|jochos)$/;

export function genericDogoProduct(products: AgentProduct[]): AgentProduct | null {
  return (
    products.find((product) => {
      const name = foldAgent(product.name);
      return name.includes("dogo clasico") || name === "dogo clasico";
    }) ?? null
  );
}

export function isGenericDogoText(text: string): boolean {
  return GENERIC_DOGO.test(foldAgent(text));
}
