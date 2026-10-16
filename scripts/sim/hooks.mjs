/**
 * Sustituye los módulos de red del bot si entran por el cargador ESM.
 * tsx suele requerirlos como CJS; ese camino lo cubre preload.mjs.
 */
function matches(url, suffix) {
  return url.includes(suffix);
}

export async function initialize(data) {
  data?.port?.postMessage("ready");
}

export async function load(url, context, nextLoad) {
  if (matches(url, "/src/lib/supabaseAdmin.ts")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export function getSupabaseAdmin() {
          const sim = globalThis.__MANDALO_SIM__;
          if (!sim?.supabase) throw new Error("Simulador sin Supabase en memoria");
          return sim.supabase;
        }
      `,
    };
  }
  if (matches(url, "/src/lib/openaiClient.ts")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export const DEFAULT_MODEL = "sim-mock";
        export const FALLBACK_MODEL = "sim-mock";
        export function getOpenAI() {
          throw new Error("OPENAI bloqueado: el simulador no gasta API");
        }
        export function getOpenAIModel() {
          return "sim-mock";
        }
        export async function getChatCompletion() {
          const sim = globalThis.__MANDALO_SIM__;
          if (typeof sim?.chatCompletion === "function") return sim.chatCompletion();
          return JSON.stringify({
            customer_reply: "Cuéntame qué se te antoja y de qué tienda, y lo armamos.",
            order_state: { stage: "collecting", items: [] }
          });
        }
      `,
    };
  }
  if (matches(url, "/src/lib/orderAgent/model.ts")) {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export function createOpenAIOrderAgentModel(name) {
          const sim = globalThis.__MANDALO_SIM__;
          if (typeof sim?.createModel !== "function") {
            throw new Error("OPENAI bloqueado: falta el AgentModel del simulador");
          }
          return sim.createModel(String(name ?? "sim"));
        }
      `,
    };
  }
  return nextLoad(url, context);
}
