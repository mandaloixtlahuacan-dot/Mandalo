import OpenAI from "openai";
import { getEnv } from "@/lib/env";

let client: OpenAI | null = null;

export function getOpenAI() {
  if (client) return client;
  const env = getEnv();
  client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

export function getOpenAIModel() {
  return getEnv().OPENAI_MODEL;
}
