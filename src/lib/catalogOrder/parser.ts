import OpenAI from "openai";
import { fold } from "@/lib/catalogOrder/text";
import type { AiOutput, CatalogModel, CatalogRow, InterpretRequest, SellUnit } from "@/lib/catalogOrder/types";

export const DEFAULT_ORDER_MODEL = "gpt-4.1-mini";

const ORDER_TIMEOUT_MS = 6000;

const RULES = [
  "Devuelve el carrito COMPLETO de esta tienda. No un delta.",
  "No inventes tamaño, sabor ni tipo. Si hay más de una opción y no la dijo, haz una sola pregunta y no agregues esa línea. Si solo hay una, agrégala.",
  "cambia X por Y reemplaza esa línea. quita la borra. otra u otro suma 1. cambia N por un sabor mueve solo esa cantidad.",
  "medio=0.5, cuarto=0.25, kilo y medio=1.5, N kilos y tres cuartos=N.75. Quince, veinte, doscientos son números.",
  "En carne, $100 o cien pesos: unit pesos, qty 100. Solo en filas kg.",
  "«la que no es marinada», «sin marinar» o «normal» es la fila sin marinar.",
  "Lo que no está en el menú va en not_on_menu y no se agrega. Si hay una familia cercana, la pregunta la ofrece.",
  "sí, listo, así está bien o correcto: confirmed true y el mismo carrito. No es un producto.",
].join("\n");

function examplesFor(profile: InterpretRequest["catalog"]["profile"]): string {
  if (profile === "carniceria") {
    return [
      "«bistec» → question «¿El bistec de res o de puerco?», sin esa línea.",
      "«un kilo de diezmillo» → esa fila, qty 1, unit kg.",
      "«$150 de pastor» → unit pesos, qty 150.",
      "«seis kilos y tres cuartos» → qty 6.75, unit kg.",
      "«la que no es marinada» → la fila sin marinar.",
      "«una pizza» → not_on_menu [\"pizza\"].",
      "«sí está bien» → confirmed true, carrito igual.",
    ].join("\n");
  }
  return [
    "«2 hamburguesas» → question «¿Cuál hamburguesa?», sin esa línea.",
    "«una de res chica» → esa fila, qty 1, question null.",
    "Carrito con Pepsi x3 y «cambia una por seven» → Pepsi x2 y Seven x1.",
    "«otra» con una Pepsi → Pepsi x2. «otro de pollo» es el de pollo, no suma al anterior.",
    "«una pizza» → not_on_menu [\"pizza\"].",
    "«sí está bien» → confirmed true, carrito igual.",
  ].join("\n");
}

/** gpt-5 rechaza temperature. El esfuerzo se elige con OPENAI_REASONING_EFFORT (none o low). */
function omitsTemperature(modelName: string): boolean {
  return /^gpt-5/i.test(modelName.trim());
}

function reasoningEffort(): "none" | "low" {
  return String(process.env.OPENAI_REASONING_EFFORT ?? "").trim().toLowerCase() === "low" ? "low" : "none";
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

export function orderModel(): string {
  const configured = String(process.env.OPENAI_ORDER_MODEL ?? "").trim();
  return configured || DEFAULT_ORDER_MODEL;
}

function aliasSuffix(row: CatalogRow): string {
  const name = fold(`${row.name} ${row.searchName}`);
  const extra = row.alias
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !name.includes(fold(item)));
  const unique = extra.filter((item, index) => extra.findIndex((other) => fold(other) === fold(item)) === index);
  return unique.length ? ` (${unique.join(", ")})` : "";
}

function menuLines(request: InterpretRequest): string {
  return request.catalog.rows
    .map((row) => {
      const flavors = row.variants.length ? ` [${row.variants.join("/")}]` : "";
      return `${row.id} ${row.name} $${row.precio} ${row.unit}${flavors}${aliasSuffix(row)}`;
    })
    .join("\n");
}

function cartJson(request: InterpretRequest): string {
  const lines = request.cart.map((line) => ({
    product_id: line.productId,
    qty: line.qty,
    unit: line.unit,
    variant: line.variant,
  }));
  return JSON.stringify(lines);
}

function stepLine(request: InterpretRequest): string {
  if (request.repairErrors?.length) return `Corrige el JSON. ${request.repairErrors.join(" ")}`;
  if (request.pending) return `Pregunta pendiente: ${request.pending.question}`;
  if (request.awaitingList) return "Ya vio la lista. Un sí la confirma. Un cambio la edita.";
  return "Armando el pedido.";
}

/** Lo único que ve el modelo: reglas cortas, el paso, el menú de esta tienda y el carrito. */
export function buildOrderPrompt(request: InterpretRequest): string {
  return [
    RULES,
    examplesFor(request.catalog.profile),
    stepLine(request),
    "Menú (id nombre precio unidad):",
    menuLines(request),
    "Carrito:",
    cartJson(request),
  ].join("\n");
}

export function orderJsonSchema(ids: number[]): Record<string, unknown> {
  const idEnum = ids.length ? ids : [0];
  return {
    type: "object",
    additionalProperties: false,
    required: ["cart", "question", "not_on_menu", "confirmed"],
    properties: {
      cart: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["product_id", "qty", "unit", "variant"],
          properties: {
            product_id: { type: "integer", enum: idEnum },
            qty: { type: "number" },
            unit: { type: "string", enum: ["pz", "kg", "pesos"] },
            variant: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
      question: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["text", "candidate_ids"],
            properties: {
              text: { type: "string" },
              candidate_ids: { type: "array", items: { type: "integer" } },
            },
          },
        ],
      },
      not_on_menu: { type: "array", items: { type: "string" } },
      confirmed: { type: "boolean" },
    },
  };
}

function asUnit(value: unknown): SellUnit | null {
  return value === "pz" || value === "kg" || value === "pesos" ? value : null;
}

function unreadable(): AiOutput {
  return {
    cart: [{ product_id: -1, qty: 1, unit: "pz", variant: null }],
    question: null,
    not_on_menu: [],
    confirmed: false,
  };
}

export function parseModelJson(raw: unknown): AiOutput | null {
  const body = typeof raw === "string" ? safeJson(raw) : raw;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.cart) || !Array.isArray(record.not_on_menu) || typeof record.confirmed !== "boolean") return null;
  const questionRecord = record.question;
  let question: AiOutput["question"] = null;
  if (questionRecord && typeof questionRecord === "object") {
    const row = questionRecord as Record<string, unknown>;
    const ids = Array.isArray(row.candidate_ids) ? row.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)) : [];
    question = { text: String(row.text ?? ""), candidate_ids: ids };
  } else if (questionRecord != null) return null;
  return {
    confirmed: record.confirmed,
    not_on_menu: record.not_on_menu.map((item) => String(item)).filter((item) => item.trim()),
    question,
    cart: record.cart.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        product_id: Number(row.product_id),
        qty: Number(row.qty),
        unit: asUnit(row.unit) ?? String(row.unit ?? ""),
        variant: row.variant == null || String(row.variant).trim() === "" ? null : String(row.variant),
      };
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
            ...(omitsTemperature(modelName) ? { reasoning_effort: reasoningEffort() } : { temperature: 0 }),
            messages: [
              { role: "system", content: buildOrderPrompt(request) },
              { role: "user", content: request.message },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "catalog_order", strict: true, schema: orderJsonSchema(ids) },
            },
          },
          { signal: AbortSignal.timeout(ORDER_TIMEOUT_MS) },
        );
        return parseModelJson(response.choices?.[0]?.message?.content ?? "") ?? unreadable();
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
