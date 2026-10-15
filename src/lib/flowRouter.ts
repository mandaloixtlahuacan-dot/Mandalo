/**
 * Ruteo determinista del cliente. El agente solo entra en pedido o en una
 * corrección. Cambiar de tienda usa el mismo aviso que elegirla en el menú.
 */

import {
  buildGreeting,
  classifyCustomerTurn,
  isGreetingOnly,
  formatAbarrotesStoreAck,
  formatCatalogMenuCaption,
  formatNicheStoreList,
  matchNicheChoice,
  matchNicheTypo,
  nicheById,
  nicheIdForCategoria,
  nicheListedInLastBot,
  renderCustomerTurn,
  storeSwitchFromCapture,
  storesInNiche,
  storesMentionedInText,
  type CustomerTurn,
  type UxStore,
} from "@/lib/customerUx";
import {
  classifyProductListReply,
  isBareOrderRejection,
  isCancelIntent,
  isConversationModeMessage,
  isNewOrderIntent,
  isNoConfirmation,
  isYesConfirmation,
  messageCorrectsOrder,
  normalizeMessageIntentText,
} from "@/lib/messages";
import { isOrderingSmallTalk, reaskForPhase, type OrderPhase } from "@/lib/orderSession";
import { ADDRESS_ASK_MESSAGE } from "@/lib/services/captureEngine";
import { formatHour12, MANDALO_HORA_APERTURA, MANDALO_HORA_CIERRE } from "@/lib/services/businessHours";
import { formatMoney } from "@/lib/ordenes";

export type CustomerMedia = "text" | "sticker" | "image" | "audio" | "video" | "location";

export type CustomerFlowPhase =
  | OrderPhase
  | "esperando_tienda"
  | "esperando_repartidor"
  | "precio"
  | "ajuste"
  | "entregado";

export type FlowAction =
  | "reprompt"
  | "answer"
  | "switch_store"
  | "show_niche"
  | "restart"
  | "cancel"
  | "escalate_cancel"
  | "media"
  | "location_early"
  | "location_reject"
  | "need_pin"
  | "disambiguate"
  | "agent"
  | "summary"
  | "tracking"
  | "back"
  | "greeting";

export type FlowDecision = {
  effect: "handled" | "fallthrough";
  action: FlowAction;
  phase: CustomerFlowPhase;
  nicheId: string | null;
  text: string;
  rememberStoreId: number | null;
  clearStore: boolean;
  clearCart: boolean;
};

export type FlowCartLine = { nombre_producto: string; cantidad: number };

export type FlowRouteInput = {
  message: string;
  phase: CustomerFlowPhase;
  nicheId: string | null;
  store: UxStore | null;
  stores: UxStore[];
  items: FlowCartLine[];
  lastBotText: string;
  awaitingProductConfirm: boolean;
  media: CustomerMedia;
  locationInsideCoverage: boolean | null;
  orderId: number | null;
};

const ORDER_PHASES = new Set<OrderPhase>(["categoria", "tienda", "ejemplo", "pedido", "ubicacion", "resumen"]);

function asOrderPhase(phase: CustomerFlowPhase): OrderPhase {
  return ORDER_PHASES.has(phase as OrderPhase) ? (phase as OrderPhase) : "categoria";
}

function decision(partial: Omit<FlowDecision, "text" | "rememberStoreId" | "clearStore" | "clearCart"> & Partial<FlowDecision>): FlowDecision {
  return {
    text: "",
    rememberStoreId: null,
    clearStore: false,
    clearCart: false,
    ...partial,
  };
}

function norm(message: string): string {
  return normalizeMessageIntentText(message);
}

function whole(message: string): string {
  return norm(message)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEmojiOnly(message: string): boolean {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  const stripped = raw.replace(/\p{Extended_Pictographic}/gu, "").replace(/[\s\uFE0F\u200D]+/g, "");
  return stripped.length === 0;
}

function bareNumber(message: string): number | null {
  const match = whole(message).match(/^(?:opcion|la|el|numero)?\s*(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isBackPhrase(message: string): boolean {
  const text = whole(message);
  return text === "volver" || text === "atras" || text === "regresar" || text === "regresa";
}

function isMenuPhrase(message: string): boolean {
  const text = whole(message);
  return text === "menu" || text === "ver menu" || text === "el menu" || text === "pasame el menu";
}

function isOtherStorePhrase(message: string): boolean {
  const text = whole(message);
  if (!text || text.length > 60) return false;
  if (storesMentionedInText(message, []).length) return false;
  return (
    text === "otra tienda" ||
    text === "quiero de otra tienda" ||
    text === "de otra tienda" ||
    text === "cambiar tienda" ||
    text === "cambia de tienda" ||
    text === "cambiar de tienda" ||
    text === "cambia la tienda" ||
    /\b(otra tienda|cambiar tienda|cambia de tienda|cambiar de tienda)\b/.test(text)
  );
}

function questionKind(message: string): "fee" | "hours" | "have" | null {
  const text = whole(message);
  if (!text) return null;
  if (/cuanto (cuesta|sale|es|vale|cobran|serian)/.test(text) && /envio|servicio|mandado|entrega/.test(text)) return "fee";
  if (/^(precio|costo) del envio\b/.test(text) || text === "cuanto cuesta el envio" || text === "cuanto es el envio") return "fee";
  if (/a que hora (abren|abre|cierran|cierra)/.test(text) || /^(horario|hasta que hora|a que hora abren)$/.test(text)) return "hours";
  if (/^(tienen|tiene|hay|venden|vende)\b/.test(text) || /\b(tienen|tiene)\b.+\?/.test(String(message ?? ""))) return "have";
  return null;
}

function looksLikeStreetAddress(message: string): boolean {
  const text = whole(message);
  if (!text || text.length > 180) return false;
  if (/\b(calle|avenida|av|colonia|col|frente a|esquina|domicilio|entre la|numero|num|#|mz|manzana|lote|casa)\b/.test(text)) return true;
  return /\b\d{1,5}\b/.test(text) && /\b(hidalgo|juarez|morelos|allende|reforma|centro|ixtlahuacan)\b/.test(text);
}

function isProductEdit(message: string): boolean {
  if (messageCorrectsOrder(message)) return true;
  const text = whole(message);
  if (!text) return false;
  return (
    /\b(quita|quitame|quita le|no pedi|cambia|cambiale|agrega|agregale|son \d+|mejor grande|mejor chica|mejor chico|mejor mediana)\b/.test(text) ||
    text === "falta algo" ||
    text === "agrega" ||
    /^cambia .+ por .+/.test(text)
  );
}

function storeWelcome(store: UxStore): string {
  const turn: CustomerTurn = { type: "pick_store", store };
  const rendered = renderCustomerTurn(turn, [store], "");
  if (rendered?.kind === "text" || rendered?.kind === "menu") return rendered.text;
  return store.usaCatalogoFijo ? formatCatalogMenuCaption(store) : formatAbarrotesStoreAck(store);
}

function cartNotice(previous: UxStore | null, next: UxStore, items: FlowCartLine[]): string {
  if (!previous || previous.id === next.id || items.length === 0) return "";
  const lines = items
    .slice(0, 6)
    .map((item) => `${item.cantidad} ${item.nombre_producto}`.trim())
    .join(", ");
  const listed = lines ? ` Llevaba: ${lines}.` : "";
  return `🛵 Soltamos *${previous.nombre}* y lo que ya llevabas anotado.${listed}`;
}

function switchText(previous: UxStore | null, next: UxStore, items: FlowCartLine[]): string {
  const welcome = storeWelcome(next);
  const notice = cartNotice(previous, next, items);
  return notice ? `${notice}\n\n${welcome}` : welcome;
}

function nicheOf(store: UxStore | null, nicheId: string | null, lastBotText = ""): string | null {
  if (nicheId) return nicheId;
  const listed = nicheListedInLastBot(lastBotText);
  if (listed) return listed.id;
  if (!store) return null;
  return nicheIdForCategoria(store.categoria);
}

function repromptText(input: FlowRouteInput): { phase: CustomerFlowPhase; nicheId: string | null; text: string } {
  const phase = input.phase;
  const nicheId = nicheOf(input.store, input.nicheId, input.lastBotText);
  if (phase === "entregado") {
    return { phase: "categoria", nicheId: null, text: `Ese pedido ya se entregó.\n\n${buildGreeting()}` };
  }
  if (phase === "esperando_tienda") {
    const id = input.orderId ? `*Pedido #${input.orderId}*\n\n` : "";
    return {
      phase,
      nicheId,
      text: `🧾 ${id}Sigue con la tienda. Te aviso en cuanto haya precio o se pueda mandar.\n\nSi quieres otro, escribe *pedido nuevo*.`,
    };
  }
  if (phase === "esperando_repartidor") {
    const id = input.orderId ? `*Pedido #${input.orderId}*\n\n` : "";
    return {
      phase,
      nicheId,
      text: `🧾 ${id}Ese pedido ya va. No lo puedo cambiar desde aquí.\n\nSi pasa algo, lo veo con el equipo.`,
    };
  }
  if (phase === "precio" || phase === "resumen") {
    const id = input.orderId ? `*Pedido #${input.orderId}*\n\n` : "";
    return {
      phase,
      nicheId,
      text: `🧾 ${id}Sigo en el resumen.\n\nResponde *sí* si está bien, o dime qué le cambio.`,
    };
  }
  if (phase === "ajuste") {
    return { phase, nicheId, text: "Dime si lo quitamos o con qué lo cambiamos." };
  }
  if (phase === "ubicacion") {
    return { phase, nicheId, text: ADDRESS_ASK_MESSAGE };
  }
  if (phase === "pedido" && input.store && input.items.length) {
    const lines = input.items
      .slice(0, 8)
      .map((item) => `• ${item.cantidad} ${item.nombre_producto}`.trim())
      .join("\n");
    return {
      phase: "pedido",
      nicheId: null,
      text: `Sigo en *${input.store.nombre}*.\n\n${lines}\n\n¿Qué le quito, cambio o agrego?`,
    };
  }
  if ((phase === "pedido" || phase === "ejemplo") && input.store) {
    return { phase, nicheId: null, text: storeWelcome(input.store) };
  }
  if (phase === "tienda" && nicheId) {
    const niche = nicheById(nicheId);
    if (niche) return { phase: "tienda", nicheId, text: formatNicheStoreList(niche, input.stores) };
  }
  const asked = reaskForPhase({
    phase: asOrderPhase(phase),
    nicheId,
    lastBotText: input.lastBotText,
    stores: input.stores,
    businessId: input.store?.id ?? null,
  });
  return { phase: asked.phase, nicheId: asked.nicheId, text: asked.text };
}

function withReprompt(input: FlowRouteInput, lead: string, action: FlowAction): FlowDecision {
  const again = repromptText(input);
  const text = lead ? `${lead}\n\n${again.text}` : again.text;
  return decision({
    effect: "handled",
    action,
    phase: again.phase,
    nicheId: again.nicheId,
    text,
  });
}

function answerFor(input: FlowRouteInput, kind: "fee" | "hours" | "have"): string {
  if (kind === "fee") {
    return `El envío y servicio son ${formatMoney(35)}, en una sola línea.`;
  }
  const open = formatHour12(MANDALO_HORA_APERTURA);
  const close = formatHour12(MANDALO_HORA_CIERRE);
  const mandalo = `Por ahora Mándalo reparte de ${open} a ${close}.`;
  if (!input.store) return `${mandalo} El horario de la tienda te lo digo cuando la elijas.`;
  const shop = input.store.abierta
    ? `*${input.store.nombre}* está abierta ahora.`
    : `*${input.store.nombre}* está cerrada${input.store.abreTexto ? ` (${input.store.abreTexto})` : ""}. Lo armamos y se manda en cuanto abra.`;
  return `${mandalo} ${shop}`;
}

function haveAnswer(input: FlowRouteInput): string {
  if (!input.store) return "Primero elige la tienda y te confirmo si lo anoto.";
  if (input.store.usaCatalogoFijo) return `En *${input.store.nombre}* pídemelo como sale en el menú.`;
  return `En *${input.store.nombre}* la tienda confirma si lo tiene. Pídemelo con marca y tamaño.`;
}

function handledSwitch(input: FlowRouteInput, store: UxStore): FlowDecision {
  const locked = input.phase === "esperando_tienda" || input.phase === "esperando_repartidor" || input.phase === "precio";
  if (locked) {
    return withReprompt(input, "Ese pedido ya salió de la tienda que elegiste. Para otro, escribe *pedido nuevo*.", "tracking");
  }
  const nicheId = nicheIdForCategoria(store.categoria);
  return decision({
    effect: "handled",
    action: "switch_store",
    phase: "ejemplo",
    nicheId,
    text: switchText(input.store, store, input.items),
    rememberStoreId: store.id,
    clearStore: false,
    clearCart: input.store != null && input.store.id !== store.id && input.items.length > 0,
  });
}

function showNiche(input: FlowRouteInput, nicheId: string, release: boolean): FlowDecision {
  const niche = nicheById(nicheId);
  const text = niche
    ? renderCustomerTurn(
        { type: "show_niche", nicheId, releaseHeldStore: release },
        input.stores,
        input.lastBotText,
      )?.kind === "text"
      ? (renderCustomerTurn({ type: "show_niche", nicheId, releaseHeldStore: release }, input.stores, input.lastBotText) as { text: string }).text
      : formatNicheStoreList(niche, input.stores)
    : buildGreeting();
  return decision({
    effect: "handled",
    action: "show_niche",
    phase: "tienda",
    nicheId,
    text,
    clearStore: release,
    clearCart: release && input.items.length > 0,
  });
}

function fallthrough(input: FlowRouteInput, action: FlowAction): FlowDecision {
  return decision({
    effect: "fallthrough",
    action,
    phase: input.phase,
    nicheId: input.nicheId,
  });
}

export function routeCustomerFlow(input: FlowRouteInput): FlowDecision {
  const message = String(input.message ?? "");
  const text = whole(message);

  if (input.media === "location" && input.locationInsideCoverage === false) {
    return decision({
      effect: "handled",
      action: "location_reject",
      phase: input.phase,
      nicheId: input.nicheId,
      text:
        "📍 *Por ahora Mándalo solo cubre entregas dentro de Ixtlahuacán del Río.*\n\n" +
        "Tu ubicación quedó fuera de esa zona.\n\nEn cuanto ampliemos la cobertura te avisamos. ¡Gracias por tu interés!",
    });
  }

  if (input.media === "sticker" || input.media === "image" || input.media === "audio" || input.media === "video") {
    return withReprompt(input, "Eso no lo puedo leer por aquí. Escríbeme con palabras.", "media");
  }

  if (input.media === "location") {
    const ready = input.phase === "ubicacion" || input.phase === "resumen" || input.phase === "precio";
    if (!ready) {
      return withReprompt(input, "El pin lo uso para la entrega, cuando ya esté armado el pedido.", "location_early");
    }
    return fallthrough(input, "summary");
  }

  if (!text && !isEmojiOnly(message)) {
    return withReprompt(input, "", "reprompt");
  }

  const pastFree = input.phase === "esperando_repartidor";
  if (isNewOrderIntent(message) || text === "menu principal") {
    if (pastFree) {
      return withReprompt(
        input,
        input.orderId
          ? `🧾 *Pedido #${input.orderId}*\n\nYa está en proceso avanzado, así que no puedo cancelarlo yo solo.\n\nYa avisé a nuestro equipo.`
          : "Ese pedido ya va. Ya avisé a nuestro equipo.",
        "escalate_cancel",
      );
    }
    const lead = isNewOrderIntent(message)
      ? `✅ *Pedido anterior cancelado.*\n\n${buildGreeting()}`
      : `✅ *Pedido anterior cancelado.*\n\n${buildGreeting()}`;
    return decision({
      effect: "handled",
      action: "restart",
      phase: "categoria",
      nicheId: null,
      text: lead,
      clearStore: true,
      clearCart: true,
    });
  }

  if (isCancelIntent(message) && !isProductEdit(message)) {
    if (pastFree) {
      return decision({
        effect: "handled",
        action: "escalate_cancel",
        phase: input.phase,
        nicheId: input.nicheId,
        text: input.orderId
          ? `🧾 *Pedido #${input.orderId}*\n\nYa está en proceso avanzado, así que no puedo cancelarlo yo solo.\n\nYa avisé a nuestro equipo. Te van a contactar directo.`
          : "Ese pedido ya va. Ya avisé a nuestro equipo.",
      });
    }
    return decision({
      effect: "handled",
      action: "cancel",
      phase: "categoria",
      nicheId: null,
      text: `✅ *Listo, cancelé tu pedido.*\n\nCuando quieras hacer uno nuevo, aquí estoy.\n\n${buildGreeting()}`,
      clearStore: true,
      clearCart: true,
    });
  }

  if (isEmojiOnly(message)) {
    return withReprompt(input, "Con un emoji no alcanzo a anotar el pedido.", "reprompt");
  }

  const asked = questionKind(message);
  if (asked) {
    const lead = asked === "have" ? haveAnswer(input) : answerFor(input, asked);
    return withReprompt(input, lead, "answer");
  }

  const named = storesMentionedInText(message, input.stores);
  if (named.length >= 2) {
    const lines = named.map((store, index) => `${index + 1}. *${store.nombre}*`).join("\n\n");
    return withReprompt(
      input,
      `Un pedido es de una sola tienda.\n\n${lines}\n\nDime solo el nombre de una.`,
      "disambiguate",
    );
  }

  if (isBackPhrase(message)) {
    return stepBack(input);
  }

  if (isMenuPhrase(message)) {
    return showCurrentMenu(input);
  }

  if (isOtherStorePhrase(message) && named.length === 0) {
    const nicheId = nicheOf(input.store, input.nicheId, input.lastBotText);
    if (input.phase === "esperando_repartidor" || input.phase === "esperando_tienda" || input.phase === "precio") {
      return withReprompt(input, "Ese pedido ya va con la tienda elegida.", "tracking");
    }
    if (!nicheId) return withReprompt(input, "Va, elige de nuevo.", "reprompt");
    const had = input.store != null;
    return showNiche(input, nicheId, had);
  }

  const number = bareNumber(message);
  if (number != null) {
    if (input.phase === "categoria" || (input.phase === "entregado" && !input.store)) {
      const niche = matchNicheChoice(String(number));
      if (niche) return showNiche({ ...input, store: null, items: [] }, niche.id, false);
      return withReprompt(input, "Ese número no está en la lista.", "reprompt");
    }
    if (input.phase === "tienda") {
      const nicheId = nicheOf(input.store, input.nicheId, input.lastBotText);
      const niche = nicheId ? nicheById(nicheId) : null;
      const picked = niche ? storesInNiche(input.stores, niche.id)[number - 1] : null;
      if (picked) return handledSwitch({ ...input, items: input.store && input.store.id !== picked.id ? input.items : [] }, picked);
      return withReprompt(input, "Ese número no está en la lista.", "reprompt");
    }
    if (!input.awaitingProductConfirm) {
      return withReprompt(input, "El número solo no me dice el producto.", "reprompt");
    }
  }

  const typo = matchNicheTypo(message);
  if (typo && text.length <= 24) {
    const current = input.store ? nicheIdForCategoria(input.store.categoria) : null;
    if (!(input.store && current === typo.id && input.phase !== "categoria" && input.phase !== "entregado")) {
      const release = Boolean(input.store && current && current !== typo.id);
      if (input.phase === "esperando_repartidor" || input.phase === "esperando_tienda" || input.phase === "precio") {
        return withReprompt(input, "Ese pedido ya va. Para otro, escribe *pedido nuevo*.", "tracking");
      }
      return showNiche(input, typo.id, release);
    }
  }

  if (looksLikeStreetAddress(message)) {
    if (input.phase === "ubicacion" || input.phase === "resumen" || input.phase === "precio") {
      return decision({
        effect: "handled",
        action: "need_pin",
        phase: input.phase === "precio" ? "precio" : input.phase === "resumen" ? "resumen" : "ubicacion",
        nicheId: input.nicheId,
        text: `Para cubrir el pueblo necesito el pin de WhatsApp, no la dirección escrita.\n\n${ADDRESS_ASK_MESSAGE}`,
      });
    }
    return withReprompt(input, "La dirección va con el pin de WhatsApp, más adelante.", "need_pin");
  }

  const switched = storeSwitchFromCapture({
    message,
    stores: input.stores,
    currentStoreId: input.store?.id ?? null,
    orderInProgress: input.items.length > 0 || input.phase === "pedido" || input.phase === "ubicacion" || input.phase === "resumen",
  });
  if (switched) return handledSwitch(input, switched);

  if (named.length === 1 && input.store && named[0].id === input.store.id) {
    const locked = input.phase === "esperando_tienda" || input.phase === "esperando_repartidor" || input.phase === "precio";
    if (locked) {
      return withReprompt(input, "Ese pedido ya salió de la tienda que elegiste. Para otro, escribe *pedido nuevo*.", "tracking");
    }
    const again = classifyCustomerTurn({
      message,
      lastBotText: input.lastBotText,
      hasBusiness: true,
      hasItems: input.items.length > 0,
      businessId: input.store.id,
      stores: input.stores,
    });
    if (again.type === "pick_store") {
      return decision({
        effect: "handled",
        action: "switch_store",
        phase: "ejemplo",
        nicheId: nicheIdForCategoria(named[0].categoria),
        text: storeWelcome(named[0]),
        rememberStoreId: named[0].id,
        clearCart: false,
      });
    }
  }

  if (isGreetingOnly(message) || isConversationModeMessage(message) || isOrderingSmallTalk(message)) {
    if (input.phase === "categoria" || input.phase === "entregado") {
      return decision({
        effect: "handled",
        action: "greeting",
        phase: "categoria",
        nicheId: null,
        text: input.phase === "entregado" ? `Ese pedido ya se entregó.\n\n${buildGreeting()}` : buildGreeting(),
      });
    }
    return withReprompt(input, "", "greeting");
  }

  if (input.phase === "resumen" || input.phase === "precio" || input.phase === "ajuste") {
    if (isYesConfirmation(message) || isNoConfirmation(message) || isBareOrderRejection(message) || isProductEdit(message)) {
      return fallthrough(input, "summary");
    }
    if (input.phase === "ajuste") return fallthrough(input, "summary");
    return withReprompt(input, "", "reprompt");
  }

  if (input.awaitingProductConfirm && input.phase === "pedido") {
    const kind = classifyProductListReply(message);
    if (kind === "confirm" || kind === "revise" || kind === "relist" || kind === "cancel") return fallthrough(input, "summary");
  }

  if ((input.phase === "ejemplo" || input.phase === "pedido") && input.store) {
    const bareYes = isYesConfirmation(message) && !input.awaitingProductConfirm;
    const bareNo = /^(no|nel|nop|nope)$/.test(text) && !input.awaitingProductConfirm;
    if (bareYes || bareNo) return withReprompt(input, "", "reprompt");
    if (isProductEdit(message) || text.length > 0) {
      return fallthrough({ ...input, phase: "pedido" }, "agent");
    }
  }

  if (input.phase === "ubicacion") {
    if (isProductEdit(message)) return fallthrough({ ...input, phase: "pedido" }, "agent");
    return withReprompt(input, "", "reprompt");
  }

  if (input.phase === "esperando_tienda" || input.phase === "esperando_repartidor") {
    return withReprompt(input, "", "tracking");
  }

  if (text.length > 280) {
    return withReprompt(input, "Se me fue largo. Vamos por partes.", "reprompt");
  }

  return withReprompt(input, "", "reprompt");
}

function showCurrentMenu(input: FlowRouteInput): FlowDecision {
  if (input.phase === "esperando_repartidor" || input.phase === "esperando_tienda" || input.phase === "precio") {
    return withReprompt(input, "", "tracking");
  }
  if (input.store && (input.phase === "ejemplo" || input.phase === "pedido" || input.phase === "ubicacion" || input.phase === "resumen")) {
    return decision({
      effect: "handled",
      action: "reprompt",
      phase: input.items.length ? input.phase : "ejemplo",
      nicheId: nicheOf(input.store, input.nicheId),
      text: storeWelcome(input.store),
    });
  }
  const nicheId = nicheOf(input.store, input.nicheId, input.lastBotText);
  if (input.phase === "tienda" && nicheId) return showNiche(input, nicheId, false);
  return decision({
    effect: "handled",
    action: "greeting",
    phase: "categoria",
    nicheId: null,
    text: buildGreeting(),
  });
}

function stepBack(input: FlowRouteInput): FlowDecision {
  if (input.phase === "esperando_repartidor" || input.phase === "esperando_tienda" || input.phase === "precio" || input.phase === "entregado") {
    return withReprompt(input, "", input.phase === "entregado" ? "greeting" : "tracking");
  }
  if (input.phase === "tienda" || input.phase === "categoria") {
    return decision({
      effect: "handled",
      action: "back",
      phase: "categoria",
      nicheId: null,
      text: buildGreeting(),
      clearStore: input.phase === "tienda",
    });
  }
  if (input.phase === "ejemplo") {
    const nicheId = nicheOf(input.store, input.nicheId, input.lastBotText);
    if (nicheId) return showNiche(input, nicheId, true);
    return decision({
      effect: "handled",
      action: "back",
      phase: "categoria",
      nicheId: null,
      text: buildGreeting(),
      clearStore: true,
    });
  }
  if (input.phase === "pedido" || input.phase === "ubicacion" || input.phase === "resumen" || input.phase === "ajuste") {
    if (input.store) {
      const note = input.items.length ? `Sigo con lo anotado en *${input.store.nombre}*.\n\n` : "";
      return decision({
        effect: "handled",
        action: "back",
        phase: input.items.length ? "pedido" : "ejemplo",
        nicheId: null,
        text: `${note}${storeWelcome(input.store)}`,
      });
    }
  }
  return withReprompt(input, "", "back");
}

export function storeWelcomeMatchesMenu(store: UxStore, text: string): boolean {
  return text === storeWelcome(store) || text.endsWith(storeWelcome(store));
}
