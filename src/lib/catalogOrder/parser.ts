import OpenAI from "openai";
import type { CatalogModel, InterpretRequest, ModelOutput, SellUnit } from "@/lib/catalogOrder/types";

export const DEFAULT_ORDER_MODEL = "gpt-4.1";

function orderModel(): string {
  const configured = String(process.env.OPENAI_ORDER_MODEL ?? "").trim();
  return configured || DEFAULT_ORDER_MODEL;
}

function catalogLines(request: InterpretRequest): string {
  return request.catalog.rows
    .map((row) => {
      const variants = row.variants.length ? ` | ${row.variants.join("/")}` : "";
      return `${row.id} | ${row.name} | ${row.precio} | ${row.unit}${variants}`;
    })
    .join("\n");
}

function schemaFor(ids: number[]): Record<string, unknown> {
  const idEnum = ids.length ? ids : [0];
  const nullableId = { anyOf: [{ type: "integer", enum: idEnum }, { type: "null" }] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["intent", "cart", "changes", "unmatched", "confidence"],
    properties: {
      intent: { type: "string", enum: ["order", "edit", "confirm", "answer", "question", "other"] },
      cart: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["product_id", "qty", "unit", "variant", "notes"],
          properties: {
            product_id: { type: "integer", enum: idEnum },
            qty: { type: "number" },
            unit: { type: "string", enum: ["pz", "kg", "pesos"] },
            variant: { anyOf: [{ type: "string" }, { type: "null" }] },
            notes: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
      changes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "product_id", "from_product_id", "source_text"],
          properties: {
            op: { type: "string", enum: ["add", "set_qty", "remove", "replace", "set_variant"] },
            product_id: nullableId,
            from_product_id: nullableId,
            source_text: { type: "string" },
          },
        },
      },
      unmatched: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source_text", "reason", "candidate_ids"],
          properties: {
            source_text: { type: "string" },
            reason: { type: "string", enum: ["ambiguous", "not_on_menu", "unclear"] },
            candidate_ids: { type: "array", items: { type: "integer", enum: idEnum } },
          },
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
  };
}

function promptFor(request: InterpretRequest): string {
  const place = request.catalog.profile === "carniceria" ? "carnicería La Central (kilos; carbón y salsas por pieza)" : "restaurante George (todo por pieza)";
  const cart = request.cart
    .map((line) => `${line.productId} x${line.qty} ${line.unit}${line.variant ? ` ${line.variant}` : ""}`)
    .join(", ") || "(vacío)";
  const pending = request.pending
    ? `Pregunta pendiente: "${request.pending.question}" candidatos=${request.pending.candidateIds.join(",")} qty=${request.pending.qty} ${request.pending.unit}`
    : "Sin pregunta pendiente.";
  const history = request.history.slice(-6).map((turn) => `${turn.role}: ${turn.text}`).join("\n") || "(sin historial)";
  return [
    `Eres el lector de pedidos de Mándalo para ${place}.`,
    "Devuelve solo el JSON del esquema. El carrito final usa únicamente ids del menú.",
    "Entiende faltas, jerga y voz a texto. Cantidades en palabras y fracciones (1/4, un cuarto, medio, kilo y medio, 3/4, 250 g).",
    "En carne, '$100 de pastor' o 'cien pesos de chorizo' van con unit pesos.",
    "otra/otro igual/una más suma 1 a la línea de la que se habla. Si 'otra' trae otro producto, es ese producto, no un extra de la anterior.",
    "El tamaño aplica al producto que acompaña. No inventes filas. Si no está en el menú, unmatched reason not_on_menu.",
    "Si dos o más filas caben, unmatched reason ambiguous con sus ids. No preguntes tamaño ni tipo si solo hay una fila.",
    "Un sí, 'así está bien' o 'correcto' es intent confirm y no agrega productos.",
    "Cada cambio del carrito lleva changes[].source_text copiado del mensaje del cliente.",
    "",
    "Menú (id | nombre | precio | unidad | variantes):",
    catalogLines(request),
    "",
    `Carrito actual: ${cart}`,
    pending,
    "Historial:",
    history,
    "",
    `Mensaje nuevo: ${request.message}`,
  ].join("\n");
}

function asUnit(value: unknown): SellUnit {
  return value === "kg" || value === "pesos" ? value : "pz";
}

export function parseModelJson(raw: unknown): ModelOutput | null {
  const body = typeof raw === "string" ? safeJson(raw) : raw;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const intent = record.intent;
  if (intent !== "order" && intent !== "edit" && intent !== "confirm" && intent !== "answer" && intent !== "question" && intent !== "other") {
    return null;
  }
  const cart = Array.isArray(record.cart) ? record.cart : [];
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const unmatched = Array.isArray(record.unmatched) ? record.unmatched : [];
  const confidence = record.confidence === "low" || record.confidence === "medium" ? record.confidence : "high";
  return {
    intent,
    confidence,
    cart: cart.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        product_id: Number(row.product_id),
        qty: Number(row.qty),
        unit: asUnit(row.unit),
        variant: row.variant == null ? null : String(row.variant),
        notes: row.notes == null ? null : String(row.notes),
      };
    }),
    changes: changes.map((item) => {
      const row = item as Record<string, unknown>;
      const op = row.op;
      return {
        op: op === "set_qty" || op === "remove" || op === "replace" || op === "set_variant" ? op : "add",
        product_id: row.product_id == null ? null : Number(row.product_id),
        from_product_id: row.from_product_id == null ? null : Number(row.from_product_id),
        source_text: String(row.source_text ?? ""),
      };
    }),
    unmatched: unmatched.map((item) => {
      const row = item as Record<string, unknown>;
      const reason = row.reason === "not_on_menu" || row.reason === "unclear" ? row.reason : "ambiguous";
      const ids = Array.isArray(row.candidate_ids) ? row.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)) : [];
      return { source_text: String(row.source_text ?? ""), reason, candidate_ids: ids };
    }),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createOpenAICatalogModel(modelName = orderModel()): CatalogModel {
  return {
    name: modelName,
    async interpret(request) {
      const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
      if (!apiKey) return null;
      const client = new OpenAI({ apiKey, timeout: 4000 });
      const ids = request.catalog.rows.map((row) => row.id);
      try {
        const response = await client.chat.completions.create(
          {
            model: modelName,
            temperature: 0,
            messages: [
              { role: "system", content: promptFor(request) },
              { role: "user", content: request.message },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "catalog_order", strict: true, schema: schemaFor(ids) },
            },
          },
          { signal: AbortSignal.timeout(4000) },
        );
        return parseModelJson(response.choices?.[0]?.message?.content ?? "");
      } catch (error) {
        console.error("[catalogOrder] modelo falló", error instanceof Error ? error.message : error);
        return null;
      }
    },
  };
}
