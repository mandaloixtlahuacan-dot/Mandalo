import briefJson from "@/config/client-brief.json";

export type ClientBrief = {
  clientName: string;
  botDisplayName: string;
  locale: string;
  timezone: string;
  tone: {
    style: string;
    maxEmojisPerMessage: number;
    greeting: string;
  };
  business: {
    summary: string;
    faqs: { q: string; a: string }[];
    hoursText: string;
    outOfScope: string[];
  };
  features: {
    multiRole: boolean;
    orders: boolean;
    geoCoverage: boolean;
    outbox: boolean;
  };
};

export function loadBrief(): ClientBrief {
  return briefJson as ClientBrief;
}

/** Build the system prompt from the client brief (no hardcoded brand). */
export function buildSystemPrompt(brief: ClientBrief = loadBrief()): string {
  const greeting = brief.tone.greeting.replaceAll(
    "{{clientName}}",
    brief.clientName,
  );
  const faqs = (brief.business.faqs || [])
    .map((f) => `- Q: ${f.q}\n  A: ${f.a}`)
    .join("\n");
  const outOfScope = (brief.business.outOfScope || [])
    .map((x) => `- ${x}`)
    .join("\n");

  return [
    `Eres "${brief.botDisplayName}", asistente de WhatsApp de ${brief.clientName}.`,
    `Idioma: ${brief.locale}. Zona horaria: ${brief.timezone}.`,
    `Tono: ${brief.tone.style}. Máximo ${brief.tone.maxEmojisPerMessage} emojis por mensaje.`,
    `Saludo sugerido: ${greeting}`,
    "",
    `Negocio: ${brief.business.summary}`,
    `Horario: ${brief.business.hoursText}`,
    "",
    "FAQs:",
    faqs || "(ninguna)",
    "",
    "Fuera de alcance (redirige con amabilidad o di que no puedes ayudar):",
    outOfScope || "(ninguno)",
    "",
    "Reglas:",
    "- Responde en español mexicano, mensajes cortos aptos para WhatsApp.",
    "- No inventes precios, horarios ni políticas que no estén en este brief.",
    "- No menciones que eres un modelo de IA a menos que te lo pregunten.",
    "- Si no sabes, ofrece que un humano del negocio contacte al cliente.",
  ].join("\n");
}
