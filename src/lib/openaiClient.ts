import OpenAI from "openai";
import { getEnv } from "@/lib/env";

export const DEFAULT_MODEL = "gpt-4-turbo";
export const FALLBACK_MODEL = "gpt-3.5-turbo";

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

export async function getChatCompletion(params: ChatCompletionCreateParams): Promise<string> {
  const openai = getOpenAI();
  const messages = params.messages;
  const requestedModel = String(params.model ?? getOpenAIModel() ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  try {
    const response = await openai.chat.completions.create({
      ...params,
      model: requestedModel,
      messages,
      temperature: params.temperature ?? 0,
    });
    return response.choices?.[0]?.message?.content ?? "";
  } catch (error: unknown) {
    console.error("[OpenAI Error]", getOpenAIErrorMessage(error));

    if (shouldFallbackOpenAIError(error)) {
      console.log(`Intentando fallback con ${FALLBACK_MODEL}...`);
      const fallbackResponse = await openai.chat.completions.create({
        ...params,
        model: FALLBACK_MODEL,
        messages,
        temperature: params.temperature ?? 0,
      });
      return fallbackResponse.choices?.[0]?.message?.content ?? "";
    }

    throw error;
  }
}
