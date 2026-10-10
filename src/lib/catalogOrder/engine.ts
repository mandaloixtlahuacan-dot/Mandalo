import { checkAiOutput, type AcceptedQuestion, type CheckResult } from "@/lib/catalogOrder/accept";
import { cartFromModel, fallbackInterpret } from "@/lib/catalogOrder/fallback";
import { createOpenAICatalogModel } from "@/lib/catalogOrder/parser";
import { buildAiReply, buildCatalogReply } from "@/lib/catalogOrder/reply";
import { fold } from "@/lib/catalogOrder/text";
import { classifyProductListReply } from "@/lib/messages";
import type { AiOutput, CartLine, CatalogEngineMode, CatalogRow, CatalogSnapshot, CatalogTurnInput, CatalogTurnResult, InterpretRequest } from "@/lib/catalogOrder/types";

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

function cartKey(line: CartLine): string {
  return `${line.productId}|${line.qty}|${line.unit}|${line.variant ?? ""}`;
}

function sameCart(left: CartLine[], right: CartLine[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(cartKey).sort();
  const b = right.map(cartKey).sort();
  return a.every((item, index) => item === b[index]);
}

function plain(message: string): string {
  return fold(message).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function messageConfirms(message: string): boolean {
  return /^(ya seria todo|ya serian todo|eso es todo|eso seria todo|es todo|seria todo|ya esta|asi esta bien|esta bien|asi dejalo|listo)$/.test(plain(message));
}

/** Cierre o sí. Con pregunta abierta no confirma, en cualquier paso. */
function closesOrder(message: string): boolean {
  return messageConfirms(message) || classifyProductListReply(message) === "confirm";
}

function isPureSwap(message: string): boolean {
  return /\b(?:un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s+de\s+(?:esas|esos|ellas|ellos)\b/.test(plain(message));
}

function totalsByUnit(cart: CartLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of cart) totals.set(line.unit, (totals.get(line.unit) ?? 0) + line.qty);
  return totals;
}

/** En «una de esas/ellas» el total de la familia no puede cambiar. */
function pureSwapError(message: string, prior: CartLine[], next: CartLine[]): string | null {
  if (!prior.length || !isPureSwap(message)) return null;
  const left = totalsByUnit(prior);
  const right = totalsByUnit(next);
  const units = new Set([...left.keys(), ...right.keys()]);
  for (const unit of units) {
    if (Math.abs((left.get(unit) ?? 0) - (right.get(unit) ?? 0)) > 0.01) {
      return "Es un cambio de una parte: la cantidad total tiene que quedar igual. Mueve esas piezas de la línea original a la nueva, sin sumar ni quitar.";
    }
  }
  return null;
}

function mentionedRows(message: string, catalog: CatalogSnapshot): CatalogRow[] {
  let text = ` ${plain(message)} `;
  const rows = [...catalog.rows].sort((a, b) => fold(b.name).length - fold(a.name).length);
  const found: CatalogRow[] = [];
  for (const row of rows) {
    const name = fold(row.name);
    if (name.length < 8) continue;
    const needle = ` ${name} `;
    if (!text.includes(needle)) continue;
    found.push(row);
    text = text.split(needle).join(" ");
  }
  return found;
}

/** Si las palabras son el nombre exacto de una fila, esa fila gana sobre la marinada. */
function preferExactName(message: string, checked: CheckResult, catalog: CatalogSnapshot): CheckResult {
  const mentioned = mentionedRows(message, catalog);
  if (!mentioned.length) return checked;
  const mentionedIds = new Set(mentioned.map((row) => row.id));
  let changed = false;
  const cart = checked.cart.map((line) => {
    const chosen = catalog.byId.get(line.productId);
    if (!chosen || mentionedIds.has(chosen.id)) return line;
    const exact = mentioned.find((row) => fold(chosen.name).startsWith(`${fold(row.name)} marinad`));
    if (!exact) return line;
    changed = true;
    return { ...line, productId: exact.id };
  });
  return changed ? { ...checked, cart } : checked;
}

function acceptChecked(input: CatalogTurnInput, output: AiOutput): CheckResult {
  return preferExactName(input.message, checkAiOutput(output, input.catalog), input.catalog);
}

function useful(checked: CheckResult): boolean {
  return checked.cart.length > 0 || checked.pending.length > 0 || checked.notOnMenu.length > 0;
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

/** El modelo no dejó nada usable. Si ya había líneas, se quedan y se vuelve a preguntar. */
function holdCart(input: CatalogTurnInput, started: number, modelName: string): CatalogTurnResult {
  if (input.pending) return reaskPending(input, started, modelName);
  if (input.cart.length > 0) {
    const spoken = buildAiReply({
      catalog: input.catalog,
      cart: input.cart,
      notOnMenu: [],
      question: null,
      pending: null,
      message: input.message,
      confirmedList: false,
    });
    return finish(started, {
      cart: input.cart.map((line) => ({ ...line })),
      pending: null,
      reply: spoken.reply,
      intent: "order",
      fallback: false,
      model: modelName,
      ms: 0,
      unmatched: [],
      freeText: [],
      confirmedList: false,
    });
  }
  return keepPrevious(input, started, modelName);
}

function reaskPending(input: CatalogTurnInput, started: number, modelName: string): CatalogTurnResult {
  const pending = input.pending;
  const question: AcceptedQuestion | null = pending
    ? {
        text: pending.question,
        candidateIds: pending.candidateIds,
        qty: pending.qty,
        unit: pending.unit,
        sourceText: pending.sourceText,
      }
    : null;
  const spoken = buildAiReply({
    catalog: input.catalog,
    cart: input.cart,
    notOnMenu: [],
    question,
    pending,
    pendingQueue: (pending?.queue ?? []).map((item) => ({
      text: item.question,
      candidateIds: item.candidateIds,
      qty: item.qty,
      unit: item.unit,
      sourceText: item.sourceText,
    })),
    message: input.message,
    confirmedList: false,
  });
  return finish(started, {
    cart: input.cart.map((line) => ({ ...line })),
    pending: spoken.pending,
    reply: spoken.reply,
    intent: "question",
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

  if (input.pending && closesOrder(input.message)) {
    return reaskPending(input, started, modelName);
  }

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

  let checked = acceptChecked(input, output);
  const swapError = pureSwapError(input.message, input.cart, checked.cart);
  const invalid = checked.errors.length > 0 && !useful(checked);
  if (invalid || swapError) {
    const errors = [...checked.errors];
    if (swapError) errors.push(swapError);
    let repaired: AiOutput | null = null;
    try {
      repaired = await model.interpret(requestOf(input, errors));
    } catch {
      repaired = null;
    }
    if (!repaired) return fromFallback(input, started, "fallback");
    const second = acceptChecked(input, repaired);
    const secondSwap = pureSwapError(input.message, input.cart, second.cart);
    const useSecond = swapError
      ? !secondSwap && useful(second)
      : useful(second) || second.errors.length < checked.errors.length;
    if (useSecond) {
      output = repaired;
      checked = second;
    }
  }
  if (!useful(checked)) return holdCart(input, started, modelName);

  const question = checked.question;
  const notOnMenu = checked.notOnMenu;
  const confirmedList = input.awaitingList === true
    && input.pending == null
    && checked.pending.length === 0
    && checked.cart.length > 0
    && output.confirmed === true
    && sameCart(checked.cart, input.cart)
    && messageConfirms(input.message);
  const spoken = buildAiReply({
    catalog: input.catalog,
    cart: checked.cart,
    notOnMenu,
    question,
    pending: input.pending,
    pendingQueue: checked.pending.slice(1),
    message: input.message,
    confirmedList,
  });
  const intent = confirmedList ? "confirm" : question ? "question" : notOnMenu.length && !checked.cart.length ? "other" : "order";
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
