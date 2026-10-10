import { checkAiOutput } from "@/lib/catalogOrder/accept";
import { cartFromModel, fallbackInterpret } from "@/lib/catalogOrder/fallback";
import { createOpenAICatalogModel } from "@/lib/catalogOrder/parser";
import { buildAiReply, buildCatalogReply } from "@/lib/catalogOrder/reply";
import { classifyProductListReply } from "@/lib/messages";
import type { AiOutput, CatalogEngineMode, CatalogTurnInput, CatalogTurnResult, InterpretRequest } from "@/lib/catalogOrder/types";

const REPEAT = "No le entendí. Repítemelo con palabras sencillas.";

export function catalogEngineMode(): CatalogEngineMode {
  const value = String(process.env.CATALOG_ENGINE ?? "").trim().toLowerCase();
  if (value === "legacy") return "legacy";
  if (value === "v1") return "v1";
  return "v2";
}

export function catalogEngineIsLegacy(): boolean {
  return catalogEngineMode() === "legacy";
}

function logTurn(result: CatalogTurnResult): void {
  if (process.env.CATALOG_ORDER_QUIET === "1") return;
  console.log(
    `[catalogOrder] model=${result.model} ms=${result.ms} intent=${result.intent} cart=${result.cart.length} unmatched=${result.unmatched.length} fallback=${result.fallback}`,
  );
}

function requestOf(input: CatalogTurnInput, repairErrors?: string[]): InterpretRequest {
  return {
    catalog: input.catalog,
    cart: input.cart,
    pending: input.pending,
    history: [],
    message: input.message,
    awaitingList: input.awaitingList,
    repairErrors,
  };
}

function finish(started: number, result: CatalogTurnResult): CatalogTurnResult {
  result.ms = Date.now() - started;
  logTurn(result);
  return result;
}

function fromFallback(input: CatalogTurnInput, started: number, modelName: string): CatalogTurnResult {
  const output = fallbackInterpret({
    message: input.message,
    cart: input.cart,
    pending: input.pending,
    catalog: input.catalog,
  });
  const cart = cartFromModel(output.cart);
  const confirmedList = output.intent === "confirm" && input.awaitingList === true && output.unmatched.length === 0 && cart.length > 0;
  const spoken = buildCatalogReply({
    catalog: input.catalog,
    cart,
    unmatched: output.unmatched,
    pending: output.pendingAsk ?? input.pending,
    confirmedList,
  });
  return finish(started, {
    cart,
    pending: spoken.pending,
    reply: spoken.reply,
    intent: output.intent,
    fallback: true,
    model: modelName,
    ms: 0,
    unmatched: output.unmatched,
    freeText: [],
    confirmedList,
  });
}

function keepPrevious(input: CatalogTurnInput, started: number, modelName: string): CatalogTurnResult {
  return finish(started, {
    cart: input.cart.map((line) => ({ ...line })),
    pending: input.pending,
    reply: REPEAT,
    intent: "other",
    fallback: false,
    model: modelName,
    ms: 0,
    unmatched: [],
    freeText: [],
    confirmedList: false,
  });
}

function confirmPrevious(input: CatalogTurnInput, started: number, modelName: string): CatalogTurnResult {
  const cart = input.cart.map((line) => ({ ...line }));
  return finish(started, {
    cart,
    pending: null,
    reply: "",
    intent: "confirm",
    fallback: false,
    model: modelName,
    ms: 0,
    unmatched: [],
    freeText: [],
    confirmedList: cart.length > 0,
  });
}

async function runAiTurn(input: CatalogTurnInput): Promise<CatalogTurnResult> {
  const started = Date.now();
  const model = input.model === undefined ? createOpenAICatalogModel() : input.model;
  const modelName = model?.name ?? "fallback";

  if (input.awaitingList && classifyProductListReply(input.message) === "confirm") {
    return confirmPrevious(input, started, modelName);
  }

  if (!model) return fromFallback(input, started, "fallback");

  let output: AiOutput | null = null;
  try {
    output = await model.interpret(requestOf(input));
  } catch {
    output = null;
  }
  if (!output) return fromFallback(input, started, "fallback");

  let checked = checkAiOutput(output, input.catalog);
  if (checked.errors.length) {
    let repaired: AiOutput | null = null;
    try {
      repaired = await model.interpret(requestOf(input, checked.errors));
    } catch {
      repaired = null;
    }
    if (!repaired) return fromFallback(input, started, "fallback");
    output = repaired;
    checked = checkAiOutput(output, input.catalog);
    if (checked.errors.length) return keepPrevious(input, started, modelName);
  }

  const question = output.question?.text.trim()
    ? { text: output.question.text.trim(), candidateIds: output.question.candidate_ids }
    : null;
  const notOnMenu = output.not_on_menu.map((item) => item.trim()).filter(Boolean);
  const confirmedList = false;
  const spoken = buildAiReply({
    catalog: input.catalog,
    cart: checked.cart,
    notOnMenu,
    question,
    pending: input.pending,
    confirmedList,
  });
  const intent = question ? "question" : notOnMenu.length && !checked.cart.length ? "other" : "order";
  return finish(started, {
    cart: checked.cart,
    pending: spoken.pending,
    reply: spoken.reply,
    intent,
    fallback: false,
    model: modelName,
    ms: 0,
    unmatched: notOnMenu.map((source_text) => ({ source_text, reason: "not_on_menu" as const, candidate_ids: [] })),
    freeText: [],
    confirmedList,
  });
}

export async function runCatalogOrderTurn(input: CatalogTurnInput): Promise<CatalogTurnResult> {
  if (catalogEngineMode() === "v1") {
    const { runV1CatalogOrderTurn } = await import("@/lib/catalogOrder/v1/engine");
    return runV1CatalogOrderTurn(input);
  }
  return runAiTurn(input);
}
