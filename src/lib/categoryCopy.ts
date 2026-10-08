/**
 * Textos del tramo de productos, uno por categoría.
 * Abarrotes se queda con el ejemplo de siempre. Restaurante y carnicería
 * no heredan Pinol, Coca ni «la tienda cotiza».
 */

export type StoreKind = "abarrotes" | "restaurante" | "carniceria";

function cleanName(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function firstName(names: string[], fallback: string): string {
  return cleanName(names.find((name) => name.trim()) ?? "") || fallback;
}

function quitaPhrase(name: string): string {
  const female = /^(hamburguesa|torta|papa|sincronizada|quesadilla|coca|salsa|arrachera|costilla)/i.test(name);
  return `quita ${female ? "la" : "el"} ${name}`;
}

export function formatRestauranteEditHelp(itemNames: string[] = []): string {
  const quitar = firstName(itemNames, "Dogo Clásico");
  const burger =
    itemNames.find((name) => /hamburguesa/i.test(name))?.replace(/\s+(chica|chico|grande)$/i, "").trim() ||
    "Hamburguesa Hawaiana";
  return [
    "Si algo está mal, dime:",
    "",
    `*${quitaPhrase(quitar)}*`,
    "",
    `*cambia la ${burger} a grande*`,
    "",
    "*agrega 2 Pepsi*",
    "",
    "Pídelo con el nombre del menú y cuántos.",
  ].join("\n");
}

export function formatCarniceriaEditHelp(itemNames: string[] = []): string {
  const quitar = itemNames.find((name) => /chorizo/i.test(name)) || firstName(itemNames, "Chorizo");
  const bistec = itemNames.find((name) => /bistec/i.test(name)) || "Bistec de res";
  const extra = itemNames.find((name) => /arrachera/i.test(name)) || "Arrachera Marinada";
  return [
    "Si algo está mal, dime:",
    "",
    `*quita el ${quitar}*`,
    "",
    `*cambia el ${bistec} a 2 kilos*`,
    "",
    `*agrega medio kilo de ${extra}*`,
    "",
    "Pídelo con el corte y los kilos (o cuántos pesos).",
  ].join("\n");
}

export function formatKindEditHelp(kind: StoreKind, itemNames: string[] = []): string | null {
  if (kind === "restaurante") return formatRestauranteEditHelp(itemNames);
  if (kind === "carniceria") return formatCarniceriaEditHelp(itemNames);
  return null;
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
