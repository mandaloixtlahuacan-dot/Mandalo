import { searchAgentProducts, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import { composeMessage, decideClause, lineFromDecision, messageIsNotAnOrder } from "@/lib/orderAgent/compose";
import { ORDER_AGENT_ESCALATE_AFTER, ORDER_AGENT_MAX_STEPS, orderAgentEscalationModel, orderAgentModel } from "@/lib/orderAgent/env";
import { createOpenAIOrderAgentModel } from "@/lib/orderAgent/model";
import { resolveAgentPending } from "@/lib/orderAgent/pending";
import { buildOrderAgentSystem } from "@/lib/orderAgent/prompt";
import { formatMissingProduct, renderAgentReply } from "@/lib/orderAgent/reply";
import { presentationFromName, productClause, spokenMeasure, spokenPackageSize, uncoveredClauses } from "@/lib/orderAgent/match";
import { formatProductOptions, openClarifications, upsertLine, validateToolCall, type AgentSearchHit } from "@/lib/orderAgent/validate";
import type {
  AgentClarification,
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
import { confirmsShownProductList, isProductListYes, isYesConfirmation } from "@/lib/messages";

function optionNamed(question: string, product: AgentProduct): boolean {
  const folded = foldAgent(question);
  const parts = [product.brand, product.name, product.presentation]
    .map((part) => foldAgent(part ?? ""))
    .filter((part) => part.length >= 3);
  return parts.some((part) => folded.includes(part));
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

/** El cliente no está pidiendo productos: señala una opción, pregunta cuáles hay, o rechaza lo mostrado. */
function customerNotOrdering(message: string): boolean {
  if (messageIsNotAnOrder(message)) return true;
  const text = foldAgent(message);
  if (/\bno son\b/.test(text) && /\b(correct\w*|mostrad\w*)\b/.test(text)) return true;
  if (/\b(cuales tienes|que tienes|cuales hay)\b/.test(text)) return true;
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

  // La lista ya se mostró: sí, «así está bien», «ok sí» o «1» confirman
  // aunque haya quedado una pregunta vieja. El «1» no elige esa opción.
  if (input.awaitingList && cart.length > 0 && confirmsShownProductList(input.message)) {
    return finish({ cart, pending: null, reply: "", confirmedList: true });
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
              question: formatProductOptions(next.query ?? "", fresh),
              candidateIds: fresh.map((product) => product.id),
            }
          : next;
        if (fresh.length) rememberProducts(fresh);
        return finish({
          cart: resolved.cart,
          pending: { ...spoken, queue: pending.queue?.slice(1) ?? [] },
          reply: renderAgentReply({ store: input.store, cart: resolved.cart, question: spoken.question, aside: null }),
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
      const shortQuery = pending.query && foldAgent(pending.query).split(" ").length <= 4 ? pending.query : "eso";
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
    if (looksLikeChoice(input.message)) {
      return finish({
        cart,
        pending: null,
        reply: renderAgentReply({ store: input.store, cart, question: null, aside: null }),
        confirmedList: false,
      });
    }
    // «Cuáles tienes?» vuelve a mostrar la lista. No se busca de nuevo.
    if (customerNotOrdering(input.message) && foldAgent(input.message).split(" ").length <= 6) {
      return finish({
        cart,
        pending,
        reply: renderAgentReply({ store: input.store, cart, question: pending.question, aside: null }),
        confirmedList: false,
      });
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
    const coveredIds = new Set<number>([
      ...cart.map((line) => line.productId).filter((id): id is number => id != null),
      ...(pending?.candidateIds ?? []),
    ]);
    for (const decision of decisions) {
      if (decision.kind === "skip") continue;
      if (decision.kind === "missing") {
        missing.push(decision.label);
        continue;
      }
      if (decision.kind === "add") {
        const same = cart.some((line) =>
          line.productId === decision.product.id && (line.variant ?? null) === (decision.variant ?? null),
        );
        if (same) continue;
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
      const note = missing.map((label) => formatMissingProduct(label, false)).join("\n\n");
      aside = aside ? `${aside}\n\n${note}` : note;
    }
    // Lo que el modelo ya preguntó se queda. Aquí solo entra lo que dejó suelto.
    if (asks.length && !question) {
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
  if (input.store.hasProductList && pending && (pending.queue?.length ?? 0) > 0 && !question && !input.awaitingList) {
    question = pending.question;
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
