/**
 * Textos que son del modelo o de una herramienta, no del cliente.
 * El chequeo del simulador usa los mismos patrones.
 */

const LEAKS: RegExp[] = [
  /\bel cliente\b/i,
  /no pidi[oó] quitar/i,
  /no la borres/i,
  /no lo agregues/i,
  /\b(search_products|set_cart_line|remove_line|ask_customer|finish_order)\b/,
  /\bline_id\b/i,
  /\bproduct_id\b/i,
  /\{[^{}]{0,240}"[a-z_]+"\s*:/,
];

export function outboundLeak(text: string): string | null {
  const body = String(text ?? "");
  for (const pattern of LEAKS) {
    if (pattern.test(body)) return pattern.source;
  }
  return null;
}

export function scrubOutboundText(text: string): string {
  const body = String(text ?? "");
  if (!outboundLeak(body)) return body;
  const kept = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && !outboundLeak(part));
  if (kept.length) return kept.join("\n\n");
  return "Dime cómo lo dejamos. Si ya no lo quieres, escribe *cancelar*.";
}
