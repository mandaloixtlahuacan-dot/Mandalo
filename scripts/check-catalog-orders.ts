/**
 * Corpus del menú cerrado (George y La Central).
 *
 *   npx tsx scripts/check-catalog-orders.ts            mock + fallback + adversarial
 *   npx tsx scripts/check-catalog-orders.ts --fallback
 *   npx tsx scripts/check-catalog-orders.ts --mock
 *   npx tsx scripts/check-catalog-orders.ts --replay
 *   npx tsx scripts/check-catalog-orders.ts --live
 *
 * --replay califica el corpus, el held-out, los 40 casos y los 50 nuevos
 * con las grabaciones de la segunda y la tercera evaluación.
 * No forma parte del default: el lector de respaldo no se afina contra esos casos.
 * --live llama a OpenAI (gpt-4.1-mini y gpt-5.5) si hay OPENAI_API_KEY.
 * Sin llave, el default deja el vivo pendiente y exige mock 100% y fallback >= 85%.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildCatalog, runCatalogOrderTurn, validateModelOutput, type CartLine, type CatalogModel, type CatalogSnapshot, type ModelOutput, type PendingCatalogAsk, type RawCatalogRow } from "../src/lib/catalogOrder";
import { resolvePending } from "../src/lib/catalogOrder/fallback";
import { parseQuantity } from "../src/lib/catalogOrder/quantities";
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
const heldoutPath = resolve(root, "catalog-order-heldout.json");
const heldout = existsSync(heldoutPath)
  ? (JSON.parse(readFileSync(heldoutPath, "utf8")) as { cases: CorpusCase[] })
  : { cases: [] as CorpusCase[] };
const unseenPath = resolve(root, "catalog-order-unseen.json");
const unseen = existsSync(unseenPath)
  ? (JSON.parse(readFileSync(unseenPath, "utf8")) as { cases: CorpusCase[] })
  : { cases: [] as CorpusCase[] };
const new50Path = resolve(root, "catalog-order-new50.json");
const fresh = existsSync(new50Path)
  ? (JSON.parse(readFileSync(new50Path, "utf8")) as { cases: CorpusCase[] })
  : { cases: [] as CorpusCase[] };
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

async function runCases(
  cases: CorpusCase[],
  mode: "mock" | "fallback" | "replay" | "live",
  recordings?: Record<string, ModelOutput[] | null> | null,
  liveModel?: string,
): Promise<{ pass: number; total: number; fail: Failure[]; byCategory: Map<string, { pass: number; total: number }> }> {
  const failures: Failure[] = [];
  const byCategory = new Map<string, { pass: number; total: number }>();

  for (const item of cases) {
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
  return { pass: cases.length - failures.length, total: cases.length, fail: failures, byCategory };
}

function printReport(label: string, report: { pass: number; total: number; fail: Failure[]; byCategory: Map<string, { pass: number; total: number }> }, limit = 40): void {
  console.log(`\n${label}: ${report.pass}/${report.total}`);
  const categories = [...report.byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [category, bucket] of categories) console.log(`  ${category}: ${bucket.pass}/${bucket.total}`);
  for (const failure of report.fail.slice(0, limit)) {
    console.log(`  ${failure.id} ${failure.store}/${failure.category}: ${failure.reasons.join("; ")}`);
  }
  if (report.fail.length > limit) console.log(`  … y ${report.fail.length - limit} más`);
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
  guardrails();
}

function lineOf(cart: CartLine[], name: string, catalog: CatalogSnapshot): CartLine | undefined {
  const row = catalog.rows.find((item) => item.name === name);
  return cart.find((item) => item.productId === row?.id);
}

function guardrails(): void {
  assert(parseQuantity("quinientos pesos de ribeye", "carniceria").qty === 500, "quinientos pesos son 500");
  assert(parseQuantity("doscientos cincuenta pesos de ribeye", "carniceria").qty === 250, "doscientos cincuenta son 250");
  assert(parseQuantity("trescientos pesos de arrachera", "carniceria").qty === 300, "trescientos pesos son 300");
  assert(Math.abs(parseQuantity("tres cuartos de pulpa", "carniceria").qty - 0.75) < 0.001, "tres cuartos son 0.75 kg");
  assert(Math.abs(parseQuantity("y medio de pulpa", "carniceria").qty - 0.5) < 0.001, "y medio son 0.5 kg");
  assert(Math.abs(parseQuantity("kilo y medio de chamberete", "carniceria").qty - 1.5) < 0.001, "kilo y medio sigue en 1.5");
  assert(parseQuantity("de a cien de pastor", "carniceria").unit === "pesos" && parseQuantity("de a cien de pastor", "carniceria").qty === 100, "de a cien son $100");

  const pulpa = central.rows.find((row) => row.name === "Pulpa de puerco");
  const arrachera = central.rows.find((row) => row.name === "Arrachera Marinada");
  const costilla = central.rows.find((row) => row.name === "Costilla de puerco");
  const costillaM = central.rows.find((row) => row.name === "Costilla de puerco marinada");
  const chamberete = central.rows.find((row) => row.name === "Chamberete");
  const diezmillo = central.rows.find((row) => row.name === "Diezmillo");
  const carbon = central.rows.find((row) => row.name === "Carbón fino");
  const refresco = george.rows.find((row) => row.variants.length > 0);
  const alitas5 = george.rows.find((row) => row.family === "alitas" && row.size === "5");
  const alitas15 = george.rows.find((row) => row.family === "alitas" && row.size === "15");
  const alitas20 = george.rows.find((row) => row.family === "alitas" && row.size === "20");
  assert(pulpa && arrachera && costilla && costillaM && chamberete && diezmillo && carbon && refresco && alitas5 && alitas15 && alitas20, "faltan filas para las guardas");

  const spread = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [
        { product_id: pulpa.id, qty: 0.25, unit: "kg", variant: null, notes: null },
        { product_id: arrachera.id, qty: 300, unit: "pesos", variant: null, notes: null },
      ],
      changes: [
        { op: "add", product_id: pulpa.id, from_product_id: null, source_text: "ponme trescientos pesos de arrachera y un cuarto de pulpa" },
        { op: "add", product_id: arrachera.id, from_product_id: null, source_text: "ponme trescientos pesos de arrachera y un cuarto de pulpa" },
      ],
      unmatched: [],
    },
    prior: [],
    message: "ponme trescientos pesos de arrachera y un cuarto de pulpa",
    catalog: central,
  });
  const pulpaLine = lineOf(spread.cart, "Pulpa de puerco", central);
  const arraLine = lineOf(spread.cart, "Arrachera Marinada", central);
  assert(pulpaLine?.unit === "kg" && Math.abs((pulpaLine?.qty ?? 0) - 0.25) < 0.001, "el monto en pesos no se copia a la otra carne");
  assert(arraLine?.unit === "pesos" && arraLine.qty === 300, "trescientos pesos se quedan en la arrachera");

  const tiny = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: arrachera.id, qty: 1, unit: "pesos", variant: null, notes: null }],
      changes: [{ op: "add", product_id: arrachera.id, from_product_id: null, source_text: "ochenta pesos de arrachera" }],
      unmatched: [],
    },
    prior: [],
    message: "ochenta pesos de arrachera",
    catalog: central,
  });
  assert(lineOf(tiny.cart, "Arrachera Marinada", central)?.qty === 80, "ochenta pesos no se quedan en $1");

  const rejected = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: arrachera.id, qty: 1, unit: "pesos", variant: null, notes: null }],
      changes: [{ op: "add", product_id: arrachera.id, from_product_id: null, source_text: "arrachera por favor" }],
      unmatched: [],
    },
    prior: [],
    message: "arrachera por favor",
    catalog: central,
  });
  assert(!rejected.cart.some((line) => line.unit === "pesos" && line.qty < 20), "no sale un peso inventado");

  const half = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: pulpa.id, qty: 1.5, unit: "kg", variant: null, notes: null }],
      changes: [{ op: "add", product_id: pulpa.id, from_product_id: null, source_text: "y medio de pulpa" }],
      unmatched: [],
    },
    prior: [],
    message: "y medio de pulpa",
    catalog: central,
  });
  assert(Math.abs((lineOf(half.cart, "Pulpa de puerco", central)?.qty ?? 0) - 0.5) < 0.001, "y medio de pulpa es 0.5 kg");

  const wings = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: alitas5.id, qty: 3, unit: "pz", variant: null, notes: null }],
      changes: [{ op: "add", product_id: alitas5.id, from_product_id: null, source_text: "15 alitas" }],
      unmatched: [],
    },
    prior: [],
    message: "15 alitas",
    catalog: george,
  });
  const wingLine = lineOf(wings.cart, alitas15.name, george);
  assert(wingLine?.qty === 1, "15 alitas es una orden del paquete de 15, no tres de 5");

  const repeat = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: alitas20.id, qty: 2, unit: "pz", variant: null, notes: null }],
      changes: [
        { op: "add", product_id: alitas20.id, from_product_id: null, source_text: "alitas de 20" },
        { op: "add", product_id: alitas20.id, from_product_id: null, source_text: "unas de 20 piezas" },
      ],
      unmatched: [],
    },
    prior: [],
    message: "alitas de 20, unas de 20 piezas",
    catalog: george,
  });
  assert(lineOf(repeat.cart, alitas20.name, george)?.qty === 1, "repetir el mismo paquete es una orden");

  const flavors = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [
        { product_id: refresco.id, qty: 4, unit: "pz", variant: "Coca", notes: null },
        { product_id: refresco.id, qty: 1, unit: "pz", variant: "Coca", notes: null },
      ],
      changes: [
        { op: "add", product_id: refresco.id, from_product_id: null, source_text: "cuatro pepsis" },
        { op: "add", product_id: refresco.id, from_product_id: null, source_text: "una mirinda" },
      ],
      unmatched: [],
    },
    prior: [],
    message: "cuatro pepsis y una mirinda",
    catalog: george,
  });
  const pepsi = flavors.cart.find((line) => line.productId === refresco.id && line.variant === "Pepsi");
  const mirinda = flavors.cart.find((line) => line.productId === refresco.id && line.variant === "Mirinda");
  assert(pepsi?.qty === 4 && mirinda?.qty === 1, "el sabor sale del texto de cada línea");

  const leaked = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [
        { product_id: arrachera.id, qty: 0.5, unit: "kg", variant: null, notes: null },
        { product_id: costillaM.id, qty: 1, unit: "kg", variant: null, notes: null },
      ],
      changes: [
        { op: "add", product_id: arrachera.id, from_product_id: null, source_text: "medio de arrachera marinada" },
        { op: "add", product_id: costillaM.id, from_product_id: null, source_text: "un kilo de costiya" },
      ],
      unmatched: [],
    },
    prior: [],
    message: "ponme medio de arrachera marinada y un kilo de costiya",
    catalog: central,
  });
  assert(lineOf(leaked.cart, "Arrachera Marinada", central)?.unit === "kg", "la arrachera marinada sí entra");
  assert(!leaked.cart.some((line) => line.productId === costillaM.id), "marinado no se pega a la costilla");
  assert(leaked.unmatched.some((item) => item.reason === "ambiguous" || item.reason === "unclear"), "la costilla sin tipo se pregunta");

  const dropped = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "medio kilo de molida", reason: "not_on_menu", candidate_ids: [arrachera.id] }],
    },
    prior: [],
    message: "medio kilo de molida y un kilo de chamberete",
    catalog: central,
  });
  assert(lineOf(dropped.cart, "Chamberete", central)?.qty === 1, "lo que sí está en el menú no se pierde");
  assert(dropped.unmatched.some((item) => item.reason === "not_on_menu"), "la molida sigue fuera del menú");

  const voice = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "cuatro kilos de 10 millo", reason: "not_on_menu", candidate_ids: [diezmillo.id, chamberete.id] }],
    },
    prior: [],
    message: "cuatro kilos de 10 millo",
    catalog: central,
  });
  assert(lineOf(voice.cart, "Diezmillo", central)?.qty === 4, "10 millo se lee como diezmillo");

  const firo = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "tres carbones firo", reason: "not_on_menu", candidate_ids: [carbon.id] }],
    },
    prior: [],
    message: "tres carbones firo",
    catalog: central,
  });
  assert(lineOf(firo.cart, "Carbón fino", central)?.qty === 3, "firo se lee como carbón fino");

  const apple = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "dos manzanitas", reason: "not_on_menu", candidate_ids: [refresco.id] }],
    },
    prior: [],
    message: "dos manzanitas",
    catalog: george,
  });
  assert(apple.cart.some((line) => line.productId === refresco.id && line.variant === "Manzana" && line.qty === 2), "manzanita es el refresco de manzana");

  const pending: PendingCatalogAsk = {
    sourceText: "3 refrescos",
    candidateIds: [refresco.id],
    qty: 3,
    unit: "pz",
    variant: null,
    family: "refresco",
    question: "¿El refresco de qué sabor?",
    count: 1,
  };
  const split = resolvePending(pending, "dos de pepsi y una de mirinda", george);
  const splitPepsi = split?.find((line) => line.variant === "Pepsi");
  const splitMirinda = split?.find((line) => line.variant === "Mirinda");
  assert(splitPepsi?.qty === 2 && splitMirinda?.qty === 1, "al partir sabores se conserva el número de cada uno");

  const meatPending: PendingCatalogAsk = {
    sourceText: "1 kg de costiya",
    candidateIds: [costillaM.id, costilla.id],
    qty: 1,
    unit: "kg",
    variant: null,
    family: costilla.family,
    question: "¿La costilla normal o la marinada?",
    count: 1,
  };
  const plain = resolvePending(meatPending, "sin marinar", central);
  assert(plain?.length === 1 && plain[0].productId === costilla.id && plain[0].qty === 1, "sin marinar elige la fila sin marinar");

  const unclear = validateModelOutput({
    output: {
      intent: "order",
      confidence: "low",
      cart: [],
      changes: [],
      unmatched: [{ source_text: "medio de pura de cerdo", reason: "unclear", candidate_ids: [pulpa.id] }],
    },
    prior: [],
    message: "medio de pura de cerdo",
    catalog: central,
  });
  assert(Math.abs((lineOf(unclear.cart, "Pulpa de puerco", central)?.qty ?? 0) - 0.5) < 0.001, "un solo candidato nombrado no se vuelve pregunta");
  assert(Math.abs(parseQuantity("dos kilos y cuarto de chorizo", "carniceria").qty - 2.25) < 0.001, "dos kilos y cuarto son 2.25");
  assert(parseQuantity("ciento cincuenta de bistec de puerco", "carniceria").unit === "pesos" && parseQuantity("ciento cincuenta de bistec de puerco", "carniceria").qty === 150, "ciento cincuenta de carne son pesos");

  const chorizo = central.rows.find((row) => row.name === "Chorizo");
  const bistecM = central.rows.find((row) => row.name === "Bistec de puerco marinado");
  const ribeye = central.rows.find((row) => row.name === "Ribeye de res con hueso");
  const quesaburra = george.rows.find((row) => row.name === "Quesadilla Quesaburra");
  assert(chorizo && bistecM && ribeye && quesaburra, "faltan filas de la tercera evaluación");

  const compound = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: chorizo.id, qty: 2.25, unit: "kg", variant: null, notes: null }],
      changes: [{ op: "add", product_id: chorizo.id, from_product_id: null, source_text: "ponme dos kilos y cuarto de chorizo" }],
      unmatched: [],
    },
    prior: [],
    message: "ponme dos kilos y cuarto de chorizo",
    catalog: central,
  });
  assert(Math.abs((lineOf(compound.cart, "Chorizo", central)?.qty ?? 0) - 2.25) < 0.001, "el modelo en 2.25 no se baja a un cuarto");

  const carried = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [
        { product_id: chorizo.id, qty: 0.1, unit: "kg", variant: null, notes: null },
        { product_id: bistecM.id, qty: 0.15, unit: "kg", variant: null, notes: null },
      ],
      changes: [
        { op: "add", product_id: chorizo.id, from_product_id: null, source_text: "de a 80 de chorizo" },
        { op: "add", product_id: bistecM.id, from_product_id: null, source_text: "120 de bistec de puerco marinado" },
      ],
      unmatched: [],
    },
    prior: [],
    message: "de a 80 de chorizo y 120 de bistec de puerco marinado",
    catalog: central,
  });
  assert(lineOf(carried.cart, "Chorizo", central)?.unit === "pesos" && lineOf(carried.cart, "Chorizo", central)?.qty === 80, "de a 80 se queda en pesos");
  assert(lineOf(carried.cart, "Bistec de puerco marinado", central)?.unit === "pesos" && lineOf(carried.cart, "Bistec de puerco marinado", central)?.qty === 120, "120 de bistec también es pesos");

  const splitDrink = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [
        { product_id: refresco.id, qty: 3, unit: "pz", variant: "Coca", notes: null },
        { product_id: refresco.id, qty: 2, unit: "pz", variant: "Seven", notes: null },
        { product_id: refresco.id, qty: 1, unit: "pz", variant: "Mirinda", notes: null },
      ],
      changes: [{ op: "add", product_id: refresco.id, from_product_id: null, source_text: "seis refrescos: tres coca, dos seven y una mirinda" }],
      unmatched: [],
    },
    prior: [],
    message: "seis refrescos: tres coca, dos seven y una mirinda",
    catalog: george,
  });
  assert(splitDrink.cart.filter((line) => line.productId === refresco.id).length === 3, "cada sabor del refresco se queda");

  const keptName = validateModelOutput({
    output: {
      intent: "edit",
      confidence: "high",
      cart: [
        { product_id: arrachera.id, qty: 1, unit: "kg", variant: null, notes: null },
        { product_id: diezmillo.id, qty: 0, unit: "kg", variant: null, notes: null },
      ],
      changes: [{ op: "remove", product_id: diezmillo.id, from_product_id: diezmillo.id, source_text: "perdon, diezmillo" }],
      unmatched: [],
    },
    prior: [
      { productId: arrachera.id, qty: 1, unit: "kg", variant: null, notes: null },
      { productId: diezmillo.id, qty: 3, unit: "kg", variant: null, notes: null },
    ],
    message: "perdon, diezmillo",
    catalog: central,
  });
  assert(lineOf(keptName.cart, "Diezmillo", central)?.qty === 3, "nombrar lo que ya está no lo borra");

  const each = resolvePending({
    sourceText: "dos salsas",
    candidateIds: central.rows.filter((row) => /salsa/i.test(row.name)).map((row) => row.id),
    qty: 2,
    unit: "pz",
    variant: null,
    family: null,
    question: "¿La salsa BBQ o Hot Wings?",
    count: 1,
  }, "una de cada una", central);
  assert(each?.length === 2, "una de cada una reparte las dos opciones");

  const wingWord = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: alitas15.id, qty: 15, unit: "pz", variant: null, notes: null }],
      changes: [{ op: "add", product_id: alitas15.id, from_product_id: null, source_text: "quince alitas" }],
      unmatched: [],
    },
    prior: [],
    message: "quince alitas",
    catalog: george,
  });
  assert(lineOf(wingWord.cart, alitas15.name, george)?.qty === 1, "quince alitas es una orden de 15");

  const oneQuesa = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: quesaburra.id, qty: 1, unit: "pz", variant: null, notes: null }],
      changes: [{ op: "add", product_id: quesaburra.id, from_product_id: null, source_text: "quesa burra" }],
      unmatched: [],
    },
    prior: [],
    message: "una quesa burra",
    catalog: george,
  });
  assert(lineOf(oneQuesa.cart, "Quesadilla Quesaburra", george)?.qty === 1 && oneQuesa.unmatched.length === 0, "quesa burra es la única quesaburra");

  const voiceCut = validateModelOutput({
    output: {
      intent: "order",
      confidence: "high",
      cart: [{ product_id: ribeye.id, qty: 1, unit: "kg", variant: null, notes: null }],
      changes: [{ op: "add", product_id: ribeye.id, from_product_id: null, source_text: "un kilo de ribay" }],
      unmatched: [],
    },
    prior: [],
    message: "un kilo de ribay",
    catalog: central,
  });
  assert(lineOf(voiceCut.cart, "Ribeye de res con hueso", central)?.qty === 1, "ribay se queda en el ribeye que el modelo leyó");
  assert(!voiceCut.unmatched.some((item) => item.reason === "not_on_menu"), "no se niega un corte que el modelo sí puso");
  console.log("guardrails: 24/24");
}

async function live(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("--live pendiente: no hay OPENAI_API_KEY en este entorno.");
    return;
  }
  const recordings: Record<string, unknown[]> = {};
  for (const modelName of ["gpt-4.1-mini", "gpt-5.5"]) {
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
      if (modelName === "gpt-4.1-mini") recordings[item.id] = turns;
      if (!score(item, cart, reply, catalog).length) pass += 1;
    }
    started.sort((a, b) => a - b);
    const p50 = started[Math.floor(started.length * 0.5)] ?? 0;
    const p95 = started[Math.floor(started.length * 0.95)] ?? 0;
    console.log(`${modelName}: ${pass}/${corpus.cases.length} p50=${p50}ms p95=${p95}ms`);
  }
  writeFileSync(resolve(root, "catalog-llm-recordings.json"), JSON.stringify(recordings, null, 1));
}

async function replay(): Promise<void> {
  const files = [
    ["eval2 gpt-4.1-mini run1", "catalog-llm-recordings.gpt-4.1-mini.run1.json", false],
    ["eval2 gpt-4.1-mini run2", "catalog-llm-recordings.gpt-4.1-mini.run2.json", false],
    ["eval2 gpt-5.5", "catalog-llm-recordings.gpt-5.5.eval2.json", false],
    ["eval3 gpt-4.1-mini run1", "catalog-llm-recordings.gpt-4.1-mini.eval3.run1.json", true],
    ["eval3 gpt-4.1-mini run2", "catalog-llm-recordings.gpt-4.1-mini.eval3.run2.json", true],
  ] as const;
  if (heldout.cases.length !== 30) {
    console.log(`held-out: se esperaban 30 casos y hay ${heldout.cases.length}`);
    process.exitCode = 1;
  }
  if (unseen.cases.length !== 40) {
    console.log(`unseen: se esperaban 40 casos y hay ${unseen.cases.length}`);
    process.exitCode = 1;
  }
  if (fresh.cases.length !== 50) {
    console.log(`new50: se esperaban 50 casos y hay ${fresh.cases.length}`);
    process.exitCode = 1;
  }
  for (const [label, file, hasFresh] of files) {
    const path = resolve(root, file);
    if (!existsSync(path)) {
      console.log(`--replay: falta ${file}`);
      process.exitCode = 1;
      continue;
    }
    const recordings = JSON.parse(readFileSync(path, "utf8")) as Record<string, ModelOutput[]>;
    printReport(`${label} corpus`, await runCases(corpus.cases, "replay", recordings), 40);
    printReport(`${label} held-out`, await runCases(heldout.cases, "replay", recordings), 40);
    printReport(`${label} unseen`, await runCases(unseen.cases, "replay", recordings), 40);
    if (hasFresh) printReport(`${label} new50`, await runCases(fresh.cases, "replay", recordings), 40);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "--default";
  if (arg === "--live") {
    await live();
    return;
  }
  if (arg === "--replay") {
    await replay();
    return;
  }
  if (arg === "--fallback") {
    const report = await runCases(corpus.cases, "fallback");
    printReport("fallback", report);
    if (report.pass < Math.ceil(corpus.cases.length * 0.85)) process.exitCode = 1;
    return;
  }
  if (arg === "--mock") {
    const report = await runCases(corpus.cases, "mock");
    printReport("mock", report);
    if (report.pass !== corpus.cases.length) process.exitCode = 1;
    return;
  }

  adversarial();
  if (heldout.cases.length !== 30) {
    console.error(`held-out: se esperaban 30 casos y hay ${heldout.cases.length}`);
    process.exitCode = 1;
  }
  if (unseen.cases.length !== 40) {
    console.error(`unseen: se esperaban 40 casos y hay ${unseen.cases.length}`);
    process.exitCode = 1;
  }
  if (fresh.cases.length !== 50) {
    console.error(`new50: se esperaban 50 casos y hay ${fresh.cases.length}`);
    process.exitCode = 1;
  }
  const mocked = await runCases(corpus.cases, "mock");
  printReport("mock", mocked);
  const fallback = await runCases(corpus.cases, "fallback");
  printReport("fallback", fallback);
  if (!process.env.OPENAI_API_KEY) console.log("\n--live pendiente: no hay OPENAI_API_KEY. Hay que correrlo antes de prender el motor en producción.");
  if (mocked.pass !== corpus.cases.length || fallback.pass < Math.ceil(corpus.cases.length * 0.85)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
