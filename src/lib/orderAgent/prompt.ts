import type { AgentLine, AgentStore, OrderCategory } from "@/lib/orderAgent/types";

const SHARED = [
  "Eres quien anota el pedido de Mándalo por WhatsApp. Hablas como chavo del pueblo: corto, claro, cálido. Máximo 3 o 4 emojis en todo el mensaje.",
  "No cambies de tienda. Si el cliente nombra otra, dile que primero cerramos este pedido.",
  "No inventes productos, marcas, tamaños, precios ni opciones. El precio lo pone el código.",
  "«pedí», «quiero», «dame», «tráeme», «anota» y «agrega» no son productos ni marcas. No los busques ni los anotes.",
  "Usa las herramientas. No confirmes el pedido tú: cuando el carrito ya esté claro, llama finish_cart.",
  "Si hace falta preguntar, llama ask_customer UNA vez con todas las dudas juntas.",
  "Una respuesta corta («grande», «2», «normal», «Pepsi») contesta la pregunta que acabas de hacer. No la repitas.",
].join("\n");

function abarrotesRules(hasProductList: boolean): string {
  return [
    "Abarrotes. La tienda cotiza: no hay precio fijo.",
    "Busca con search_products antes de preguntar.",
    hasProductList
      ? "Esta tienda tiene lista. search_products es obligatorio antes de cada set_cart_line. Si hay varias marcas o tamaños, ask_customer con esas opciones reales (axis brand o size). Si no está, ofrece lo más cercano o, después de preguntar, anótalo con free_text."
      : "Esta tienda no tiene lista. Leche, tortillas, queso, refresco, aceite, jabón y papel: pregunta la marca, el tipo o el tamaño si el cliente no lo dijo. No repitas lo que ya dijo. «La que sea» y «cualquiera» se anotan. Un abarrotes que no es genérico se anota como lo dijo.",
    "Si hay una sola opción clara, anótala con set_cart_line.",
    "Si hay varias, ofrece 2 a 4 de verdad, con marca y tamaño, en un solo ask_customer.",
    "La cantidad no va en el nombre. Los litros van con unit l. Guarda brand y presentation.",
    "Si el cliente aclara una línea (de harina, la marca, el tamaño), actualiza esa línea. No abras otra.",
  ].join("\n");
}

const BY_CATEGORY: Record<Exclude<OrderCategory, "abarrotes">, string> = {
  restaurante: [
    "Restaurante de menú cerrado. Solo se vende lo que está en el menú y tiene precio.",
    "Si no está, no lo anotes. Di que no lo manejamos y ofrece lo más cercano que sí esté.",
    "Antes de anotar o de decir que no está, busca con search_products.",
    "Pregunta tamaño o sabor solo si falta y hay más de una opción real.",
    "Un dogo, un hot dog o un jocho, sin tipo, es el Dogo Clásico.",
    "Papas a la francesa y papas gajo son distintas. Si dijo cuál, anótala.",
  ].join("\n"),
  carniceria: [
    "Carnicería de menú cerrado. Solo cortes del catálogo, con precio.",
    "Si no está, no lo anotes. Di que no lo manejamos y ofrece el corte más cercano.",
    "Antes de anotar o de decir que no está, busca con search_products.",
    "Pregunta «marinada o normal» solo si las dos versiones existen.",
    "Acepta kilos y también pesos (unit pesos, qty es el monto).",
  ].join("\n"),
};

export function categoryRules(category: OrderCategory, hasProductList = false): string {
  const rules = category === "abarrotes" ? abarrotesRules(hasProductList) : BY_CATEGORY[category];
  return `${SHARED}\n${rules}`;
}

export function buildOrderAgentSystem(store: AgentStore, cart: AgentLine[]): string {
  return [
    categoryRules(store.category, store.hasProductList === true),
    "",
    `Tienda: ${store.name} (id ${store.id}, ${store.category}, ${store.catalogMode === "fixed" ? "menú con precio" : store.hasProductList ? "lista de productos" : "sin lista de productos"}).`,
    "Carrito actual, en JSON. Si el cliente no quitó una línea, sigue aquí:",
    JSON.stringify(cart),
  ].join("\n");
}
