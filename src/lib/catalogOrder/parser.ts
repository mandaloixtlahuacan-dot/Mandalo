import OpenAI from "openai";
import type { CatalogModel, InterpretRequest, ModelOutput, SellUnit } from "@/lib/catalogOrder/types";

export const DEFAULT_ORDER_MODEL = "gpt-4.1-mini";

const ORDER_TIMEOUT_MS = 6000;

/** gpt-5 rechaza temperature; se pide sin razonamiento. */
function omitsTemperature(modelName: string): boolean {
  return /^gpt-5/i.test(modelName.trim());
}

const announcedAccess = new Set<string>();

function accessError(error: unknown): { status: number; code: string } | null {
  if (!error || typeof error !== "object") return null;
  const status = "status" in error ? Number((error as { status?: number }).status) : NaN;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : "";
  const blob = `${code} ${message}`.toLowerCase();
  const modelMissing = blob.includes("model_not_found") || blob.includes("does not exist") || blob.includes("do not have access");
  if (status === 401 || status === 403 || modelMissing || (status === 404 && (modelMissing || blob.includes("model") || blob.includes("not found")))) {
    return { status: Number.isFinite(status) ? status : 0, code };
  }
  return null;
}

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
    "El tamaño aplica al producto que acompaña. No inventes filas.",
    "Nunca elijas tamaño, tipo ni sabor por default. Si el cliente no lo dijo, unmatched reason ambiguous con las filas que sí caben.",
    "Una línea de carrito por sabor. Dos sabores en el mismo mensaje son dos líneas, cada una con su variant.",
    "No sustituyas. Si lo que nombra no es un producto del menú, unmatched reason not_on_menu y candidate_ids de lo más parecido. No lo cambies por otro parecido.",
    "Si dice el nombre exacto de un producto, no preguntes.",
    "Si dos o más filas caben y ninguna quedó nombrada completa, unmatched reason ambiguous con sus ids. No preguntes cuando solo hay una fila.",
    "Un sí, 'así está bien' o 'correcto' es intent confirm y no agrega productos.",
    "Un elemento de changes por producto. source_text va copiado del mensaje.",
    "cámbialo o cambia X por Y es op replace: from_product_id es la línea que sale y product_id la que entra. No dejes las dos.",
    "otra, otro, agrega otro y otra igual suman 1 a esa línea (op add o set_qty con la cantidad nueva).",
    "En una quesadilla, 'con ingrediente extra' es la fila Ingrediente Extra en Quesadilla, además de la quesadilla.",
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
      const client = new OpenAI({ apiKey, timeout: ORDER_TIMEOUT_MS });
      const ids = request.catalog.rows.map((row) => row.id);
      try {
        const response = await client.chat.completions.create(
          {
            model: modelName,
            ...(omitsTemperature(modelName) ? { reasoning_effort: "none" as const } : { temperature: 0 }),
            messages: [
              { role: "system", content: promptFor(request) },
              { role: "user", content: request.message },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "catalog_order", strict: true, schema: schemaFor(ids) },
            },
          },
          { signal: AbortSignal.timeout(ORDER_TIMEOUT_MS) },
        );
        return parseModelJson(response.choices?.[0]?.message?.content ?? "");
      } catch (error) {
        const denied = accessError(error);
        if (denied) {
          const key = `${modelName}:${denied.status}:${denied.code}`;
          if (!announcedAccess.has(key)) {
            announcedAccess.add(key);
            const status = denied.status ? `HTTP ${denied.status}` : "sin HTTP";
            const code = denied.code ? ` ${denied.code}` : "";
            console.error(
              `[catalogOrder] OpenAI rechazó el modelo ${modelName} (${status}${code}). La llave no tiene acceso o el modelo no existe. Este turno usa el lector de respaldo. El mismo rechazo no se vuelve a anunciar.`,
            );
          }
          return null;
        }
        console.error("[catalogOrder] modelo falló", error instanceof Error ? error.message : error);
        return null;
      }
    },
  };
}
