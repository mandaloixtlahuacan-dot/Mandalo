/** Apagado por defecto. Producción sigue el flujo de siempre hasta que el dueño lo prenda. */
export function orderAgentEnabled(): boolean {
  const value = String(process.env.ORDER_AGENT ?? "off").trim().toLowerCase();
  return value === "on" || value === "true" || value === "1";
}

export const DEFAULT_ORDER_AGENT_MODEL = "gpt-4o-mini";
export const DEFAULT_ORDER_AGENT_ESCALATION_MODEL = "gpt-4.1-mini";

export function orderAgentModel(): string {
  const configured = String(process.env.OPENAI_ORDER_MODEL ?? "").trim();
  return configured || DEFAULT_ORDER_AGENT_MODEL;
}

/** Si la variable viene vacía, el agente igual tiene salto (gpt-4.1-mini). */
export function orderAgentEscalationModel(): string {
  const raw = process.env.OPENAI_ORDER_ESCALATION_MODEL;
  const configured = raw == null ? "" : raw.trim();
  return configured || DEFAULT_ORDER_AGENT_ESCALATION_MODEL;
}

export const ORDER_AGENT_MAX_STEPS = 6;
export const ORDER_AGENT_ESCALATE_AFTER = 2;
