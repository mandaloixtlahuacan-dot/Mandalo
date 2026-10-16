/**
 * Carga antes del simulador. No toca el código del bot:
 * sustituye los módulos de Supabase, OpenAI y el cliente del agente,
 * y bloquea la red hacia OpenAI, Supabase y Whapi.
 */
import Module from "node:module";
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";

const supabaseStub = {
  getSupabaseAdmin() {
    const sim = globalThis.__MANDALO_SIM__;
    if (!sim?.supabase) throw new Error("Simulador sin Supabase en memoria");
    return sim.supabase;
  },
};

const openaiStub = {
  DEFAULT_MODEL: "sim-mock",
  FALLBACK_MODEL: "sim-mock",
  getOpenAI() {
    throw new Error("OPENAI bloqueado: el simulador no gasta API");
  },
  getOpenAIModel() {
    return "sim-mock";
  },
  async getChatCompletion() {
    const sim = globalThis.__MANDALO_SIM__;
    if (typeof sim?.chatCompletion === "function") return sim.chatCompletion();
    return JSON.stringify({
      customer_reply: "Cuéntame qué se te antoja y de qué tienda, y lo armamos.",
      order_state: { stage: "collecting", items: [] },
    });
  },
};

const agentModelStub = {
  createOpenAIOrderAgentModel(name) {
    const sim = globalThis.__MANDALO_SIM__;
    if (typeof sim?.createModel !== "function") {
      throw new Error("OPENAI bloqueado: falta el AgentModel del simulador");
    }
    return sim.createModel(String(name ?? "sim"));
  },
};

function cjsStub(request) {
  const spec = String(request).replaceAll("\\", "/");
  if (/(^|\/)supabaseAdmin(\.|$)/.test(spec) || spec.endsWith("/supabaseAdmin")) return supabaseStub;
  if (/(^|\/)openaiClient(\.|$)/.test(spec) || spec.endsWith("/openaiClient")) return openaiStub;
  if (spec.endsWith("/orderAgent/model") || spec.includes("/orderAgent/model.")) return agentModelStub;
  return null;
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const stub = cjsStub(request);
  if (stub) return stub;
  return originalLoad.call(this, request, parent, isMain);
};

const WHAPI = /whapi/i;

function recordOutbound(entry) {
  const sim = globalThis.__MANDALO_SIM__;
  if (!sim) return;
  if (!Array.isArray(sim.outbound)) sim.outbound = [];
  sim.outbound.push({ at: new Date().toISOString(), ...entry });
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (WHAPI.test(url)) {
    let to = "";
    let body = "";
    let kind = "text";
    const raw = init?.body;
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        to = String(parsed.to ?? "");
        body = String(parsed.body ?? "");
      } catch {
        body = raw;
      }
    } else if (typeof FormData !== "undefined" && raw instanceof FormData) {
      kind = "image";
      to = String(raw.get("to") ?? "");
      body = String(raw.get("caption") ?? "");
    }
    recordOutbound({ channel: "whapi", kind, to, body, url });
    return new Response(JSON.stringify({ sent: true, simulated: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (/^https?:/i.test(url)) {
    throw new Error(`SIM_RED_BLOQUEADA ${url}`);
  }
  return originalFetch(input, init);
};

const { port1, port2 } = new MessageChannel();
const ready = new Promise((resolve) => {
  port1.on("message", () => {
    port1.close();
    resolve(undefined);
  });
});
register(new URL("./hooks.mjs", import.meta.url), {
  parentURL: import.meta.url,
  data: { port: port2 },
  transferList: [port2],
});
await ready;
