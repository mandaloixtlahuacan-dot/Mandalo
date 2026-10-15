import { orderAgentToolSchema } from "@/lib/orderAgent/tools";
import type { AgentModel, AgentModelRequest, ToolCall, ToolName } from "@/lib/orderAgent/types";

const NAMES = new Set<ToolName>(["search_products", "set_cart_line", "remove_line", "ask_customer", "finish_cart"]);

function asToolName(value: string): ToolName | null {
  return NAMES.has(value as ToolName) ? (value as ToolName) : null;
}

function argumentsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

/** Cliente real. Los tests no lo usan: inyectan un modelo escrito a mano. */
export function createOpenAIOrderAgentModel(name: string): AgentModel {
  return {
    name,
    async complete(request) {
      const { getOpenAI } = await import("@/lib/openaiClient");
      const client = getOpenAI();
      const sampling = /^gpt-5/i.test(name) ? {} : { temperature: 0 as const };
      const response = await client.chat.completions.create({
        model: name,
        ...sampling,
        messages: messagesOf(request) as never,
        tools: orderAgentToolSchema() as never,
        tool_choice: "auto",
      });
      const message = response.choices?.[0]?.message;
      const toolCalls: ToolCall[] = [];
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        const toolName = asToolName(call.function.name);
        if (!toolName) continue;
        toolCalls.push({
          id: call.id,
          name: toolName,
          arguments: argumentsOf(call.function.arguments),
        });
      }
      return { toolCalls, text: message?.content ?? null };
    },
  };
}

function messagesOf(request: AgentModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: request.system }];
  for (const turn of request.history) {
    messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.text });
  }
  messages.push({
    role: "user",
    content: `Cliente: ${request.message}\n\nCarrito:\n${JSON.stringify(request.cart)}\n\nTienda: ${request.store.name} (id ${request.store.id}).`,
  });
  if (request.toolTrace.length) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: request.toolTrace.map((entry) => ({
        id: entry.call.id,
        type: "function",
        function: { name: entry.call.name, arguments: JSON.stringify(entry.call.arguments ?? {}) },
      })),
    });
    for (const entry of request.toolTrace) {
      messages.push({ role: "tool", tool_call_id: entry.call.id, content: JSON.stringify(entry.result) });
    }
  }
  if (request.repairErrors.length) {
    messages.push({
      role: "user",
      content: `Errores de validación. Corrígelos con otra herramienta. No se los enseñes al cliente: ${request.repairErrors.join(" | ")}`,
    });
  }
  return messages;
}
