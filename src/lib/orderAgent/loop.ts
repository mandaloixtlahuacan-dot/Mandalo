import { searchAgentProducts, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import { composeMessage, lineFromDecision, messageIsNotAnOrder } from "@/lib/orderAgent/compose";
import { ORDER_AGENT_ESCALATE_AFTER, ORDER_AGENT_MAX_STEPS, orderAgentEscalationModel, orderAgentModel } from "@/lib/orderAgent/env";
import { createOpenAIOrderAgentModel } from "@/lib/orderAgent/model";
import { resolveAgentPending } from "@/lib/orderAgent/pending";
import { buildOrderAgentSystem } from "@/lib/orderAgent/prompt";
import { renderAgentReply } from "@/lib/orderAgent/reply";
import { contentTokens, presentationFromName, productClause, spokenMeasure, spokenPackageSize, uncoveredClauses } from "@/lib/orderAgent/match";
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

function unavailableHit(products: AgentProduct[], clause: string): boolean {
  const text = foldAgent(clause);
  return products.some((product) => {
    if (product.available) return false;
    return contentTokens(product.name).some((token) => token.length >= 5 && text.includes(token));
  });
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

function withQueue(current: AgentPending | null, extra: AgentClarification[]): { pending: AgentPending | null; question: string | null } {
  if (!extra.length) return { pending: current, question: current?.question ?? null };
  if (!current?.question) {
    const [first, ...rest] = extra;
    return { question: first.question, pending: { ...first, queue: [...(current?.queue ?? []), ...rest] } };
  }
  return {
    question: current.question,
    pending: { ...current, queue: [...(current.queue ?? []), ...extra] },
  };
}

function broadYes(message: string): boolean {
  if (isYesConfirmation(message) || isProductListYes(message)) return true;
  return /^(asi esta bien|todo bien|correcto|esta bien)$/.test(foldAgent(message));
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
    // «2», «está bien» o «de harina» contestan la pregunta. No se repite:
    // el tope de 60 s tiraba el duplicado y el cliente se quedaba en silencio.
  }

  const resolved = resolveAgentModels(input);
  const primary = resolved.primary;
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
  const escalationModel = resolved.escalation;
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
        system: buildOrderAgentSystem(input.store, cart, products),
        history: input.history,
        cart,
        store: input.store,
        message: input.message,
        toolTrace: trace,
        repairErrors: repairErrors.slice(),
      });
    } catch {
      break;
    }
    if (!stepResult.toolCalls.length) {
      if (stepResult.text && !question) question = stepResult.text;
      break;
    }
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
    const extra = openClarifications({ searches, cart, coveredIds: covered });
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
        const found = (await find(clause)).slice(0, 5);
        const lines = found.map((product, index) => `${index + 1}. ${product.name}`);
        const text = found.length
          ? `No encontré ${clause}, ¿cuál de estos?\n\n${lines.join("\n")}`
          : unavailableHit(products, clause)
            ? `Ahorita no tenemos ${clause}. ¿Quieres otra cosa del menú?`
            : `No encontré ${clause}. ¿Me dices la marca o el tamaño?`;
        asks.push({
          question: text,
          candidateIds: found.map((product) => product.id),
          qty: null,
          unit: null,
          axis: found.length > 1 ? "size" : null,
          query: clause,
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
    const fresh = cart.filter((line) => !input.cart.some((prior) => prior.lineId === line.lineId));
    if (decisions.some((decision) => decision.kind !== "skip")) {
      const priorIds = new Set(input.cart.map((line) => line.lineId));
      cart = cart.filter((line) => priorIds.has(line.lineId));
    }
    for (const decision of decisions) {
      if (decision.kind === "skip") continue;
      if (decision.kind === "missing") {
        missing.push(decision.label);
        continue;
      }
      if (decision.kind === "add") {
        seq += 1;
        const line = lineFromDecision(`l${seq}`, decision);
        const previous = fresh.find((item) => item.productId === line.productId);
        if (previous && line.qty === 1 && previous.qty !== 1) {
          line.qty = previous.qty;
          line.unit = previous.unit;
        }
        cart = upsertLine(cart, line);
        changed = true;
        continue;
      }
      const cut = decision.products[0]?.name.replace(/\s+marinad[oa]s?\b/i, "").trim() || decision.query;
      const questionText = decision.marinade
        ? `¿${cut} marinada o normal?`
        : formatProductOptions(decision.query, decision.products);
      asks.push({
        question: questionText,
        candidateIds: decision.products.slice(0, 5).map((product) => product.id),
        qty: decision.qty,
        unit: decision.unit,
        axis: decision.marinade ? "marinade" : decision.products.length > 1 ? "size" : null,
        query: decision.clause,
      });
    }
    composedReply = decisions.some((decision) => decision.kind !== "skip");
    if (missing.length) {
      const note = missing.map((label) => `No tenemos *${label}*.`).join(" ");
      aside = aside ? `${aside}\n\n${note}` : note;
    }
    if (asks.length) {
      const [first, ...rest] = asks;
      question = first.question;
      pending = { ...first, queue: rest };
      finished = false;
    } else if (changed || missing.length) {
      question = null;
      pending = null;
    }
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
  if (!pending && question) {
    const fromText = pendingFromListedOptions(question, searches);
    if (fromText) pending = fromText;
  }
  if (finished && input.awaitingList && cart.length > 0 && !question) {
    return finish({ cart, pending: null, reply: "", confirmedList: true, model: modelName });
  }
  const reply = renderAgentReply({
    store: input.store,
    cart,
    question: question ?? (finished ? null : pending?.question ?? null),
    aside,
  });
  return finish({
    cart,
    pending: finished ? null : pending,
    reply,
    confirmedList: false,
    model: modelName,
  });
}
