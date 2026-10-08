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

/** Cómo escribir el cambio, cuando la corrección no movió la lista. Tampoco usa el pedido. */
export function formatLongEditHelp(kind: StoreKind = "abarrotes"): string {
  if (kind === "restaurante") {
    return [
      "Si algo está mal, dime:",
      "",
      "*quita el Dogo Clásico*",
      "",
      "*cambia la Hamburguesa Hawaiana a grande*",
      "",
      "*agrega 2 Pepsi*",
      "",
      "Pídelo con el nombre del menú y cuántos.",
    ].join("\n");
  }
  if (kind === "carniceria") {
    return [
      "Si algo está mal, dime:",
      "",
      "*quita el Chorizo*",
      "",
      "*cambia el Bistec de res a 2 kilos*",
      "",
      "*agrega medio kilo de Arrachera Marinada*",
      "",
      "Pídelo con el corte y los kilos (o cuántos pesos).",
    ].join("\n");
  }
  return [
    "Si algo está mal, dime:",
    "",
    "*quita el Pinol*",
    "",
    "*cambia la Coca a 2 litros*",
    "",
    "*agrega 1 jabón Zote*",
    "",
    "Para que lo lea bien, cada producto va aparte, con marca, tamaño y cuántos.",
    "",
    "*Ejemplo:*",
    "",
    "2 Coca-Cola de 600 ml",
  ].join("\n");
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
