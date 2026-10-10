import OpenAI from "openai";
import { fold } from "@/lib/catalogOrder/text";
import type { AiOutput, AiPendingLine, CatalogModel, CatalogRow, InterpretRequest, SellUnit } from "@/lib/catalogOrder/types";

export const DEFAULT_ORDER_MODEL = "gpt-5.5";

/** 8 s: gpt-5.5 con esfuerzo low no cabe en 6. */
export const ORDER_TIMEOUT_MS = 8000;

const RULES = [
  "Devuelve el carrito COMPLETO de esta tienda, no un delta. Si el cliente no quitó una línea, sigue en el carrito.",
  "No inventes tamaño, sabor ni tipo. Si falta uno y hay varias opciones, va en pending y esa línea no va en el carrito. Si solo hay una opción, agrégala. No preguntes con una sola opción.",
  "Cada elemento de pending lleva text, candidate_ids, qty, unit y source_text (las palabras del cliente). Si pending no está vacío, confirmed es false.",
  "«no es X, es Y» o «cámbialo por Y» reemplaza y conserva cantidad y tamaño. quita borra. «otra» sola suma 1 a la última. «otra de Y» suma 1 de Y y deja lo demás. «una de cada una» es una de cada opción de pending, no todo el menú.",
  "medio=0.5, cuarto=0.25, kilo y medio=1.5, N kilos y tres cuartos=N.75. En piezas, qty es un entero. Docena = 12.",
  "Si la fila dice «1 orden = N piezas», qty es cuántas órdenes. «dos de 20» es esa fila con qty 2. Si esa medida no existe, va en pending y se listan las medidas, sin adivinar.",
  "En carne, $100 o cien pesos: unit pesos, qty 100. Solo en filas kg.",
  "«la que no es marinada», «sin marinar» o «normal» es la fila sin marinar.",
  "Lo que no está en el menú va SOLO en not_on_menu, sin pregunta. Lo demás del mismo mensaje se queda en el carrito.",
  "sí, listo, ya sería todo o eso es todo: confirmed true, pending vacío y el mismo carrito. Nunca confirmes un carrito vacío ni con pending.",
].join("\n");

function examplesFor(profile: InterpretRequest["catalog"]["profile"]): string {
  if (profile === "carniceria") {
    return [
      "«bistec» → pending [{text: «¿El bistec de res o de puerco?», qty y source_text del cliente}], sin esa línea.",
      "«un kilo de diezmillo» → esa fila, qty 1, unit kg, pending [].",
      "«$150 de pastor» → unit pesos, qty 150.",
      "«un pollo entero y un kilo de bistec» → not_on_menu [\"pollo\"] y el bistec en el carrito, pending [].",
      "«la que no es marinada» → la fila sin marinar.",
      "«sí está bien» → confirmed true, pending [], carrito igual.",
    ].join("\n");
  }
  return [
    "«2 hamburguesas» → pending con «¿Cuál hamburguesa?», qty 2, unit pz, source_text «2 hamburguesas», sin esa línea.",
    "«una de res chica» → esa fila, qty 1, pending []. Si solo hay una opción, se agrega y no se pregunta.",
    "«10 alitas» → la fila «1 orden = 10 piezas», qty 1. «dos alitas de 20» → la de 20, qty 2. «alitas de 12» → pending con 5, 10, 15, 20 y 30, sin línea.",
    "«una docena de dogos» → ese dogo, qty 12. Docena = 12.",
    "«no es cubana, es hawaiana» con una Grande → la hawaiana Grande, misma qty.",
    "«otra de pierna» suma 1 de pierna y deja lo demás. «otra» sola suma 1 a la última.",
    "«un pizzadogo» es Pizzadogo. «una manzanita» es Refresco sabor Manzana.",
    "«una pizza y dos dogos» → not_on_menu [\"pizza\"] y los dogos en el carrito, pending [].",
    "«sí está bien» → confirmed true, pending [], carrito igual.",
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

function packNote(row: CatalogRow): string {
  if (!row.size || !/^\d+$/.test(row.size)) return "";
  if (!/\b(alitas|boneless|dedos)\b/.test(fold(`${row.family} ${row.name}`))) return "";
  return ` | 1 orden = ${row.size} piezas`;
}

function menuLines(request: InterpretRequest): string {
  return request.catalog.rows
    .map((row) => {
      const flavors = row.variants.length ? ` [${row.variants.join("/")}]` : "";
      return `${row.id} ${row.name} $${row.precio} ${row.unit}${flavors}${aliasSuffix(row)}${packNote(row)}`;
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

function describePending(
  pending: { question: string; sourceText: string; qty: number; unit: string; candidateIds: number[] },
  catalog: InterpretRequest["catalog"],
): string {
  const options = pending.candidateIds
    .map((id) => {
      const row = catalog.byId.get(id);
      return row ? `${id} ${row.name}` : String(id);
    })
    .join(", ");
  return `Pregunta pendiente: ${pending.question}. Era: "${pending.sourceText}", qty ${pending.qty} ${pending.unit}. Opciones: ${options}`;
}

function stepLine(request: InterpretRequest): string {
  if (request.repairErrors?.length) return `Corrige el JSON. ${request.repairErrors.join(" ")}`;
  if (request.pending) {
    const lines = [request.pending, ...(request.pending.queue ?? [])];
    return lines.map((pending) => describePending(pending, request.catalog)).join("\n");
  }
  if (request.awaitingList) return "Ya vio la lista. Un sí la confirma. Un cambio la edita. Con pending no se confirma.";
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
    required: ["cart", "pending", "not_on_menu", "confirmed"],
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
      pending: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "candidate_ids", "qty", "unit", "source_text"],
          properties: {
            text: { type: "string" },
            candidate_ids: { type: "array", items: { type: "integer" } },
            qty: { anyOf: [{ type: "number" }, { type: "null" }] },
            unit: { anyOf: [{ type: "string", enum: ["pz", "kg", "pesos"] }, { type: "null" }] },
            source_text: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
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
    pending: [],
    question: null,
    not_on_menu: [],
    confirmed: false,
  };
}

function parsePendingItem(value: unknown): AiPendingLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const ids = Array.isArray(row.candidate_ids) ? row.candidate_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)) : [];
  const qty = row.qty == null || row.qty === "" ? null : Number(row.qty);
  return {
    text: String(row.text ?? ""),
    candidate_ids: ids,
    qty: qty != null && Number.isFinite(qty) ? qty : null,
    unit: asUnit(row.unit),
    source_text: row.source_text == null ? null : String(row.source_text),
  };
}

export function parseModelJson(raw: unknown): AiOutput | null {
  const body = typeof raw === "string" ? safeJson(raw) : raw;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.cart) || !Array.isArray(record.not_on_menu) || typeof record.confirmed !== "boolean") return null;
  const pending = Array.isArray(record.pending)
    ? record.pending.map(parsePendingItem).filter((item): item is AiPendingLine => Boolean(item))
    : [];
  const question = parsePendingItem(record.question);
  return {
    confirmed: record.confirmed,
    not_on_menu: record.not_on_menu.map((item) => String(item)).filter((item) => item.trim()),
    pending: pending.length ? pending : question ? [question] : [],
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
