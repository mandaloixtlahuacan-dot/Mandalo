/**
 * Fase fija del cliente: categoría → tienda → ejemplo → pedido → ubicación → resumen.
 * El bot general no contesta ni pega una tienda antes de que el cliente la elija
 * con un match determinista (número, nombre o nombre parecido).
 */

import {
  buildGreeting,
  formatAbarrotesStoreAck,
  formatCatalogMenuCaption,
  formatNicheStoreList,
  nicheById,
  nicheListedInLastBot,
  type CustomerTurn,
  type UxStore,
} from "@/lib/customerUx";
import { isBareOrderRejection, isCancelIntent, isConversationModeMessage, isNewOrderIntent, isYesConfirmation, normalizeMessageIntentText } from "@/lib/messages";
import type { PedidoItemInput } from "@/lib/services/captureEngine";

export type OrderPhase = "categoria" | "tienda" | "ejemplo" | "pedido" | "ubicacion" | "resumen";

const PHASES = new Set<OrderPhase>(["categoria", "tienda", "ejemplo", "pedido", "ubicacion", "resumen"]);

export function isOrderPhase(value: unknown): value is OrderPhase {
  return typeof value === "string" && PHASES.has(value as OrderPhase);
}

export function withCategoryMenu(body: string): string {
  const text = String(body ?? "").trim();
  if (!text) return buildGreeting();
  if (text.includes("¿De dónde quieres?")) return text;
  return `${text}\n\n${buildGreeting()}`;
}

export function phaseForUxTurn(turn: CustomerTurn): { phase: OrderPhase; nicheId: string | null } {
  if (turn.type === "greeting") return { phase: "categoria", nicheId: null };
  if (turn.type === "show_niche" || turn.type === "switch_niche") return { phase: "tienda", nicheId: turn.nicheId };
  if (turn.type === "pick_store" || turn.type === "ask_menu" || turn.type === "ask_category") return { phase: "ejemplo", nicheId: null };
  return { phase: "pedido", nicheId: null };
}

export function inferOrderPhase(params: {
  hasOpenOrder: boolean;
  estado: string | null;
  hasBusiness: boolean;
  hasItems: boolean;
  lastBotText: string;
  awaitingAddress: boolean;
}): OrderPhase {
  if (!params.hasOpenOrder) return nicheListedInLastBot(params.lastBotText) ? "tienda" : "categoria";
  if (params.estado === "confirmacion_cliente") return "resumen";
  if (params.awaitingAddress) return "ubicacion";
  if (!params.hasBusiness) return nicheListedInLastBot(params.lastBotText) ? "tienda" : "categoria";
  if (!params.hasItems) return "ejemplo";
  return "pedido";
}

export function effectiveOrderPhase(stored: OrderPhase | null, inferred: OrderPhase, hasOpenOrder: boolean): OrderPhase {
  if (!stored) return inferred;
  if (!hasOpenOrder && (stored === "pedido" || stored === "ejemplo" || stored === "ubicacion" || stored === "resumen")) {
    return inferred;
  }
  if (hasOpenOrder && (stored === "categoria" || stored === "tienda") && inferred !== "categoria" && inferred !== "tienda") {
    return inferred;
  }
  return stored;
}

export function isOrderingSmallTalk(message: string): boolean {
  if (isConversationModeMessage(message)) return true;
  const text = normalizeMessageIntentText(message);
  if (!text || text.length > 40) return false;
  return /^(jaja+|jeje+|lol|gracias|grax|sale|simon|que onda|que tal|como estas|bien y tu|bueno dias|epa)$/.test(text);
}

export function reaskForPhase(params: {
  phase: OrderPhase;
  nicheId: string | null;
  lastBotText: string;
  stores: UxStore[];
  businessId: number | null;
}): { phase: OrderPhase; nicheId: string | null; text: string } {
  const listed = nicheListedInLastBot(params.lastBotText);
  const nicheId = params.nicheId ?? listed?.id ?? null;
  if ((params.phase === "tienda" || listed) && nicheId) {
    const niche = nicheById(nicheId);
    if (niche) return { phase: "tienda", nicheId, text: formatNicheStoreList(niche, params.stores) };
  }
  if (params.phase === "ejemplo" || params.phase === "pedido" || params.phase === "ubicacion") {
    const store = params.stores.find((item) => item.id === params.businessId) ?? null;
    if (store && !store.usaCatalogoFijo) return { phase: params.phase === "ubicacion" ? "ubicacion" : "ejemplo", nicheId: null, text: formatAbarrotesStoreAck(store) };
    if (store) return { phase: "ejemplo", nicheId: null, text: formatCatalogMenuCaption(store) };
  }
  return { phase: "categoria", nicheId: null, text: buildGreeting() };
}

/**
 * Antes de una tienda elegida a mano, o si el agente está prendido, el bot
 * general no arma el pedido ni pega business_name.
 */
export function gateGeneralBot(params: {
  phase: OrderPhase;
  message: string;
  hasBusiness: boolean;
  orderAgentOn: boolean;
  waitingAddress: boolean;
  nicheId: string | null;
  lastBotText: string;
  stores: UxStore[];
  businessId: number | null;
}): { phase: OrderPhase; nicheId: string | null; text: string } | null {
  const text = String(params.message ?? "").trim();
  if (!text) return null;
  if (params.waitingAddress || params.phase === "ubicacion" || params.phase === "resumen") return null;
  if (!params.hasBusiness || params.phase === "categoria" || params.phase === "tienda") {
    return reaskForPhase(params);
  }
  if (isOrderingSmallTalk(text) && params.phase === "ejemplo") {
    return reaskForPhase({ ...params, phase: "ejemplo" });
  }
  if (params.orderAgentOn) {
    return reaskForPhase({ ...params, phase: params.phase === "pedido" ? "ejemplo" : params.phase });
  }
  return null;
}

function phraseLabel(phrase: string): string {
  const clean = phrase.replace(/\s+/g, " ").trim();
  if (!clean) return clean;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function itemName(item: PedidoItemInput): string {
  return normalizeMessageIntentText(item.nombre_producto ?? "");
}

function explicitNegation(message: string): boolean {
  const text = normalizeMessageIntentText(message);
  return /\bno pedi\b/.test(text) || /\bno pido\b/.test(text) || /\bya no quiero el\b/.test(text);
}

/**
 * En el resumen, "no pedí X" quita esa línea y "es Y" la reemplaza.
 * Un paréntesis ("verdura") no se agrega como producto.
 */
export function applySummaryNegation(
  items: PedidoItemInput[],
  message: string,
): { items: PedidoItemInput[]; changed: boolean } {
  const raw = normalizeMessageIntentText(message);
  const asides = [...raw.matchAll(/\(([^)]+)\)/g)].map((match) => match[1].trim()).filter(Boolean);
  let text = raw;
  for (const aside of asides) text = text.replace(aside, " ");
  text = text.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const affirmed = [...text.matchAll(/\b(?:es|era|son)\s+([^.;]+)/g)].map((match) => match[1].replace(/\s+/g, " ").trim()).filter(Boolean);
  const removals = [...text.matchAll(/\bno (?:pedi|pido)\s+([^.;]+)/g)].map((match) => match[1].replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!affirmed.length && !removals.length && !asides.length) return { items, changed: false };

  const matchesTarget = (name: string, target: string): boolean => {
    if (!name || !target) return false;
    if (name === target) return true;
    if (target.split(" ").length === 1 && name.split(" ").length > 1 && name.includes(" de ")) return false;
    return name.endsWith(` ${target}`) || name.startsWith(`${target} `);
  };

  let next = items.filter((item) => {
    const name = itemName(item);
    if (asides.some((aside) => name === aside)) return false;
    const removed = removals.some((target) => matchesTarget(name, target));
    if (!removed) return true;
    return affirmed.some((keep) => name === keep || name.includes(keep));
  });

  next = next.map((item) => {
    const name = itemName(item);
    const better = affirmed.find((phrase) => phrase.includes(name) && phrase !== name && name.length >= 4);
    if (!better) return item;
    return { ...item, nombre_producto: phraseLabel(better), marca: null, notas: null };
  });

  const changed = JSON.stringify(next) !== JSON.stringify(items);
  if (!changed && explicitNegation(message)) return { items: next, changed: true };
  return { items: next, changed };
}

export function summaryCorrectionKind(message: string): "confirm" | "cancel" | "edit" | "other" {
  if (isYesConfirmation(message)) return "confirm";
  if (isBareOrderRejection(message) || isCancelIntent(message) || isNewOrderIntent(message)) return "cancel";
  const edited = applySummaryNegation([], message);
  if (explicitNegation(message) || edited.changed) return "edit";
  const text = normalizeMessageIntentText(message);
  if (/\b(es|era)\b/.test(text) && text.length > 8) return "edit";
  return "other";
}
