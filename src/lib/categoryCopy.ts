/**
 * Textos del tramo de productos, uno por categoría.
 * La confirmación lleva un ejemplo fijo, en cursiva, que no sale del pedido.
 * La ayuda larga solo sale si una corrección no cambió nada.
 */

export type StoreKind = "abarrotes" | "restaurante" | "carniceria";

const SHORT_INTRO = "_Si algún producto está mal, escríbeme cuál es y qué cambio quieres._";

/** Una sola ayuda corta, debajo de la lista. Nunca usa los productos del cliente. */
export function formatShortEditHelp(kind: StoreKind = "abarrotes"): string {
  const example =
    kind === "restaurante"
      ? '_Solo es un ejemplo, no está en tu pedido: "quita las papas" o "agrega 1 refresco". Pídelo con el nombre del menú._'
      : kind === "carniceria"
        ? '_Solo es un ejemplo, no está en tu pedido: "cambia el carbón a 2 bolsas" o "quita el pastor"._'
        : '_Solo es un ejemplo, no está en tu pedido: "cambia la leche Lala a 2 litros" o "quita la leche"._';
  return `${SHORT_INTRO}\n\n${example}`;
}

const LONG_INTRO = "No pude cambiar tu lista. Escríbeme cuál producto está mal y qué cambio quieres.";
const EXAMPLE_LABEL = "_Solo es un ejemplo, no está en tu pedido:_";

/** Cómo escribir el cambio, cuando la corrección no movió la lista. Los ejemplos son fijos. */
export function formatLongEditHelp(kind: StoreKind = "abarrotes"): string {
  const examples =
    kind === "restaurante"
      ? ['_"quita las papas"_', '_"cambia la hamburguesa a grande"_', '_"agrega 1 refresco"_']
      : kind === "carniceria"
        ? ['_"quita el pastor"_', '_"cambia el carbón a 2 bolsas"_', '_"agrega 1 kilo de carne"_']
        : ['_"quita la leche"_', '_"cambia la leche Lala a 2 litros"_', '_"agrega 1 leche Lala de 1 litro"_'];
  const closing =
    kind === "restaurante"
      ? "Pídelo con el nombre del menú y cuántos."
      : kind === "carniceria"
        ? "Pídelo con el corte y los kilos (o cuántos pesos)."
        : "Cada producto va aparte, con marca, tamaño y cuántos.";
  return [LONG_INTRO, "", EXAMPLE_LABEL, ...examples, "", closing].join("\n");
}

export function summaryStoreLabel(kind: StoreKind): string {
  if (kind === "restaurante") return "🍔 *Restaurante:";
  if (kind === "carniceria") return "🥩 *Carnicería:";
  return "🏪 *Tienda:";
}

export function specExampleLines(kind: StoreKind): string[] {
  if (kind === "restaurante") return ["1 Hamburguesa Hawaiana Grande", "2 Refresco Pepsi"];
  if (kind === "carniceria") return ["1 kg de Chorizo", "Medio kilo de Arrachera Marinada"];
  return ["Takis Fuego 56g", "Salchicha FUD 500g", "Mayonesa McCormick 1L"];
}
