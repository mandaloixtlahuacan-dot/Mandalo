/**
 * Menú cerrado (George y La Central). El motor nuevo no se califica aquí
 * sin la llave: el replay de las grabaciones viejas no corresponde al
 * prompt nuevo.
 *
 *   npx tsx scripts/check-catalog-orders.ts
 *     pruebas offline, sin OpenAI. Esto es lo que corre `npm run check`.
 *
 *   OPENAI_API_KEY=sk-... npx tsx scripts/check-catalog-orders.ts --live
 *   OPENAI_API_KEY=sk-... OPENAI_ORDER_MODEL=gpt-4.1-mini npx tsx scripts/check-catalog-orders.ts --live
 *   OPENAI_API_KEY=sk-... OPENAI_ORDER_MODEL=gpt-5.5 OPENAI_REASONING_EFFORT=none npx tsx scripts/check-catalog-orders.ts --live fresh60
 *
 *   npx tsx scripts/check-catalog-orders.ts --replay scripts/fixtures/catalog-llm-recordings.live.json
 *
 * --live corre corpus (185), held-out (30), unseen (40), new50 (50) y fresh60 (60).
 * Un argumento extra elige un solo juego: corpus, held-out, unseen, new50, fresh60.
 * Escribe las grabaciones del esquema nuevo en
 * scripts/fixtures/catalog-llm-recordings.live.json
 *
 * OPENAI_ORDER_MODEL: gpt-4.1-mini (default), gpt-4o-mini o gpt-5.5.
 * OPENAI_REASONING_EFFORT: none (default) o low. Solo aplica a gpt-5.
 * CATALOG_ENGINE: vacío = este motor; v1 = el motor anterior; legacy = sin menú cerrado.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkAiOutput, pesosToKg } from "../src/lib/catalogOrder/accept";
import { buildCatalog, catalogEngineMode, runCatalogOrderTurn, type AiOutput, type CartLine, type CatalogModel, type CatalogSnapshot, type RawCatalogRow } from "../src/lib/catalogOrder";
import { buildOrderPrompt, DEFAULT_ORDER_MODEL, orderJsonSchema, parseModelJson } from "../src/lib/catalogOrder/parser";

type ExpectItem = { name: string; qty: number; unit: string; variant?: string };
type CorpusCase = {
  id: string;
  store: "george" | "central";
  category: string;
  turns: string[];
  expect: { items: ExpectItem[]; ask: "none" | "clarify" | "not_available"; ask_contains: string[]; not_available: string[] };
};

process.env.CATALOG_ORDER_QUIET = "1";

const root = resolve(__dirname, "fixtures");
const corpus = JSON.parse(readFileSync(resolve(root, "catalog-order-corpus.json"), "utf8")) as { cases: CorpusCase[] };
const heldout = JSON.parse(readFileSync(resolve(root, "catalog-order-heldout.json"), "utf8")) as { cases: CorpusCase[] };
const unseen = JSON.parse(readFileSync(resolve(root, "catalog-order-unseen.json"), "utf8")) as { cases: CorpusCase[] };
const fresh = JSON.parse(readFileSync(resolve(root, "catalog-order-new50.json"), "utf8")) as { cases: CorpusCase[] };
const fresh60 = JSON.parse(readFileSync(resolve(root, "catalog-order-fresh60.json"), "utf8")) as { cases: CorpusCase[] };
const catalogs = JSON.parse(readFileSync(resolve(root, "catalogs.json"), "utf8")) as {
  tienda_5_george: RawCatalogRow[];
  tienda_6_la_central: RawCatalogRow[];
};

const george = buildCatalog(catalogs.tienda_5_george, "restaurante", "priced");
const central = buildCatalog(catalogs.tienda_6_la_central, "carniceria", "priced");
const sets: Array<[string, CorpusCase[]]> = [
  ["corpus", corpus.cases],
  ["held-out", heldout.cases],
  ["unseen", unseen.cases],
  ["new50", fresh.cases],
  ["fresh60", fresh60.cases],
];

function catalogFor(store: CorpusCase["store"]): CatalogSnapshot {
  return store === "george" ? george : central;
}

function unitOf(unit: string): "pz" | "kg" | "pesos" {
  if (unit === "$" || unit === "pesos") return "pesos";
  if (unit === "kg") return "kg";
  return "pz";
}

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

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

function emptyAi(over: Partial<AiOutput> = {}): AiOutput {
  return { cart: [], question: null, not_on_menu: [], confirmed: false, ...over };
}

function scripted(steps: Array<AiOutput | null>): CatalogModel {
  let index = 0;
  return {
    name: "script",
    async interpret() {
      return steps[index++] ?? null;
    },
  };
}

async function runCase(item: CorpusCase, model: CatalogModel | null): Promise<{ cart: CartLine[]; reply: string }> {
  const catalog = catalogFor(item.store);
  let cart: CartLine[] = [];
  let pending = null;
  let reply = "";
  for (const turn of item.turns) {
    const result = await runCatalogOrderTurn({
      message: turn,
      cart,
      pending,
      history: [],
      catalog,
      awaitingList: reply.includes("¿Están bien estos productos?"),
      model,
    });
    cart = result.cart;
    pending = result.pending;
    reply = result.reply;
  }
  return { cart, reply };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function offline(): Promise<void> {
  const expected = { corpus: 185, "held-out": 30, unseen: 40, new50: 50, fresh60: 60 };
  for (const [label, cases] of sets) {
    assert(cases.length === expected[label as keyof typeof expected], `${label}: se esperaban ${expected[label as keyof typeof expected]} y hay ${cases.length}`);
  }
  assert(DEFAULT_ORDER_MODEL === "gpt-4.1-mini", "el modelo por defecto dejó de ser gpt-4.1-mini");
  assert(catalogEngineMode() === "v2", "sin CATALOG_ENGINE el motor es v2");

  const burger = george.rows.find((row) => row.name === "Hamburguesa de Res Grande");
  const drink = george.rows.find((row) => row.variants.length > 0);
  const pastor = central.rows.find((row) => /pastor/i.test(row.name));
  const wings = george.rows.find((row) => row.unit === "pz" && !row.variants.length);
  assert(burger && drink && pastor && wings && pastor.precio > 0, "faltan filas para las pruebas offline");

  const badId = checkAiOutput(emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] }), george);
  assert(badId.errors.length === 1 && badId.cart.length === 0, "un id fuera del menú se rechaza entero");

  const badQty = checkAiOutput(emptyAi({ cart: [{ product_id: burger.id, qty: 0, unit: "pz", variant: null }] }), george);
  assert(badQty.errors.length === 1, "cantidad cero se rechaza");

  const badUnit = checkAiOutput(emptyAi({ cart: [{ product_id: wings.id, qty: 1, unit: "pesos", variant: null }] }), george);
  assert(badUnit.errors.some((error) => error.includes("no se vende")), "pesos en una pieza se rechaza");

  const pesos = checkAiOutput(emptyAi({ cart: [{ product_id: pastor.id, qty: 150, unit: "pesos", variant: null }] }), central);
  assert(pesos.errors.length === 0 && pesos.cart[0]?.unit === "pesos" && pesos.cart[0]?.qty === 150, "pesos en carne se aceptan");
  assert(Math.abs(pesosToKg(150, pastor.precio) - 150 / pastor.precio) < 0.001, "los pesos se convierten con el precio del menú");

  const flavor = checkAiOutput(emptyAi({ cart: [{ product_id: drink.id, qty: 1, unit: "pz", variant: "Pepsi" }] }), george);
  assert(flavor.cart[0]?.variant === "Pepsi", "el sabor del menú se conserva");
  const noFlavor = checkAiOutput(emptyAi({ cart: [{ product_id: drink.id, qty: 1, unit: "pz", variant: null }] }), george);
  assert(noFlavor.errors.some((error) => error.includes("sabor")), "un refresco sin sabor se rechaza");

  const prompt = buildOrderPrompt({
    catalog: george,
    cart: [{ productId: drink.id, qty: 1, unit: "pz", variant: "Pepsi", notes: null }],
    pending: {
      sourceText: "hamburguesa",
      candidateIds: [burger.id],
      qty: 1,
      unit: "pz",
      variant: null,
      family: burger.family,
      question: "¿Cuál hamburguesa?",
      count: 1,
    },
    history: [{ role: "user", text: "HISTORIAL-SECRETO de otra tienda Diezmillo" }, { role: "assistant", text: "no debe verse" }],
    message: "MENSAJE-DEL-CLIENTE",
    awaitingList: false,
  });
  assert(!prompt.includes("HISTORIAL-SECRETO"), "el prompt incluye historial");
  assert(!prompt.includes("MENSAJE-DEL-CLIENTE"), "el mensaje va duplicado en el sistema");
  assert(!prompt.includes("Diezmillo"), "el menú de George incluye un corte de La Central");
  assert(prompt.includes("¿Cuál hamburguesa?"), "el prompt no trae la pregunta pendiente");
  assert(prompt.includes(`${burger.id} ${burger.name}`), "el prompt no trae el menú de esta tienda");
  assert(prompt.includes(`"product_id":${drink.id}`), "el prompt no trae el carrito");
  const centralPrompt = buildOrderPrompt({
    catalog: central,
    cart: [],
    pending: null,
    history: [],
    message: "un kilo",
  });
  assert(!centralPrompt.includes("Hamburguesa de Res"), "el menú de La Central incluye productos de George");
  const schema = JSON.stringify(orderJsonSchema(george.rows.map((row) => row.id)));
  assert(schema.includes("confirmed") && schema.includes("not_on_menu") && !schema.includes("changes"), "el esquema nuevo no reemplazó al delta");
  assert(parseModelJson({ intent: "order", cart: [], changes: [], unmatched: [], confidence: "high" }) == null, "el JSON viejo se aceptó como carrito");

  const previousEngine = process.env.CATALOG_ENGINE;
  process.env.CATALOG_ENGINE = "v1";
  assert(catalogEngineMode() === "v1", "CATALOG_ENGINE=v1 no se reconoce");
  if (!process.env.OPENAI_API_KEY) {
    const v1 = await runCatalogOrderTurn({
      message: "una coca",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
    });
    assert(v1.fallback === true, "CATALOG_ENGINE=v1 sin llave no usa el respaldo");
  }
  process.env.CATALOG_ENGINE = "legacy";
  assert(catalogEngineMode() === "legacy", "CATALOG_ENGINE=legacy no se reconoce");
  if (previousEngine == null) delete process.env.CATALOG_ENGINE;
  else process.env.CATALOG_ENGINE = previousEngine;
  assert(catalogEngineMode() === "v2", "al quitar CATALOG_ENGINE no vuelve a v2");

  const prior: CartLine[] = [{ productId: burger.id, qty: 1, unit: "pz", variant: null, notes: null }];
  const calls: string[] = [];
  const repairing: CatalogModel = {
    name: "script",
    async interpret(request) {
      calls.push(buildOrderPrompt(request));
      if (calls.length === 1) return emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] });
      return emptyAi({ cart: [{ product_id: burger.id, qty: 2, unit: "pz", variant: null }] });
    },
  };
  return runCatalogOrderTurn({
    message: "mejor dos",
    cart: prior,
    pending: null,
    history: [{ role: "user", text: "HISTORIAL-SECRETO" }],
    catalog: george,
    model: repairing,
  }).then((repaired) => {
    assert(calls.length === 2 && calls[1].includes("no está en el menú"), "un JSON inválido no se reintenta con el error");
    assert(!calls[1].includes("HISTORIAL-SECRETO"), "el reintento manda historial");
    assert(repaired.cart.length === 1 && repaired.cart[0]?.qty === 2 && repaired.fallback === false, "el reintento válido no se quedó");

    const stuck = scripted([
      emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] }),
      emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] }),
    ]);
    return runCatalogOrderTurn({
      message: "algo",
      cart: prior,
      pending: null,
      history: [],
      catalog: george,
      model: stuck,
    });
  }).then((kept) => {
    assert(kept.fallback === false && kept.cart.length === 1 && kept.cart[0]?.qty === 1, "al fallar dos veces no se conservó el carrito");
    assert(kept.reply.includes("palabras sencillas"), "al fallar dos veces no se pidió repetir");

    return runCatalogOrderTurn({
      message: "una coca",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
      model: scripted([null]),
    });
  }).then((backed) => {
    assert(backed.fallback === true, "una falla de la API no usó el lector de respaldo");

    let called = false;
    const nosy: CatalogModel = {
      name: "script",
      async interpret() {
        called = true;
        return emptyAi();
      },
    };
    return runCatalogOrderTurn({
      message: "sí está bien",
      cart: prior,
      pending: null,
      history: [],
      catalog: george,
      awaitingList: true,
      model: nosy,
    }).then((confirmed) => {
      assert(!called && confirmed.confirmedList && confirmed.cart[0]?.qty === 1 && confirmed.reply === "", "un sí limpio movió el carrito o llamó al modelo");

      return runCatalogOrderTurn({
        message: "una pizza",
        cart: [],
        pending: null,
        history: [],
        catalog: george,
        model: scripted([emptyAi({ not_on_menu: ["pizza"] })]),
      });
    });
  }).then((off) => {
    assert(/no lo manejamos/i.test(off.reply) && fold(off.reply).includes("pizza") && off.cart.length === 0, "lo que no está en el menú no se dijo");

    return runCatalogOrderTurn({
      message: "dos hamburguesas",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
      model: scripted([emptyAi({ question: { text: "¿Cuál hamburguesa?", candidate_ids: [burger.id] } })]),
    });
  }).then((asked) => {
    assert(asked.pending?.question === "¿Cuál hamburguesa?" && asked.cart.length === 0 && asked.reply.includes("¿Cuál hamburguesa?"), "la pregunta del modelo no se conservó");

    return runCatalogOrderTurn({
      message: "una de res grande",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
      model: scripted([emptyAi({ cart: [{ product_id: burger.id, qty: 1, unit: "pz", variant: null }] })]),
    });
  }).then((listed) => {
    assert(listed.reply.includes("¿Están bien estos productos?"), "la lista no pide confirmación");
    assert(listed.reply.includes("Si tu pedido está bien, responde sí"), "la lista no pide el sí");
    assert(listed.reply.includes("Solo es un ejemplo, no está en tu pedido"), "el ejemplo de la lista se perdió");

    return runCatalogOrderTurn({
      message: "150 de pastor",
      cart: [],
      pending: null,
      history: [],
      catalog: central,
      model: scripted([emptyAi({ cart: [{ product_id: pastor.id, qty: 150, unit: "pesos", variant: null }] })]),
    });
  }).then((money) => {
    assert(money.reply.includes("$150") && money.reply.includes("aprox"), "los pesos no muestran los kilos aproximados");
    console.log("offline: ok");
  });
}

function printReport(label: string, pass: number, total: number, fails: string[]): void {
  console.log(`\n${label}: ${pass}/${total}`);
  for (const line of fails.slice(0, 40)) console.log(`  ${line}`);
}

async function runSet(label: string, cases: CorpusCase[], modelFor: (item: CorpusCase) => CatalogModel | null): Promise<{ pass: number; total: number }> {
  const fails: string[] = [];
  for (const item of cases) {
    const { cart, reply } = await runCase(item, modelFor(item));
    const reasons = score(item, cart, reply, catalogFor(item.store));
    if (reasons.length) fails.push(`${item.id} ${item.store}/${item.category}: ${reasons.join("; ")}`);
  }
  printReport(label, cases.length - fails.length, cases.length, fails);
  return { pass: cases.length - fails.length, total: cases.length };
}

function isNewRecording(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.cart) && Array.isArray(row.not_on_menu) && typeof row.confirmed === "boolean";
}

async function live(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.log("--live pendiente: no hay OPENAI_API_KEY en este entorno.");
    process.exitCode = 1;
    return;
  }
  const { createOpenAICatalogModel } = await import("../src/lib/catalogOrder/parser");
  const picked = process.argv[3];
  const chosen = sets.filter(([label]) => !picked || picked === label);
  if (!chosen.length) {
    console.log(`--live: juego desconocido «${picked}». Usa corpus, held-out, unseen, new50 o fresh60.`);
    process.exitCode = 1;
    return;
  }
  const recordings: Record<string, Array<AiOutput | null>> = {};
  for (const [label, cases] of chosen) {
    await runSet(label, cases, (item) => {
      const sink: Array<AiOutput | null> = [];
      recordings[item.id] = sink;
      const inner = createOpenAICatalogModel();
      return {
        name: inner.name,
        async interpret(request) {
          const output = await inner.interpret(request);
          sink.push(output);
          return output;
        },
      };
    });
  }
  const out = resolve(root, "catalog-llm-recordings.live.json");
  writeFileSync(out, JSON.stringify(recordings, null, 1));
  console.log(`\ngrabaciones: ${out}`);
}

async function replay(): Promise<void> {
  const file = process.argv[3];
  if (!file) {
    console.log("--replay necesita el archivo de grabaciones del esquema nuevo.");
    process.exitCode = 1;
    return;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    console.log(`--replay: no está ${file}`);
    process.exitCode = 1;
    return;
  }
  const recordings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Array<AiOutput | null>>;
  const sample = Object.values(recordings).flat().find((turn) => turn != null);
  if (sample && !isNewRecording(sample)) {
    console.log("--replay: esas grabaciones son del motor anterior (traen changes/unmatched) y no corresponden a este prompt.");
    process.exitCode = 1;
    return;
  }
  for (const [label, cases] of sets) {
    await runSet(label, cases, (item) => {
      const turns = recordings[item.id] ?? [];
      let index = 0;
      return {
        name: "replay",
        async interpret() {
          return turns[index++] ?? null;
        },
      };
    });
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "--offline";
  if (arg === "--live") {
    await live();
    return;
  }
  if (arg === "--replay") {
    await replay();
    return;
  }
  await offline();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
