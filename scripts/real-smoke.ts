/**
 * Una conversación por tienda con OpenAI real.
 * Usa OPENAI_API_KEY del entorno. No se corre en `npm run check`.
 * No manda WhatsApp ni toca Supabase.
 *
 *   OPENAI_API_KEY=... npx tsx scripts/real-smoke.ts
 */
import { readFileSync } from "node:fs";

import OpenAI from "openai";

import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import type { RawCatalogRow } from "../src/lib/catalogOrder/types";
import {
  agentProductsFromCatalog,
  runOrderAgentTurn,
  type AgentLine,
  type AgentModel,
  type AgentPending,
  type AgentProduct,
  type AgentStore,
  type ToolCall,
} from "../src/lib/orderAgent";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import type { ToolName } from "../src/lib/orderAgent/types";
import { orderAgentModel } from "../src/lib/orderAgent/env";
import { orderAgentToolSchema } from "../src/lib/orderAgent/tools";

type Fixture = {
  id: number;
  nombre_producto: string;
  precio: number | null;
  disponible?: boolean;
  categoria?: string | null;
  alias?: string[] | null;
  marca?: string | null;
  presentacion?: string | null;
};

function load(path: string): Fixture[] {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture[];
}

function asRaw(rows: Fixture[]): RawCatalogRow[] {
  return rows.map((row) => ({
    id: row.id,
    nombreProducto: row.nombre_producto,
    precio: row.precio ?? 0,
    categoria: row.categoria ?? null,
    alias: row.alias ?? [],
    disponible: row.disponible !== false,
  }));
}

function asLista(rows: Fixture[]): AgentProduct[] {
  return rows
    .filter((row) => row.disponible !== false)
    .map((row) => ({
      id: row.id,
      name: row.nombre_producto,
      price: row.precio,
      available: true,
      unit: "pz" as const,
      variants: [],
      brand: row.marca ?? null,
      presentation: row.presentacion ?? null,
      alias: row.alias ?? [],
      category: row.categoria ?? null,
    }));
}

const NAMES = new Set<ToolName>(["search_products", "set_cart_line", "remove_line", "ask_customer", "finish_cart"]);

function liveModel(client: OpenAI, name: string): AgentModel {
  return {
    name,
    async complete(request) {
      const messages: Array<Record<string, unknown>> = [{ role: "system", content: request.system }];
      for (const turn of request.history) {
        messages.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.text });
      }
      const pending = request.pending?.question
        ? `\n\nPregunta pendiente:\n${request.pending.question}\nOpciones, ids: ${(request.pending.candidateIds ?? []).join(", ")}`
        : "";
      messages.push({
        role: "user",
        content: `Cliente: ${request.message}\n\nCarrito con ids:\n${JSON.stringify(request.cart)}\n\nTienda: ${request.store.name} (id ${request.store.id}).${pending}`,
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
        messages.push({ role: "user", content: `Errores de validación. Corrígelos con otra herramienta: ${request.repairErrors.join(" | ")}` });
      }
      const sampling = /^gpt-5/i.test(name) ? {} : { temperature: 0 as const };
      const response = await client.chat.completions.create({
        model: name,
        ...sampling,
        messages: messages as never,
        tools: orderAgentToolSchema() as never,
        tool_choice: "auto",
      });
      const message = response.choices?.[0]?.message;
      const toolCalls: ToolCall[] = [];
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        if (!NAMES.has(call.function.name as ToolName)) continue;
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          args = {};
        }
        toolCalls.push({ id: call.id, name: call.function.name as ToolName, arguments: args });
      }
      return { toolCalls, text: message?.content ?? null };
    },
  };
}

const talks: Array<{ store: AgentStore; products: AgentProduct[]; messages: string[] }> = [
  {
    store: { id: 7, name: "Mini Super Peke's", category: "abarrotes", catalogMode: "list", hasProductList: true },
    products: asLista(load("scripts/fixtures/pekes-real.json")),
    messages: ["Quiero un kilo de tortillas, unos takis y unas mentas halls"],
  },
  {
    store: { id: 5, name: "Hamburguesas Hotdogs George", category: "restaurante", catalogMode: "fixed" },
    products: agentProductsFromCatalog(buildCatalog(asRaw(load("scripts/fixtures/george-catalogo.json")), "restaurante")),
    messages: ["Quiero una hamburguesa de res grande, 3 dogos clásicos y 2 Pepsi"],
  },
  {
    store: { id: 6, name: "Carnicería La Central", category: "carniceria", catalogMode: "fixed" },
    products: agentProductsFromCatalog(buildCatalog(asRaw(load("scripts/fixtures/lacentral-catalogo.json")), "carniceria")),
    messages: ["Medio kilo de arrachera y un kilo de diezmillo"],
  },
];

async function talk(client: OpenAI, modelName: string, item: (typeof talks)[number]): Promise<void> {
  let cart: AgentLine[] = [];
  let pending: AgentPending | null = null;
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  const model = liveModel(client, modelName);
  console.log(`\n======== ${item.store.name} ========`);
  for (const message of item.messages) {
    const turn = await runOrderAgentTurn({
      message,
      cart,
      pending,
      history,
      store: item.store,
      products: item.store.catalogMode === "fixed" ? item.products : [],
      search: async (query) => searchAgentProducts(item.products, query, 24),
      model,
      escalationModel: null,
      awaitingList: history.some((entry) => entry.role === "assistant" && entry.text.includes("¿Están bien estos productos?")),
      logEvent: () => {},
    });
    cart = turn.cart;
    pending = turn.pending;
    history.push({ role: "user", text: message }, { role: "assistant", text: turn.reply });
    console.log(`\nCLIENTE: ${message}\nBOT: ${turn.reply}`);
    if (turn.reply.includes("¿Están bien estos productos?") || turn.confirmedList) break;
    if (pending && item.messages.length === 1) {
      const follow = "1";
      const next = await runOrderAgentTurn({
        message: follow,
        cart,
        pending,
        history,
        store: item.store,
        products: item.store.catalogMode === "fixed" ? item.products : [],
        search: async (query) => searchAgentProducts(item.products, query, 24),
        model,
        escalationModel: null,
        logEvent: () => {},
      });
      console.log(`\nCLIENTE: ${follow}\nBOT: ${next.reply}`);
      break;
    }
  }
}

async function main(): Promise<void> {
  const key = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) {
    console.error("Falta OPENAI_API_KEY en el entorno. No se inventa una llave.");
    process.exit(1);
  }
  const modelName = orderAgentModel();
  const client = new OpenAI({ apiKey: key });
  for (const item of talks) {
    await talk(client, modelName, item);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
