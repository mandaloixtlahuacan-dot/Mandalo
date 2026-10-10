/**
 * Corpus del menú cerrado (George y La Central).
 *
 *   npx tsx scripts/check-catalog-orders.ts            mock + fallback + adversarial
 *   npx tsx scripts/check-catalog-orders.ts --fallback
 *   npx tsx scripts/check-catalog-orders.ts --mock
 *   npx tsx scripts/check-catalog-orders.ts --replay
 *   npx tsx scripts/check-catalog-orders.ts --live
 *
 * --live llama a OpenAI (gpt-4.1 y gpt-4.1-mini) si hay OPENAI_API_KEY.
 * Sin llave, el default deja el vivo pendiente y exige mock 100% y fallback >= 85%.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildCatalog, runCatalogOrderTurn, validateModelOutput, type CartLine, type CatalogModel, type CatalogSnapshot, type ModelOutput, type RawCatalogRow } from "../src/lib/catalogOrder";
import { fold, tokens } from "../src/lib/catalogOrder/text";

type ExpectItem = { name: string; qty: number; unit: string; variant?: string };
type CorpusCase = {
  id: string;
  store: "george" | "central";
  category: string;
  turns: string[];
  expect: { items: ExpectItem[]; ask: "none" | "clarify" | "not_available"; ask_contains: string[]; not_available: string[] };
  note?: string;
};

process.env.CATALOG_ORDER_QUIET = "1";

const root = resolve(__dirname, "fixtures");
const corpus = JSON.parse(readFileSync(resolve(root, "catalog-order-corpus.json"), "utf8")) as { cases: CorpusCase[] };
const catalogs = JSON.parse(readFileSync(resolve(root, "catalogs.json"), "utf8")) as {
  tienda_5_george: RawCatalogRow[];
  tienda_6_la_central: RawCatalogRow[];
};

const george = buildCatalog(catalogs.tienda_5_george, "restaurante", "priced");
const central = buildCatalog(catalogs.tienda_6_la_central, "carniceria", "priced");

function catalogFor(store: CorpusCase["store"]): CatalogSnapshot {
  return store === "george" ? george : central;
}

function unitOf(unit: string): "pz" | "kg" | "pesos" {
  if (unit === "$" || unit === "pesos") return "pesos";
  if (unit === "kg") return "kg";
  return "pz";
}

function suggest(message: string, catalog: CatalogSnapshot): number[] {
  const text = fold(message);
  if (/\bsprite\b/.test(text)) return catalog.rows.filter((row) => row.variants.length > 0).map((row) => row.id);
  if (/\balitas\b/.test(text)) return catalog.rows.filter((row) => row.family === "alitas").map((row) => row.id);
  const words = tokens(text).filter((token) => token.length >= 4);
  return catalog.rows
    .filter((row) => words.some((word) => fold(`${row.name} ${row.family}`).includes(word)))
    .map((row) => row.id);
}

function teacherOutput(catalog: CatalogSnapshot, item: CorpusCase, message: string, prior: CartLine[]): ModelOutput {
  const desired: ModelOutput["cart"] = item.expect.items.map((line) => {
    const row = catalog.rows.find((candidate) => candidate.name === line.name);
    if (!row) throw new Error(`${item.id} no tiene fila ${line.name}`);
    return {
      product_id: row.id,
      qty: line.qty,
      unit: unitOf(line.unit),
      variant: line.variant ?? null,
      notes: null,
    };
  });
  const changes: ModelOutput["changes"] = [];
  for (const line of desired) {
    const prev = prior.find((have) => have.productId === line.product_id && have.unit === line.unit && (have.variant ?? null) === (line.variant ?? null));
    if (!prev) changes.push({ op: "add", product_id: line.product_id, from_product_id: null, source_text: message, qty: line.qty, unit: line.unit, variant: line.variant });
    else if (Math.abs(prev.qty - line.qty) > 0.001) changes.push({ op: "set_qty", product_id: line.product_id, from_product_id: null, source_text: message, qty: line.qty, unit: line.unit, variant: line.variant });
  }
  for (const line of prior) {
    const still = desired.some((have) => have.product_id === line.productId && have.unit === line.unit && (have.variant ?? null) === (line.variant ?? null));
    if (!still) changes.push({ op: "remove", product_id: line.productId, from_product_id: line.productId, source_text: message });
  }
  const unmatched: ModelOutput["unmatched"] = [];
  if (item.expect.ask === "not_available") {
    for (const term of item.expect.not_available) unmatched.push({ source_text: term, reason: "not_on_menu", candidate_ids: [] });
  }
  if (item.expect.ask === "clarify") {
    unmatched.push({ source_text: message, reason: "ambiguous", candidate_ids: suggest(item.turns.join(" "), catalog) });
  }
  return { intent: "order", cart: item.expect.ask === "clarify" ? [] : desired, changes: item.expect.ask === "clarify" ? [] : changes, unmatched, confidence: "high" };
}

function teacher(item: CorpusCase, catalog: CatalogSnapshot): CatalogModel {
  return {
    name: "mock",
    async interpret(request) {
      return teacherOutput(catalog, item, request.message, request.cart);
    },
  };
}

type Failure = { id: string; category: string; store: string; reasons: string[] };

function score(item: CorpusCase, cart: CartLine[], reply: string, catalog: CatalogSnapshot): string[] {
  const reasons: string[] = [];
  const expected = item.expect.items.map((line) => {
    const row = catalog.rows.find((candidate) => candidate.name === line.name);
    return { id: row?.id ?? -1, qty: line.qty, unit: unitOf(line.unit), variant: line.variant ?? null, name: line.name };
  });
  const got = cart.map((line) => ({
    id: line.productId,
    qty: line.qty,
    unit: line.unit,
    variant: line.variant ?? null,
    name: catalog.byId.get(line.productId)?.name ?? String(line.productId),
  }));
  const used = new Set<number>();
  for (const line of expected) {
    const index = got.findIndex((candidate, position) => !used.has(position) && candidate.id === line.id && candidate.unit === line.unit && candidate.variant === line.variant && Math.abs(candidate.qty - line.qty) <= 0.01);
    if (index < 0) reasons.push(`falta ${line.name} x${line.qty} ${line.unit}${line.variant ? ` ${line.variant}` : ""}`);
    else used.add(index);
  }
  got.forEach((line, index) => {
    if (!used.has(index)) reasons.push(`sobra ${line.name} x${line.qty} ${line.unit}${line.variant ? ` ${line.variant}` : ""}`);
  });

  const replyFold = fold(reply);
  if (item.expect.ask === "none") {
    if (/¿\s*cu[aá]l|¿\s*te refieres|chica o grande|¿\s*una m[aá]s/i.test(reply)) reasons.push(`preguntó de más: ${reply.slice(0, 180)}`);
  } else if (item.expect.ask === "clarify") {
    const asks = /[¿?]/.test(reply) || /cual |te refieres|chica|grande/.test(replyFold);
    if (!asks) reasons.push("no preguntó");
    for (const word of item.expect.ask_contains) {
      if (!replyFold.includes(fold(word))) reasons.push(`la pregunta no trae «${word}»`);
    }
  } else if (item.expect.ask === "not_available") {
    if (!/no lo manejamos|no tenemos|no hay/.test(replyFold)) reasons.push("no dijo que no lo maneja");
    for (const term of item.expect.not_available) {
      if (!replyFold.includes(fold(term))) reasons.push(`no mencionó «${term}»`);
    }
  }
  return reasons;
}

async function runCase(item: CorpusCase, model: CatalogModel | null): Promise<{ cart: CartLine[]; reply: string }> {
  const catalog = catalogFor(item.store);
  let cart: CartLine[] = [];
  let pending = null;
  let reply = "";
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const turn of item.turns) {
    const result = await runCatalogOrderTurn({
      message: turn,
      cart,
      pending,
      history,
      catalog,
      awaitingList: reply.includes("¿Están bien estos productos?"),
      model,
    });
    cart = result.cart;
    pending = result.pending;
    reply = result.reply;
    history.push({ role: "user", text: turn }, { role: "assistant", text: reply });
    history.splice(0, Math.max(0, history.length - 6));
  }
  return { cart, reply };
}

async function runMode(mode: "mock" | "fallback" | "replay" | "live", liveModel?: string): Promise<{ pass: number; fail: Failure[]; byCategory: Map<string, { pass: number; total: number }> }> {
  const failures: Failure[] = [];
  const byCategory = new Map<string, { pass: number; total: number }>();
  const recordingsPath = resolve(root, "catalog-llm-recordings.json");
  const recordings = mode === "replay" && existsSync(recordingsPath)
    ? (JSON.parse(readFileSync(recordingsPath, "utf8")) as Record<string, ModelOutput[]>)
    : null;
  if (mode === "replay" && !recordings) {
    console.log("--replay: no hay scripts/fixtures/catalog-llm-recordings.json");
    return { pass: 0, fail: [], byCategory };
  }

  for (const item of corpus.cases) {
    const bucket = byCategory.get(item.category) ?? { pass: 0, total: 0 };
    bucket.total += 1;
    const catalog = catalogFor(item.store);
    let model: CatalogModel | null = null;
    if (mode === "mock") model = teacher(item, catalog);
    if (mode === "replay" && recordings) {
      const turns = recordings[item.id] ?? [];
      let index = 0;
      model = {
        name: "replay",
        async interpret() {
          return turns[index++] ?? null;
        },
      };
    }
    if (mode === "live" && liveModel) {
      const { createOpenAICatalogModel } = await import("../src/lib/catalogOrder/parser");
      model = createOpenAICatalogModel(liveModel);
    }
    const { cart, reply } = await runCase(item, model);
    const reasons = score(item, cart, reply, catalog);
    if (reasons.length) failures.push({ id: item.id, category: item.category, store: item.store, reasons });
    else bucket.pass += 1;
    byCategory.set(item.category, bucket);
  }
  return { pass: corpus.cases.length - failures.length, fail: failures, byCategory };
}

function printReport(label: string, report: { pass: number; fail: Failure[]; byCategory: Map<string, { pass: number; total: number }> }): void {
  console.log(`\n${label}: ${report.pass}/${corpus.cases.length}`);
  const categories = [...report.byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [category, bucket] of categories) console.log(`  ${category}: ${bucket.pass}/${bucket.total}`);
  for (const failure of report.fail.slice(0, 40)) {
    console.log(`  ${failure.id} ${failure.store}/${failure.category}: ${failure.reasons.join("; ")}`);
  }
  if (report.fail.length > 40) console.log(`  … y ${report.fail.length - 40} más`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function adversarial(): void {
  const catalog = central;
  const pastor = catalog.rows.find((row) => row.name === "Carne de puerco al pastor");
  const peinesillo = catalog.rows.find((row) => row.name === "Peinesillo");
  const arrachera = catalog.rows.find((row) => row.name === "Arrachera Marinada");
  const chorizo = catalog.rows.find((row) => row.name === "Chorizo");
  assert(pastor && peinesillo && arrachera && chorizo, "faltan filas de La Central");

  const prior: CartLine[] = [
    { productId: arrachera.id, qty: 1, unit: "kg", variant: null, notes: null },
    { productId: chorizo.id, qty: 1, unit: "kg", variant: null, notes: null },
  ];
  const dropped = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: arrachera.id, qty: 1, unit: "kg", variant: null, notes: null }],
      changes: [],
      unmatched: [],
    },
    prior,
    message: "quita nada",
    catalog,
  });
  assert(dropped.cart.length === 2, "un modelo que borra una línea sin respaldo no debe dejarla fuera");

  const invented = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: 99999, qty: 1, unit: "kg", variant: null, notes: null }],
      changes: [{ op: "add", product_id: 99999, from_product_id: null, source_text: "pollo" }],
      unmatched: [],
    },
    prior: [],
    message: "un kilo de pollo",
    catalog,
  });
  assert(invented.cart.length === 0, "un id fuera del menú no entra al carrito");

  const merged = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: arrachera.id, qty: 2, unit: "kg", variant: null, notes: null }],
      changes: [{ op: "set_qty", product_id: arrachera.id, from_product_id: null, source_text: "junto todo" }],
      unmatched: [],
    },
    prior,
    message: "junto todo",
    catalog,
  });
  assert(merged.cart.some((line) => line.productId === chorizo.id), "juntar dos cortes no puede perder el chorizo");

  const refresco = george.rows.find((row) => row.variants.length > 0);
  assert(refresco, "falta el refresco");
  const wrongUnit = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: refresco.id, qty: 1, unit: "kg", variant: "Pepsi", notes: null }],
      changes: [{ op: "add", product_id: refresco.id, from_product_id: null, source_text: "una pepsi" }],
      unmatched: [],
    },
    prior: [],
    message: "una pepsi",
    catalog: george,
  });
  assert(!wrongUnit.cart.some((line) => line.unit === "kg"), "un refresco no se anota en kilos");

  const quarter = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: pastor.id, qty: 4, unit: "pz", variant: null, notes: null }],
      changes: [{ op: "add", product_id: pastor.id, from_product_id: null, source_text: "1/4 de carne de puerco al pastor" }],
      unmatched: [],
    },
    prior: [],
    message: "1/4 de carne de puerco al pastor",
    catalog,
  });
  const pastorLine = quarter.cart.find((line) => line.productId === pastor.id);
  assert(pastorLine && Math.abs(pastorLine.qty - 0.25) < 0.001 && pastorLine.unit === "kg", "1/4 no puede volverse 4 piezas");

  const asked = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "un kilo de peinecillo", reason: "ambiguous", candidate_ids: [peinesillo.id] }],
    },
    prior: [],
    message: "un kilo de peinecillo",
    catalog,
  });
  assert(asked.cart.some((line) => line.productId === peinesillo.id) && !asked.unmatched.some((item) => item.reason === "ambiguous"), "Peinesillo es una sola fila: no se pregunta el tipo");
  console.log("adversarial: 6/6");
}

async function live(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("--live pendiente: no hay OPENAI_API_KEY en este entorno.");
    return;
  }
  const recordings: Record<string, unknown[]> = {};
  for (const modelName of ["gpt-4.1", "gpt-4.1-mini"]) {
    const started: number[] = [];
    const { createOpenAICatalogModel } = await import("../src/lib/catalogOrder/parser");
    let pass = 0;
    for (const item of corpus.cases) {
      const catalog = catalogFor(item.store);
      const turns: unknown[] = [];
      const wrapped: CatalogModel = {
        name: modelName,
        async interpret(request) {
          const t0 = Date.now();
          const output = await createOpenAICatalogModel(modelName).interpret(request);
          started.push(Date.now() - t0);
          turns.push(output);
          return output;
        },
      };
      const { cart, reply } = await runCase(item, wrapped);
      if (modelName === "gpt-4.1") recordings[item.id] = turns;
      if (!score(item, cart, reply, catalog).length) pass += 1;
    }
    started.sort((a, b) => a - b);
    const p50 = started[Math.floor(started.length * 0.5)] ?? 0;
    const p95 = started[Math.floor(started.length * 0.95)] ?? 0;
    console.log(`${modelName}: ${pass}/${corpus.cases.length} p50=${p50}ms p95=${p95}ms`);
  }
  writeFileSync(resolve(root, "catalog-llm-recordings.json"), JSON.stringify(recordings, null, 1));
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "--default";
  if (arg === "--live") {
    await live();
    return;
  }
  if (arg === "--replay") {
    printReport("replay", await runMode("replay"));
    return;
  }
  if (arg === "--fallback") {
    const report = await runMode("fallback");
    printReport("fallback", report);
    if (report.pass < Math.ceil(corpus.cases.length * 0.85)) process.exitCode = 1;
    return;
  }
  if (arg === "--mock") {
    const report = await runMode("mock");
    printReport("mock", report);
    if (report.pass !== corpus.cases.length) process.exitCode = 1;
    return;
  }

  adversarial();
  const mocked = await runMode("mock");
  printReport("mock", mocked);
  const fallback = await runMode("fallback");
  printReport("fallback", fallback);
  if (!process.env.OPENAI_API_KEY) console.log("\n--live pendiente: no hay OPENAI_API_KEY. Hay que correrlo antes de prender el motor en producción.");
  if (mocked.pass !== corpus.cases.length || fallback.pass < Math.ceil(corpus.cases.length * 0.85)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
