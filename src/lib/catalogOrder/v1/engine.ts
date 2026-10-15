/** Motor anterior (validador que reescribía el carrito). Solo con CATALOG_ENGINE=v1. */
import { cartFromModel, fallbackInterpret, resolvePending } from "@/lib/catalogOrder/fallback";
import { createOpenAICatalogModel } from "@/lib/catalogOrder/v1/parser";
import { buildCatalogReply } from "@/lib/catalogOrder/reply";
import { tokens } from "@/lib/catalogOrder/text";
import type { CartLine, CatalogTurnInput, CatalogTurnResult, ModelOutput } from "@/lib/catalogOrder/types";
import { validateModelOutput } from "@/lib/catalogOrder/validate";

export function catalogEngineIsLegacy(): boolean {
  return String(process.env.CATALOG_ENGINE ?? "").trim().toLowerCase() === "legacy";
}

function logTurn(result: CatalogTurnResult): void {
  if (process.env.CATALOG_ORDER_QUIET === "1") return;
  console.log(
    `[catalogOrder] model=${result.model} ms=${result.ms} intent=${result.intent} cart=${result.cart.length} unmatched=${result.unmatched.length} fallback=${result.fallback}`,
  );
}

function cartAfterAnswer(prior: CartLine[], resolved: CartLine[], candidateIds: number[]): CartLine[] {
  const drop = new Set(candidateIds);
  const cart = prior.filter((line) => !drop.has(line.productId)).map((line) => ({ ...line }));
  for (const line of resolved) {
    const index = cart.findIndex((have) => have.productId === line.productId && have.unit === line.unit && (have.variant ?? null) === (line.variant ?? null));
    if (index >= 0) cart[index] = { ...line };
    else cart.push({ ...line });
  }
  return cart;
}

export async function runV1CatalogOrderTurn(input: CatalogTurnInput): Promise<CatalogTurnResult> {
  const started = Date.now();
  const model = createOpenAICatalogModel();
  let usedFallback = false;
  let modelName = model?.name ?? "fallback";
  let output: (ModelOutput & { pendingAsk?: import("@/lib/catalogOrder/types").PendingCatalogAsk | null }) | null = null;

  if (model && input.pending) {
    const resolved = resolvePending(input.pending, input.message, input.catalog);
    const candidateTokens = new Set(
      input.pending.candidateIds.flatMap((id) => tokens(input.catalog.byId.get(id)?.searchName ?? "")),
    );
    const namesSomethingElse = tokens(input.message).some((token) => {
      if (/^(chica|chicas|grande|grandes|marinada|marinado)$/.test(token)) return false;
      if (candidateTokens.has(token)) return false;
      return input.catalog.rows.some((row) => tokens(row.searchName).includes(token));
    });
    if (resolved?.length && !namesSomethingElse) {
      if (model.name === "replay") {
        try {
          await model.interpret({
            catalog: input.catalog,
            cart: input.cart,
            pending: input.pending,
            history: input.history,
            message: input.message,
          });
        } catch {
          // El replay solo avanza el turno grabado.
        }
      }
      const cart = cartAfterAnswer(input.cart, resolved, input.pending.candidateIds);
      const spoken = buildCatalogReply({
        catalog: input.catalog,
        cart,
        unmatched: [],
        pending: null,
        confirmedList: false,
      });
      const result: CatalogTurnResult = {
        cart,
        pending: spoken.pending,
        reply: spoken.reply,
        intent: "answer",
        fallback: false,
        model: modelName,
        ms: Date.now() - started,
        unmatched: [],
        freeText: [],
        confirmedList: false,
      };
      logTurn(result);
      return result;
    }
  }

  if (model) {
    try {
      output = await model.interpret({
        catalog: input.catalog,
        cart: input.cart,
        pending: input.pending,
        history: input.history,
        message: input.message,
      });
    } catch {
      output = null;
    }
  }

  if (!output) {
    usedFallback = true;
    modelName = "fallback";
    output = fallbackInterpret({
      message: input.message,
      cart: input.cart,
      pending: input.pending,
      catalog: input.catalog,
    });
  }

  const validated = usedFallback
    ? { cart: cartFromModel(output.cart), unmatched: output.unmatched, intent: output.intent }
    : validateModelOutput({
        output,
        prior: input.cart,
        message: input.message,
        catalog: input.catalog,
        pendingText: input.pending?.sourceText ?? "",
      });

  if (!usedFallback && validated.unmatched.some((item) => item.reason === "unclear" && item.candidate_ids.length === 0)) {
    usedFallback = true;
    modelName = `${modelName}+fallback`;
    const rescued = fallbackInterpret({
      message: input.message,
      cart: input.cart,
      pending: input.pending,
      catalog: input.catalog,
    });
    validated.cart = cartFromModel(rescued.cart);
    validated.unmatched = rescued.unmatched;
    validated.intent = rescued.intent;
    output = rescued;
  }

  const namesOnlyFree = input.catalog.mode === "names_only"
    ? validated.unmatched.filter((item) => item.reason === "not_on_menu").map((item) => item.source_text)
    : [];
  const unmatched = input.catalog.mode === "names_only"
    ? validated.unmatched.filter((item) => item.reason !== "not_on_menu")
    : validated.unmatched;

  const confirmedList = validated.intent === "confirm" && input.awaitingList === true && unmatched.length === 0 && validated.cart.length > 0;
  const spoken = buildCatalogReply({
    catalog: input.catalog,
    cart: validated.cart,
    unmatched,
    pending: output.pendingAsk ?? input.pending,
    confirmedList,
  });

  const result: CatalogTurnResult = {
    cart: validated.cart,
    pending: spoken.pending,
    reply: spoken.reply,
    intent: validated.intent,
    fallback: usedFallback,
    model: modelName,
    ms: Date.now() - started,
    unmatched,
    freeText: namesOnlyFree,
    confirmedList,
  };
  logTurn(result);
  return result;
}
