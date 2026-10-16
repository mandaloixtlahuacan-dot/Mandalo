import { searchAgentProducts, stripOrderVerbs } from "@/lib/orderAgent/catalog";
import { ORDER_AGENT_ESCALATE_AFTER, ORDER_AGENT_MAX_STEPS, orderAgentEscalationModel, orderAgentModel } from "@/lib/orderAgent/env";
import { createOpenAIOrderAgentModel } from "@/lib/orderAgent/model";
import { resolveAgentPending } from "@/lib/orderAgent/pending";
import { buildOrderAgentSystem } from "@/lib/orderAgent/prompt";
import { renderAgentReply } from "@/lib/orderAgent/reply";
import { upsertLine, validateToolCall, type AgentSearchHit } from "@/lib/orderAgent/validate";
import type {
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
import { isProductListYes, isYesConfirmation } from "@/lib/messages";

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

  if (input.awaitingList && !pending && broadYes(input.message) && cart.length > 0) {
    return finish({ cart, pending: null, reply: "", confirmedList: true });
  }

  if (pending) {
    seq += 1;
    const resolved = resolveAgentPending({
      pending,
      message: input.message,
      products,
      cart,
      nextLineId: `l${seq}`,
    });
    if (resolved) {
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

  const find = async (query: string): Promise<AgentProduct[]> => {
    const cleaned = stripOrderVerbs(query);
    const found = input.search ? (await input.search(cleaned)).filter((product) => product.available) : searchAgentProducts(products, cleaned, 8);
    for (const product of found) {
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
        system: buildOrderAgentSystem(input.store, cart),
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
        if (failures >= ORDER_AGENT_ESCALATE_AFTER && escalationModel && !escalated) {
          model = escalationModel;
          modelName = escalationModel.name;
          escalated = true;
        }
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
      }
      if (verdict.finished) finished = true;
    }
    if (!stepFailed && (finished || question)) break;
  }

  if (question) finished = false;
  if (changed && !question) pending = null;
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
