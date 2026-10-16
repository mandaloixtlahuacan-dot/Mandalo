import type { ToolName } from "@/lib/orderAgent/types";

export const ORDER_AGENT_TOOLS: Array<{ name: ToolName; description: string }> = [
  {
    name: "search_products",
    description: "Busca productos de ESTA tienda. En abarrotes usa la lista. En menú fijo, el catálogo.",
  },
  {
    name: "set_cart_line",
    description: "Anota o corrige una línea. product_id si está en la lista; free_text solo en abarrotes sin lista, o después de preguntar si no está. La cantidad no va en el nombre. unit l es litros.",
  },
  {
    name: "remove_line",
    description: "Quita una línea que el cliente pidió quitar.",
  },
  {
    name: "ask_customer",
    description: "Una sola duda: un producto y hasta 5 opciones reales. Las otras dudas esperan al siguiente mensaje.",
  },
  {
    name: "finish_cart",
    description: "El carrito ya se puede mostrar. El código arma el mensaje y el total.",
  },
];

export function orderAgentToolSchema(): unknown[] {
  return [
    {
      type: "function",
      function: {
        name: "search_products",
        description: ORDER_AGENT_TOOLS[0].description,
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_cart_line",
        description: ORDER_AGENT_TOOLS[1].description,
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "number" },
            line_id: { type: "string" },
            free_text: { type: "string" },
            qty: { type: "number" },
            unit: { type: "string", enum: ["pz", "kg", "pesos", "g", "l", "litros"] },
            variant: { type: "string" },
            brand: { type: "string" },
            presentation: { type: "string" },
            note: { type: "string" },
            store_id: { type: "number" },
          },
          required: ["qty", "unit"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_line",
        description: ORDER_AGENT_TOOLS[2].description,
        parameters: {
          type: "object",
          properties: {
            line_id: { type: "string" },
            product_id: { type: "number" },
            free_text: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_customer",
        description: ORDER_AGENT_TOOLS[3].description,
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            candidate_ids: { type: "array", items: { type: "number" } },
            axis: { type: "string", enum: ["number", "size", "flavor", "marinade", "brand"] },
            qty: { type: "number" },
            unit: { type: "string", enum: ["pz", "kg", "pesos", "g", "l", "litros"] },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish_cart",
        description: ORDER_AGENT_TOOLS[4].description,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
}
