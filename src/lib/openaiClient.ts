import OpenAI from "openai";
import { getEnv } from "@/lib/env";

export const DEFAULT_MODEL = "gpt-4.1-mini";
export const FALLBACK_MODEL = "gpt-4o-mini";

type ChatCompletionMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ChatCompletionCreateParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model" | "messages"> & {
  model?: string;
  messages: ChatCompletionMessage[];
};

let client: OpenAI | null = null;

export function getOpenAI() {
  if (client) return client;
  const env = getEnv();
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

export function getOpenAIModel() {
  const configuredModel = String(getEnv().OPENAI_MODEL ?? "").trim();
  return configuredModel || DEFAULT_MODEL;
}

function shouldFallbackOpenAIError(error: unknown): boolean {
  const maybe = error as { status?: unknown; code?: unknown };
  return maybe.status === 403 || maybe.code === "model_not_found";
}

function getOpenAIErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

/**
 * `max_tokens` está deprecado y no es compatible con los modelos nuevos.
 * El límite sale como `max_completion_tokens` (gpt-4.1-mini y el fallback
 * gpt-4o-mini). El resto de la petición, incluido `response_format`, se reenvía igual.
 */
function buildChatRequest(
  params: ChatCompletionCreateParams,
  model: string,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    ...params,
    model,
    messages: params.messages,
    temperature: params.temperature ?? 0,
  };
  const completionLimit = request.max_completion_tokens ?? request.max_tokens;
  delete request.max_tokens;
  if (completionLimit !== undefined) request.max_completion_tokens = completionLimit;
  return request;
}

export async function getChatCompletion(params: ChatCompletionCreateParams): Promise<string> {
  const openai = getOpenAI();
  const requestedModel = String(params.model ?? getOpenAIModel() ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  try {
    const response = await openai.chat.completions.create(buildChatRequest(params, requestedModel));
    return response.choices?.[0]?.message?.content ?? "";
  } catch (error: unknown) {
    console.error("[OpenAI Error]", getOpenAIErrorMessage(error));

    if (shouldFallbackOpenAIError(error)) {
      console.log(`Intentando fallback con ${FALLBACK_MODEL}...`);
      const fallbackResponse = await openai.chat.completions.create(buildChatRequest(params, FALLBACK_MODEL));
      return fallbackResponse.choices?.[0]?.message?.content ?? "";
    }

    throw error;
  }
}
