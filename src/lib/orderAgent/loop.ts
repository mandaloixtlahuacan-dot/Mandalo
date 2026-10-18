import { searchAgentProducts, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import { composeMessage, decideClause, lineFromDecision, messageIsNotAnOrder, type ClauseDecision } from "@/lib/orderAgent/compose";
import { ORDER_AGENT_ESCALATE_AFTER, ORDER_AGENT_MAX_STEPS, orderAgentEscalationModel, orderAgentModel } from "@/lib/orderAgent/env";
import { createOpenAIOrderAgentModel } from "@/lib/orderAgent/model";
import { resolveAgentPending } from "@/lib/orderAgent/pending";
import { buildOrderAgentSystem } from "@/lib/orderAgent/prompt";
import { formatMissingProduct, renderAgentReply } from "@/lib/orderAgent/reply";
import { clarificationFocus, presentationFromName, productClause, spokenMeasure, spokenPackageSize, uncoveredClauses } from "@/lib/orderAgent/match";
import { formatProductOptions, openClarifications, upsertLine, validateToolCall, type AgentSearchHit } from "@/lib/orderAgent/validate";
import type {
  AgentClarification,
  AgentLine,
  AgentModel,
  AgentPending,
  AgentProduct,
  AgentTurnLog,
  OrderAgentTurnInput,
  OrderAgentTurnResult,
  ToolCall,
  ToolTrace,
} from "@/lib/orderAgent/types";
import { foldAgent } from "@/lib/orderAgent/catalog";
import { confirmsShownProductList, isAffirmativeChatter, isProductListYes, isYesConfirmation } from "@/lib/messages";

/** «ete» pegado a chamberete. No es un producto que falte. */
function gluedToAddedName(label: string, decisions: ClauseDecision[]): boolean {
  const piece = foldAgent(label);
  if (!piece || piece.includes(" ") || piece.length > 4) return false;
  return decisions.some((decision) => {
    if (decision.kind !== "add" && decision.kind !== "ask") return false;
    const last = foldAgent(decision.clause).split(" ").filter(Boolean).at(-1) ?? "";
    if (last.length < 5) return false;
    const names = decision.kind === "add" ? [decision.product.name] : decision.products.map((product) => product.name);
    return names.some((name) => foldAgent(name).includes(`${last}${piece}`));
  });
}

function optionNamed(question: string, product: AgentProduct): boolean {
  const folded = foldAgent(question);
  const parts = [product.brand, product.name, product.presentation]
    .map((part) => foldAgent(part ?? ""))
    .filter((part) => part.length >= 3);
  return parts.some((part) => folded.includes(part));
}

function stripProgress(question: string): string {
  return question.replace(/^\*Producto \d+ de \d+\*\s*/i, "");
}

function withProgress(question: string, index: number, total: number): string {
  const body = stripProgress(question);
  if (total < 2 || index < 1) return body;
  return `*Producto ${index} de ${total}*\n\n${body}`;
}

function stampChain(items: AgentClarification[], start: number): AgentPending | null {
  if (!items.length) return null;
  const total = start + items.length - 1;
  const stamped = items.map((item, index) => ({
    ...item,
    question: withProgress(item.question, start + index, total),
  }));
  const [first, ...rest] = stamped;
  return { ...first, queue: rest };
}

function progressLine(question: string): string {
  return question.match(/\*Producto \d+ de \d+\*/)?.[0] ?? "";
}

/** Solo si la pregunta de verdad enumera opciones de una búsqueda. Un «¿algo más?» no deja pending. */
function pendingFromListedOptions(question: string, searches: AgentSearchHit[]): AgentPending | null {
  const folded = foldAgent(question);
  if (!folded || folded.includes("estan bien estos productos")) return null;
  if (!/[?¿]/.test(question)) return null;
  const hit = [...searches].reverse().find((item) => {
    const options = item.products.slice(0, 5);
    if (options.length < 2) return false;
    const named = options.filter((product) => optionNamed(question, product)).length;
    const numbered = (question.match(/(?:^|\n)\s*\d+[\.\)]/g) ?? []).length;
    return named >= 2 || numbered >= 2;
  });
  if (!hit) return null;
  const options = hit.products.slice(0, 5);
  return {
    question: question.trim(),
    candidateIds: options.map((product) => product.id),
    qty: null,
    unit: null,
    axis: null,
    query: hit.query,
  };
}

/** El kilo o los pesos se quedan en la pregunta aunque el producto todavía no se anote. */
function preferSpokenSize(message: string, query: string, products: AgentProduct[]): AgentProduct[] {
  const wanted = spokenPackageSize(productClause(message, query)) ?? spokenPackageSize(query);
  if (!wanted) return products;
  const front: AgentProduct[] = [];
  const rest: AgentProduct[] = [];
  for (const product of products) {
    if (presentationFromName(product.name)?.key === wanted) front.push(product);
    else rest.push(product);
  }
  return front.length ? [...front, ...rest] : products;
}

function rememberSpoken<T extends AgentPending>(message: string, pending: T): T {
  const apply = <I extends { query?: string | null; unit: AgentPending["unit"]; qty: number | null }>(item: I): I => {
    if (item.unit) return item;
    const spoken = spokenMeasure(message, item.query ?? "");
    if (!spoken || spoken.unit === "l") return item;
    return { ...item, qty: item.qty ?? spoken.qty, unit: spoken.unit };
  };
  const next = apply(pending);
  return { ...next, queue: (next.queue ?? []).map((item) => apply(item)) };
}

function dropCoveredQuestions(current: AgentPending | null, lines: AgentLine[]): AgentPending | null {
  const openQueue = (item: AgentPending): AgentClarification[] =>
    (item.queue ?? []).filter((entry) => !entry.query || uncoveredClauses(entry.query, lines, "").length > 0);
  let cursor = current;
  while (cursor?.query && uncoveredClauses(cursor.query, lines, "").length === 0) {
    const [next, ...rest] = openQueue(cursor);
    cursor = next ? { ...next, queue: rest } : null;
  }
  if (!cursor) return null;
  return { ...cursor, queue: openQueue(cursor) };
}

function dedupedQueue(current: AgentPending, extra: AgentClarification[]): AgentClarification[] {
  const seen = new Set<string>();
  const take = (query: string | null | undefined, question: string): boolean => {
    const key = foldAgent(query || question);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  take(current.query, current.question);
  const kept: AgentClarification[] = [];
  for (const item of [...(current.queue ?? []), ...extra]) {
    if (take(item.query, item.question)) kept.push(item);
  }
  return kept;
}

function withQueue(current: AgentPending | null, extra: AgentClarification[]): { pending: AgentPending | null; question: string | null } {
  if (!extra.length) return { pending: current, question: current?.question ?? null };
  if (!current?.question) {
    const [first, ...rest] = extra;
    return { question: first.question, pending: { ...first, queue: dedupedQueue({ ...first, queue: current?.queue ?? [] }, rest) } };
  }
  return {
    question: current.question,
    pending: { ...current, queue: dedupedQueue(current, extra) },
  };
}

function broadYes(message: string): boolean {
  if (isYesConfirmation(message) || isProductListYes(message)) return true;
  return /^(asi esta bien|todo bien|correcto|esta bien)$/.test(foldAgent(message));
}

/** «Ninguno» o «seguimos» sueltan la pregunta. No se vuelve a hacer igual. */
function dropsOpenQuestion(message: string): "reject" | "continue" | null {
  const text = foldAgent(message);
  if (!text) return null;
  if (/\b(ninguno|ninguna|ningunos|ningunas)\b/.test(text) || /\bno es ninguno\b/.test(text) || /\bno son esas\b/.test(text)) {
    return "reject";
  }
  if (/\bno son\b/.test(text) && /\b(correct\w*|mostrad\w*)\b/.test(text)) return "reject";
  if (/^(seguimos|sigue|continua|continuemos|es todo|nada mas|ya estaria|listo)$/.test(text)) return "continue";
  return null;
}

function looksLikeChoice(message: string): boolean {
  const text = foldAgent(message);
  return /^(?:(?:la|el|del|de|opcion|numero|pues|es)\s+)?(?:ese|esa|eso|ese mismo|esa misma|el primero|la primera|\d+)$/.test(text);
}

function asksToSeeOptions(message: string): boolean {
  const text = foldAgent(message);
  return /\b(cuales tienes|que tienes|cuales hay|que hay|que opciones|cuales son|muestrame|muestra|ensename)\b/.test(text);
}

function questionsWithOptions(pending: AgentPending, products: AgentProduct[], listStore: boolean): string {
  const lead = progressLine(pending.question);
  const prefix = lead ? `${lead}\n\n` : "";
  if (!listStore) return pending.question;
  const rows = pending.candidateIds
    .map((id) => products.find((product) => product.id === id))
    .filter((row): row is AgentProduct => Boolean(row));
  if (rows.length) return `${prefix}${formatProductOptions(pending.query || rows[0].name, rows, true)}`;
  return pending.question;
}

function removalQuestion(pending: AgentPending | null): boolean {
  return /deseas quitarlo de la lista/i.test(pending?.question ?? "");
}

function acceptsRemoval(message: string): boolean {
  const text = foldAgent(message);
  if (!/^(si|ok|va|dale|confirmo)\b/.test(text)) return false;
  return !/\b(agrega|anade|quiero|dame|cambia)\b/.test(text);
}

/** El cliente no está pidiendo productos: señala una opción, pregunta cuáles hay, o rechaza lo mostrado. */
function customerNotOrdering(message: string): boolean {
  if (messageIsNotAnOrder(message)) return true;
  const text = foldAgent(message);
  if (/\bno son\b/.test(text) && /\b(correct\w*|mostrad\w*)\b/.test(text)) return true;
  if (asksToSeeOptions(message) || /\b(cuales tienes|que tienes|cuales hay)\b/.test(text)) return true;
  return false;
}

function resolveAgentModels(input: OrderAgentTurnInput): { primary: AgentModel | null; escalation: AgentModel | null } {
  if (input.model === null) return { primary: null, escalation: null };
  if (input.model) {
    return { primary: input.model, escalation: input.escalationModel === undefined ? null : input.escalationModel };
  }
  const primary = createOpenAIOrderAgentModel(orderAgentModel());
  if (input.escalationModel === null) return { primary, escalation: null };
  if (input.escalationModel) return { primary, escalation: input.escalationModel };
  return { primary, escalation: createOpenAIOrderAgentModel(orderAgentEscalationModel()) };
}

function publicProduct(product: AgentProduct) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    presentation: product.presentation,
    price: product.price,
    unit: product.unit,
    variants: product.variants,
  };
}

async function writeLog(input: OrderAgentTurnInput, event: AgentTurnLog): Promise<void> {
  if (input.logEvent) {
    await input.logEvent(event);
    return;
  }
  if (!input.pedidoId) return;
  const { appendPedidoEvento } = await import("@/lib/repositories/pedidoRepositoryV2");
  await appendPedidoEvento({
    pedidoId: input.pedidoId,
    tipoEvento: "agent_turn",
    actorTipo: "sistema",
    payload: {
      tipo: "agent_turn",
      input: event.input,
      toolCalls: event.toolCalls,
      cart: event.cart,
      model: event.model,
      validationFailures: event.validationFailures,
    },
  }).catch((error: unknown) => {
    console.error("[orderAgent] no se pudo guardar agent_turn", error instanceof Error ? error.message : error);
  });
}

export async function runOrderAgentTurn(input: OrderAgentTurnInput): Promise<OrderAgentTurnResult> {
  let cart = input.cart.map((line) => ({ ...line }));
  let pending = input.pending;
  let seq = cart.reduce((max, line) => {
    const match = /^l(\d+)$/.exec(line.lineId);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const products = input.products.map((product) => ({ ...product }));
  const known = new Set(products.map((product) => product.id));
  let modelName = input.model?.name ?? "none";
  const trace: ToolTrace[] = [];
  let failures = 0;

  const finish = async (result: Omit<OrderAgentTurnResult, "storeId" | "toolCalls" | "validationFailures" | "model"> & { model?: string }): Promise<OrderAgentTurnResult> => {
    const full: OrderAgentTurnResult = {
      ...result,
      model: result.model ?? modelName,
      storeId: input.store.id,
      toolCalls: trace,
      validationFailures: failures,
    };
    await writeLog(input, {
      pedidoId: input.pedidoId ?? null,
      tipo: "agent_turn",
      input: input.message,
      toolCalls: trace,
      cart: full.cart,
      model: full.model,
      validationFailures: failures,
    });
    return full;
  };

  const lastAssistant = [...input.history].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
  const listWasShown = input.awaitingList === true || (!pending && lastAssistant.includes("¿Están bien estos productos?"));
  // La lista ya se mostró: sí, «así está bien», «ok sí», «1» o un sí con charla
  // confirman. Con awaitingList el «1» no elige una opción vieja. Un sí que agrega no entra.
  if (listWasShown && cart.length > 0 && confirmsShownProductList(input.message)) {
    return finish({ cart, pending: null, reply: "", confirmedList: true });
  }

  // «Sí, qué tal…» sin la lista a la vista no es un producto. Se vuelve a mostrar el carrito.
  if (!pending && isAffirmativeChatter(input.message) && cart.length > 0) {
    return finish({
      cart,
      pending: null,
      reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
      confirmedList: false,
    });
  }

  if (!pending && broadYes(input.message) && cart.length > 0) {
    return finish({
      cart,
      pending: null,
      reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
      confirmedList: false,
    });
  }

  const rememberProducts = (found: AgentProduct[]): void => {
    for (const product of found) {
      if (known.has(product.id)) continue;
      known.add(product.id);
      products.push(product);
    }
  };

  const searchQuery = async (query: string | null | undefined): Promise<AgentProduct[]> => {
    if (!input.search || !query?.trim()) return [];
    try {
      return (await input.search(query)).filter((product) => product.available);
    } catch {
      return [];
    }
  };

  if (pending && removalQuestion(pending) && acceptsRemoval(input.message)) {
    const next = pending.queue?.[0];
    if (next) {
      const pendingNext = { ...next, queue: pending.queue?.slice(1) ?? [] };
      const shown = questionsWithOptions(pendingNext, products, input.store.hasProductList === true) || next.question;
      return finish({
        cart,
        pending: pendingNext,
        reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
        confirmedList: false,
      });
    }
    return finish({
      cart,
      pending: null,
      reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
      confirmedList: false,
    });
  }

  if (pending) {
    if (pending.candidateIds.some((id) => !products.some((product) => product.id === id))) {
      rememberProducts(await searchQuery(pending.query));
    }
    seq += 1;
    const resolved = resolveAgentPending({
      pending,
      message: input.message,
      products,
      cart,
      nextLineId: `l${seq}`,
    });
    if (resolved) {
      const next = pending.queue?.[0];
      if (next) {
        const fresh = (await searchQuery(next.query)).slice(0, 5);
        const spoken = fresh.length > 1
          ? {
              ...next,
              question: `${progressLine(next.question) ? `${progressLine(next.question)}\n\n` : ""}${formatProductOptions(next.query ?? "", fresh)}`,
              candidateIds: fresh.map((product) => product.id),
            }
          : next;
        if (fresh.length) rememberProducts(fresh);
        const pendingNext = { ...spoken, queue: pending.queue?.slice(1) ?? [] };
        const shown = questionsWithOptions(pendingNext, products, input.store.hasProductList === true) || spoken.question;
        return finish({
          cart: resolved.cart,
          pending: pendingNext,
          reply: renderAgentReply({ store: input.store, cart: resolved.cart, question: shown, aside: null }),
          confirmedList: false,
        });
      }
      return finish({
        cart: resolved.cart,
        pending: null,
        reply: renderAgentReply({ store: input.store, cart: resolved.cart, question: null, aside: null }),
        confirmedList: false,
      });
    }
    const drop = dropsOpenQuestion(input.message);
    if (drop) {
      if (drop === "reject") {
        const banned = new Set(pending.candidateIds);
        cart = cart.filter((line) => line.productId == null || !banned.has(line.productId));
      }
      const next = pending.queue?.[0];
      const shortQuery = pending.query && foldAgent(pending.query).split(" ").filter((token) => token.length >= 3).length > 0
        ? pending.query
        : "";
      const label = shortQuery;
      if (next) {
        return finish({
          cart,
          pending: { ...next, queue: pending.queue?.slice(1) ?? [] },
          reply: renderAgentReply({
            store: input.store,
            cart,
            question: next.question,
            aside: drop === "reject" ? formatMissingProduct(label, false) : null,
          }),
          confirmedList: false,
        });
      }
      return finish({
        cart,
        pending: null,
        reply: renderAgentReply({
          store: input.store,
          cart,
          question: null,
          aside: drop === "reject" ? formatMissingProduct(label, cart.length > 0) : null,
        }),
        confirmedList: false,
      });
    }
    // «5» o «del 5» que no está en la lista: no se vuelve a preguntar lo mismo.
    if (looksLikeChoice(input.message) && removalQuestion(pending)) {
      const shown = questionsWithOptions(pending, products, input.store.hasProductList === true) || pending.question;
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
        confirmedList: false,
      });
    }
    if (looksLikeChoice(input.message)) {
      return finish({
        cart,
        pending: null,
        reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
        confirmedList: false,
      });
    }
    // «Cuáles tienes?», «¿qué opciones?», «qué hay», «muéstrame»: otra vez la lista, sin llamar al modelo.
    if (asksToSeeOptions(input.message) || (customerNotOrdering(input.message) && /^(?:cual|cuales|que)\b/.test(foldAgent(input.message)))) {
      for (const item of [pending, ...(pending.queue ?? [])]) {
        if (item.candidateIds.some((id) => !products.some((product) => product.id === id))) {
          rememberProducts(await searchQuery(item.query));
        }
      }
      const shown = questionsWithOptions(pending, products, input.store.hasProductList === true) || pending.question;
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
        confirmedList: false,
      });
    }
    if (input.store.hasProductList && /\b(quita|quitame|borra|elimina)\b/.test(foldAgent(input.message))) {
      const said = foldAgent(input.message);
      const kept = cart.filter((line) => {
        const tokens = foldAgent(line.name).split(" ").filter((token) => token.length >= 4);
        return !tokens.some((token) => said.includes(token));
      });
      if (kept.length !== cart.length) {
        const shown = questionsWithOptions(pending, products, true) || pending.question;
        return finish({
          cart: kept,
          pending,
          reply: renderAgentReply({ store: input.store, cart: kept, question: shown, aside: null }),
          confirmedList: false,
        });
      }
    }
    if (isAffirmativeChatter(input.message)) {
      const shown = questionsWithOptions(pending, products, input.store.hasProductList === true) || pending.question;
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
        confirmedList: false,
      });
    }
    if (customerNotOrdering(input.message) && foldAgent(input.message).split(" ").length <= 6) {
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: pending.question, aside: null }),
        confirmedList: false,
      });
    }
  }

  const focus = input.store.hasProductList ? clarificationFocus(input.message) : null;
  if (pending && focus) {
    const found = await searchQuery(focus);
    if (found.length) rememberProducts(found);
    const decision = decideClause(focus, found.length ? found : products, input.store);
    const typeWord = foldAgent(focus).split(" ").find((token) => token === "agua" || token === "aguas" || token === "leche" || token === "leches" || token === "refresco" || token === "refrescos");
    const stem = typeWord ? typeWord.replace(/s$/, "") : "";
    const dropStem = (lines: typeof cart) => {
      if (!stem) return lines;
      const word = new RegExp(`\\b${stem}\\b`);
      return lines.filter((line) => !word.test(foldAgent(line.name)));
    };
    if (decision.kind === "add") {
      seq += 1;
      const replacement = lineFromDecision(`l${seq}`, decision);
      cart = upsertLine(dropStem(cart), replacement);
      const shown = questionsWithOptions(pending, products, true) || pending.question;
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
        confirmedList: false,
      });
    }
    if (decision.kind === "ask" || decision.kind === "missing") {
      cart = dropStem(cart);
      const text = decision.kind === "missing"
        ? formatMissingProduct(decision.label, true)
        : formatProductOptions(decision.query, decision.products.slice(0, 5), true);
      if (text) {
        const ask: AgentClarification = decision.kind === "missing"
          ? { question: text, candidateIds: [], qty: null, unit: null, axis: null, query: decision.clause }
          : {
              question: text,
              candidateIds: decision.products.slice(0, 5).map((product) => product.id),
              qty: decision.qty,
              unit: decision.unit,
              axis: decision.products.length > 1 ? "size" : null,
              query: decision.clause,
            };
        const pendingNext = stampChain([ask, pending, ...(pending.queue ?? [])], 1) ?? { ...ask, queue: [pending, ...(pending.queue ?? [])] };
        const shown = questionsWithOptions(pendingNext, products, true) || text;
        return finish({
          cart,
          pending: pendingNext,
          reply: renderAgentReply({ store: input.store, cart, question: shown, aside: null }),
          confirmedList: false,
        });
      }
    }
  }

  if (!pending && cart.length > 0 && (dropsOpenQuestion(input.message) || customerNotOrdering(input.message))) {
    return finish({
      cart,
      pending: null,
      reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
      confirmedList: false,
    });
  }

  const resolvedModels = resolveAgentModels(input);
  const primary = resolvedModels.primary;
  if (!primary) {
    return finish({
      cart,
      pending,
      reply: renderAgentReply({ store: input.store, cart, question: pending?.question ?? null, aside: null }),
      confirmedList: false,
      model: "none",
    });
  }

  let model: AgentModel = primary;
  modelName = primary.name;
  const escalationModel = resolvedModels.escalation;
  let escalated = false;
  let question: string | null = null;
  let aside: string | null = null;
  let finished = false;
  let changed = false;
  let askedThisTurn = false;
  const repairErrors: string[] = [];
  const searches: AgentSearchHit[] = [];
  const failCounts = new Map<string, number>();
  let stalled = false;

  const callKey = (call: ToolCall): string => {
    const keys = Object.keys(call.arguments ?? {}).sort();
    const stable: Record<string, unknown> = {};
    for (const key of keys) stable[key] = call.arguments[key];
    return `${call.name}:${JSON.stringify(stable)}`;
  };

  const find = async (query: string): Promise<AgentProduct[]> => {
    const cleaned = stripOrderVerbs(query);
    const pool = input.search
      ? (await input.search(cleaned)).filter((product) => product.available)
      : searchAgentProducts(products, cleaned, 40);
    const found = preferSpokenSize(input.message, cleaned, pool);
    for (const product of found.slice(0, 8)) {
      if (known.has(product.id)) continue;
      known.add(product.id);
      products.push(product);
    }
    return found.slice(0, 8);
  };

  for (let step = 0; step < ORDER_AGENT_MAX_STEPS; step += 1) {
    let stepResult: { toolCalls: ToolCall[]; text: string | null };
    try {
      stepResult = await model.complete({
        system: buildOrderAgentSystem(input.store, cart, products, pending),
        history: input.history,
        cart,
        store: input.store,
        message: input.message,
        toolTrace: trace,
        repairErrors: repairErrors.slice(),
        pending,
      });
    } catch {
      break;
    }
    if (!stepResult.toolCalls.length) break;
    let stepFailed = false;
    for (const call of stepResult.toolCalls) {
      seq += 1;
      const verdict = validateToolCall({
        call,
        store: input.store,
        products,
        cart,
        pending,
        nextLineId: `l${seq}`,
        searches,
        customerMessage: input.message,
        askedThisTurn,
        awaitingList: input.awaitingList,
      });
      if (!verdict.ok) {
        failures += 1;
        stepFailed = true;
        repairErrors.push(verdict.error);
        if (verdict.customerNote) aside = verdict.customerNote;
        trace.push({ call, ok: false, result: { error: verdict.error } });
        const seen = (failCounts.get(callKey(call)) ?? 0) + 1;
        failCounts.set(callKey(call), seen);
        if (seen >= 2) stalled = true;
        if (failures >= ORDER_AGENT_ESCALATE_AFTER && escalationModel && !escalated) {
          model = escalationModel;
          modelName = escalationModel.name;
          escalated = true;
        }
        if (stalled) break;
        continue;
      }
      if (call.name === "search_products") {
        const found = await find(String(call.arguments.query ?? ""));
        searches.push({ query: String(call.arguments.query ?? ""), products: found });
        trace.push({ call, ok: true, result: found.map(publicProduct) });
        continue;
      }
      trace.push({ call, ok: true, result: { ok: true } });
      if (verdict.line) {
        cart = upsertLine(cart, verdict.line);
        changed = true;
      }
      if (verdict.removedId) {
        cart = cart.filter((line) => line.lineId !== verdict.removedId);
        changed = true;
      }
      if (verdict.question) {
        question = verdict.question.question;
        pending = verdict.question;
        askedThisTurn = true;
        break;
      }
      if (verdict.finished) finished = true;
    }
    if (stalled) break;
    if (!stepFailed && (finished || question)) break;
  }

  const covered = [
    ...(pending?.candidateIds ?? []),
    ...(pending?.queue ?? []).flatMap((item) => item.candidateIds),
  ];
  if (input.store.hasProductList || input.store.catalogMode === "fixed") {
    const extra = openClarifications({ searches, cart, coveredIds: covered, store: input.store });
    if (extra.length && !input.pending) {
      const attached = withQueue(question ? pending : null, extra);
      if (attached.question) {
        question = attached.question;
        pending = attached.pending;
      }
    } else if (extra.length && pending && question) {
      pending = { ...pending, queue: [...(pending.queue ?? []), ...extra] };
    }
    if (!input.pending) {
      const coveredText = [question ?? "", ...(pending?.queue ?? []).map((item) => `${item.question} ${item.query ?? ""}`)].join(" ");
      const missing = uncoveredClauses(input.message, cart, coveredText);
      const asks: AgentClarification[] = [];
      for (const clause of missing) {
        const found = await find(clause);
        const decision = decideClause(clause, found.length ? found : products, input.store);
        if (decision.kind !== "ask") continue;
        if (decision.products.some((product) => cart.some((line) => line.productId === product.id))) continue;
        const options = decision.products.slice(0, 5);
        if (options.length < 2 && !decision.marinade) continue;
        const text = decision.marinade
          ? `❓ *¿${options[0]?.name.replace(/\s+marinad[oa]s?\b/i, "").trim() || clause} marinada o normal?*\n\n_Responde marinada o normal. Si no, corrige o escribe cancelar._`
          : formatProductOptions(decision.query, options);
        asks.push({
          question: text,
          candidateIds: options.map((product) => product.id),
          qty: decision.qty,
          unit: decision.unit,
          axis: decision.marinade ? "marinade" : options.length > 1 ? "size" : null,
          query: decision.clause,
        });
      }
      if (asks.length) {
        const attached = withQueue(question ? pending : null, asks);
        if (attached.question) {
          question = attached.question;
          pending = attached.pending;
        }
      }
    }
    if (!input.pending && pending) pending = rememberSpoken(input.message, pending);
  }
  let composedReply = false;
  if ((input.store.hasProductList || input.store.catalogMode === "fixed") && !input.pending && !messageIsNotAnOrder(input.message)) {
    const decisions = await composeMessage({
      message: input.message,
      store: input.store,
      pool: products,
      search: async (query) => {
        const cleaned = stripOrderVerbs(query);
        const pool = input.search
          ? (await input.search(cleaned)).filter((product) => product.available)
          : searchAgentProducts(products, cleaned, 24);
        rememberProducts(pool);
        return pool.slice(0, 24);
      },
    });
    const missing: string[] = [];
    const asks: AgentClarification[] = [];
    const coveredIds = new Set<number>(cart.map((line) => line.productId).filter((id): id is number => id != null));
    for (const decision of decisions) {
      if (decision.kind === "skip") continue;
      if (decision.kind === "missing") {
        // «Chamber, ETE» parte el nombre. El pedazo corto no es otro producto.
        if (gluedToAddedName(decision.label, decisions)) continue;
        if (input.store.hasProductList) {
          const note = formatMissingProduct(decision.label, true);
          if (!note) continue;
          asks.push({
            question: note,
            candidateIds: [],
            qty: null,
            unit: null,
            axis: null,
            query: decision.clause,
          });
          continue;
        }
        missing.push(decision.label);
        continue;
      }
      if (decision.kind === "add") {
        const same = cart.some((line) =>
          line.productId === decision.product.id && (line.variant ?? null) === (decision.variant ?? null),
        );
        if (same) continue;
        if (input.store.hasProductList) {
          seq += 1;
          const verdict = validateToolCall({
            call: {
              id: `compose-${seq}`,
              name: "set_cart_line",
              arguments: {
                product_id: decision.product.id,
                qty: decision.qty,
                unit: decision.unit,
                variant: decision.variant,
              },
            },
            store: input.store,
            products,
            cart,
            pending,
            nextLineId: `l${seq}`,
            searches: [{ query: decision.clause, products: [decision.product] }],
            customerMessage: input.message,
          });
          if (!verdict.ok || !verdict.line) continue;
          cart = upsertLine(cart, verdict.line);
          coveredIds.add(decision.product.id);
          changed = true;
          continue;
        }
        seq += 1;
        cart = upsertLine(cart, lineFromDecision(`l${seq}`, decision));
        coveredIds.add(decision.product.id);
        changed = true;
        continue;
      }
      if (uncoveredClauses(decision.clause, cart, "").length === 0) continue;
      if (decision.products.some((product) => coveredIds.has(product.id))) continue;
      const cut = decision.products[0]?.name.replace(/\s+marinad[oa]s?\b/i, "").trim() || decision.query;
      const questionText = decision.marinade
        ? `❓ *¿${cut} marinada o normal?*\n\n_Responde marinada o normal. Si no, corrige o escribe cancelar._`
        : formatProductOptions(decision.query, decision.products);
      const ask: AgentClarification = {
        question: questionText,
        candidateIds: decision.products.slice(0, 5).map((product) => product.id),
        qty: decision.qty,
        unit: decision.unit,
        axis: decision.marinade ? "marinade" : decision.products.length > 1 ? "size" : null,
        query: decision.clause,
      };
      for (const id of ask.candidateIds) coveredIds.add(id);
      asks.push(ask);
    }
    composedReply = decisions.some((decision) => decision.kind !== "skip");
    if (missing.length) {
      const note = missing.map((label) => formatMissingProduct(label, true)).join("\n\n");
      aside = aside ? `${aside}\n\n${note}` : note;
    }
    // Lo que el modelo ya preguntó se queda. Aquí solo entra lo que dejó suelto.
    if (!input.pending && asks.length && !askedThisTurn) {
      // El orden del cliente gana. Una búsqueda suelta del modelo no se adelanta.
      // Si esa búsqueda ya traía más opciones del mismo producto, no se recortan.
      const [first, ...rest] = asks;
      const richer = Boolean(pending && foldAgent(pending.query ?? "") === foldAgent(first.query ?? "") && pending.candidateIds.length > 0);
      const head = richer && pending ? pending : first;
      question = head.question;
      pending = { ...head, queue: rest };
      finished = false;
    } else if (asks.length && !question) {
      const [first, ...rest] = asks;
      question = first.question;
      pending = { ...first, queue: [...(pending?.queue ?? []), ...rest] };
      finished = false;
    } else if (asks.length && pending) {
      pending = { ...pending, queue: dedupedQueue(pending, asks) };
      finished = false;
    }
  }
  if (!input.pending && pending) {
    pending = dropCoveredQuestions(pending, cart);
    question = pending?.question ?? null;
  }
  if (stalled && !question && !composedReply) {
    question = "No me quedó claro. Dime un producto, con marca o tamaño.";
    pending = { question, candidateIds: [], qty: null, unit: null, axis: null };
    finished = false;
  }
  if (question) finished = false;
  if (input.store.hasProductList && input.pending && !question && !input.awaitingList) {
    question = pending?.question ?? input.pending.question;
    pending = pending ?? input.pending;
    finished = false;
  }
  if (changed && !question) pending = null;
  if (question) {
    const fromText = pendingFromListedOptions(question, searches);
    if (fromText && (!pending || foldAgent(pending.question) !== foldAgent(question))) {
      pending = { ...fromText, queue: pending?.queue ?? [] };
    }
  }
  if (finished && !question) pending = null;
  if (input.store.hasProductList && pending && !input.pending && !progressLine(pending.question)) {
    const settled = Math.max(0, cart.length - input.cart.length);
    const items = [pending, ...(pending.queue ?? [])];
    const total = settled + items.length;
    const stamped = items.map((item, index) => ({
      ...item,
      question: withProgress(item.question, settled + index + 1, total),
    }));
    const [first, ...rest] = stamped;
    if (first) {
      pending = { ...first, queue: rest };
      question = pending.question;
    }
  }
  if (input.store.hasProductList && pending) {
    const shown = questionsWithOptions(pending, products, true);
    if (shown) question = shown;
    else if (!/1\. \*/.test(question ?? "")) {
      const label = pending.query || "";
      const note = formatMissingProduct(label, true);
      aside = aside ? `${aside}\n\n${note}` : note;
      question = null;
      pending = null;
    }
  }
  const lastBot = [...input.history].reverse().find((turn) => turn.role === "assistant")?.text?.trim() ?? "";
  let reply = renderAgentReply({
    store: input.store,
    cart,
    question: question ?? (finished ? null : pending?.question ?? null),
    aside,
  });
  if (lastBot && foldAgent(reply) === foldAgent(lastBot)) {
    const next = pending?.queue?.[0];
    if (next && foldAgent(next.question) !== foldAgent(lastBot)) {
      pending = { ...next, queue: pending?.queue?.slice(1) ?? [] };
      question = next.question;
    } else {
      question = null;
      pending = null;
    }
    reply = renderAgentReply({ store: input.store, cart, question, aside });
    if (foldAgent(reply) === foldAgent(lastBot)) {
      reply = `${reply}\n\n_Si ya está bien, responde sí. Si no, dime qué le cambio o escribe cancelar._`;
    }
  }
  return finish({
    cart,
    pending: finished ? null : pending,
    reply,
    confirmedList: false,
    model: modelName,
  });
}
