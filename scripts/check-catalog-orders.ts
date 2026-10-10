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
 *   OPENAI_API_KEY=sk-... OPENAI_ORDER_MODEL=gpt-5.5 OPENAI_REASONING_EFFORT=low npx tsx scripts/check-catalog-orders.ts --live
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
import { buildCatalog, catalogEngineMode, runCatalogOrderTurn, type AiOutput, type CartLine, type CatalogModel, type CatalogSnapshot, type PendingCatalogAsk, type RawCatalogRow } from "../src/lib/catalogOrder";
import { buildOrderPrompt, DEFAULT_ORDER_MODEL, ORDER_TIMEOUT_MS, orderJsonSchema, parseModelJson } from "../src/lib/catalogOrder/parser";

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
  const noFlavor = checkAiOutput(
    emptyAi({ cart: [{ product_id: drink.id, qty: 1, unit: "pz", variant: null }, { product_id: burger.id, qty: 1, unit: "pz", variant: null }] }),
    george,
    { message: "una hamburguesa y un refresco" },
  );
  assert(noFlavor.cart.some((line) => line.productId === burger.id), "un refresco sin sabor se llevó la hamburguesa");
  assert(!noFlavor.cart.some((line) => line.productId === drink.id), "el refresco sin sabor se quedó en el carrito");
  assert(noFlavor.question?.candidateIds.includes(drink.id) === true, "un refresco sin sabor no pregunta el sabor");
  assert(ORDER_TIMEOUT_MS === 8000, "el tiempo de espera del modelo no es 8 s");

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
  assert(prompt.includes(`Era: "hamburguesa", qty 1 pz`), "el prompt no trae las palabras ni la cantidad de la pregunta");
  assert(prompt.includes(`Opciones: ${burger.id} ${burger.name}`), "el prompt no trae las opciones de la pregunta");
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
  assert(schema.includes("confirmed") && schema.includes("not_on_menu") && schema.includes("source_text") && schema.includes("removed_ids"), "el esquema no trae la pregunta con contexto");
  assert(!schema.includes('"changes"') && !schema.includes("unmatched"), "el esquema nuevo no reemplazó al delta");
  assert(parseModelJson({ intent: "order", cart: [], changes: [], unmatched: [], confidence: "high" }) == null, "el JSON viejo se aceptó como carrito");

  const byName = (catalog: CatalogSnapshot, name: string) => {
    const row = catalog.rows.find((item) => item.name === name);
    if (!row) throw new Error(`falta ${name}`);
    return row;
  };
  const arrachera = byName(central, "Arrachera Marinada");
  const diezmillo = byName(central, "Diezmillo");
  const carbon = byName(central, "Carbón fino");
  const bistecRes = byName(central, "Bistec de res");
  const bistecPuerco = byName(central, "Bistec de puerco");
  const bistecPuercoM = byName(central, "Bistec de puerco marinado");
  const wings5 = byName(george, "Alitas 5 piezas");
  const wings15 = byName(george, "Alitas 15 piezas");
  const wings20 = byName(george, "Alitas 20 piezas");
  const dedos = byName(george, "Dedos de Queso 6 piezas");
  const pizzadogo = byName(george, "Pizzadogo");
  const tortaMex = byName(george, "Torta Mexicana");
  const tortaHaw = byName(george, "Torta Hawaiana");
  const cubanaG = byName(george, "Hamburguesa Cubana Grande");
  const cubanaC = byName(george, "Hamburguesa Cubana Chica");
  const hawG = byName(george, "Hamburguesa Hawaiana Grande");
  const hawC = byName(george, "Hamburguesa Hawaiana Chica");
  const dogoCubano = byName(george, "Dogo Cubano");
  const polloC = byName(george, "Hamburguesa de Pollo Chica");
  const polloG = byName(george, "Hamburguesa de Pollo Grande");
  const salsaBbq = byName(central, "Salsa BBQ");
  const salsaHot = byName(central, "Salsa Hot Wings");
  const kg = (id: number, qty: number): CartLine => ({ productId: id, qty, unit: "kg", variant: null, notes: null });
  const pz = (id: number, qty: number, variant: string | null = null): CartLine => ({ productId: id, qty, unit: "pz", variant, notes: null });

  const keptArrachera = checkAiOutput(
    emptyAi({ cart: [{ product_id: diezmillo.id, qty: 1, unit: "kg", variant: null }] }),
    central,
    { prior: [kg(arrachera.id, 1)], message: "otro de diezmillo" },
  );
  assert(keptArrachera.cart.some((line) => line.productId === arrachera.id), "«otro de diezmillo» se llevó la arrachera");
  assert(keptArrachera.cart.some((line) => line.productId === diezmillo.id && line.qty === 1), "«otro de diezmillo» no sumó el diezmillo");

  const keptDiezmillo = checkAiOutput(
    emptyAi({ cart: [{ product_id: carbon.id, qty: 1, unit: "pz", variant: null }] }),
    central,
    { prior: [kg(diezmillo.id, 1), pz(carbon.id, 1)], message: "nomás un carbón" },
  );
  assert(keptDiezmillo.cart.some((line) => line.productId === diezmillo.id), "«nomás un carbón» borró el diezmillo");

  const pack15 = checkAiOutput(
    emptyAi({ cart: [{ product_id: wings5.id, qty: 3, unit: "pz", variant: null }] }),
    george,
    { message: "quince alitas" },
  );
  const wings10 = byName(george, "Alitas 10 piezas");
  const tenWings = checkAiOutput(
    emptyAi({ cart: [{ product_id: wings5.id, qty: 2, unit: "pz", variant: null }] }),
    george,
    { message: "10 alitas" },
  );
  assert(tenWings.cart.length === 1 && tenWings.cart[0]?.productId === wings10.id && tenWings.cart[0]?.qty === 1, "«10 alitas» se partió en órdenes de 5");
  assert(pack15.cart.length === 1 && pack15.cart[0]?.productId === wings15.id && pack15.cart[0]?.qty === 1, "«quince alitas» no eligió la orden de 15");
  const packTimes = checkAiOutput(
    emptyAi({ cart: [{ product_id: wings15.id, qty: 15, unit: "pz", variant: null }] }),
    george,
    { message: "quince alitas" },
  );
  assert(packTimes.cart[0]?.productId === wings15.id && packTimes.cart[0]?.qty === 1, "«quince alitas» se multiplicó por 15");
  const pack20 = checkAiOutput(
    emptyAi({ cart: [{ product_id: wings5.id, qty: 1.5, unit: "pz", variant: null }] }),
    george,
    { message: "que sean de 20 piezas" },
  );
  assert(pack20.cart[0]?.productId === wings20.id && pack20.cart[0]?.qty === 1, "«de 20 piezas» no eligió la orden de 20");
  const pack12 = checkAiOutput(
    emptyAi({ cart: [{ product_id: wings5.id, qty: 12, unit: "pz", variant: null }] }),
    george,
    { message: "alitas de 12" },
  );
  assert(!pack12.cart.some((line) => line.productId === wings5.id) && pack12.question != null, "«alitas de 12» adivinó un paquete");
  const halfDozen = checkAiOutput(
    emptyAi({ cart: [{ product_id: dedos.id, qty: 0.5, unit: "pz", variant: null }] }),
    george,
    { message: "media docena de dedos" },
  );
  assert(halfDozen.cart[0]?.productId === dedos.id && halfDozen.cart[0]?.qty === 1, "«media docena de dedos» quedó en 0.5");
  const fraction = checkAiOutput(emptyAi({ cart: [{ product_id: burger.id, qty: 1.5, unit: "pz", variant: null }] }), george, { message: "una y media" });
  assert(fraction.cart.length === 0 && fraction.errors.some((error) => error.includes("entero")), "una cantidad fraccionaria de piezas pasó");

  const pizzaDogo = checkAiOutput(emptyAi({ not_on_menu: ["pizzadogo"] }), george, { message: "Un pizzadogo" });
  assert(pizzaDogo.cart[0]?.productId === pizzadogo.id && pizzaDogo.notOnMenu.length === 0, "pizzadogo se trató como fuera del menú");
  const manzanita = checkAiOutput(emptyAi({ not_on_menu: ["manzanita"] }), george, { message: "una manzanita" });
  assert(manzanita.cart[0]?.productId === drink.id && manzanita.cart[0]?.variant === "Manzana" && manzanita.notOnMenu.length === 0, "manzanita no cayó en el sabor Manzana");
  const barePizza = checkAiOutput(emptyAi({ not_on_menu: ["pizza"] }), george, { message: "una pizza" });
  assert(barePizza.notOnMenu.includes("pizza") && barePizza.cart.length === 0, "«pizza» se convirtió en pizzadogo");

  const hawaiana = checkAiOutput(
    emptyAi({ cart: [{ product_id: tortaMex.id, qty: 1, unit: "pz", variant: "hawaiana" }] }),
    george,
    { prior: [pz(tortaMex.id, 1)], message: "mejor que sean hawaianas" },
  );
  assert(hawaiana.cart.some((line) => line.productId === tortaHaw.id), "«hawaianas» se descartó");
  assert(!hawaiana.cart.some((line) => line.productId === tortaMex.id), "la torta mexicana se quedó junto con la hawaiana");

  const sizeKept = checkAiOutput(
    emptyAi({ cart: [{ product_id: hawC.id, qty: 1, unit: "pz", variant: null }] }),
    george,
    { prior: [pz(cubanaG.id, 1)], message: "no es cubana, es hawaiana" },
  );
  assert(sizeKept.cart.some((line) => line.productId === hawG.id && line.qty === 1), "el cambio de hawaiana perdió el tamaño grande");
  assert(!sizeKept.cart.some((line) => line.productId === cubanaG.id || line.productId === cubanaC.id), "la cubana se quedó después del cambio");

  const pendingDogos: PendingCatalogAsk = {
    sourceText: "mándame un dogo",
    candidateIds: [dogoCubano.id, byName(george, "Dogo Hawaiano").id, byName(george, "Dogo de Camarón").id],
    qty: 1,
    unit: "pz",
    variant: null,
    family: "dogo",
    question: "¿Cuál dogo?",
    count: 1,
  };
  const cubano = checkAiOutput(
    emptyAi({ cart: [{ product_id: cubanaC.id, qty: 1, unit: "pz", variant: null }] }),
    george,
    { message: "el cubano", pending: pendingDogos },
  );
  assert(cubano.cart.some((line) => line.productId === dogoCubano.id), "«el cubano» de un dogo se volvió hamburguesa");
  assert(!cubano.cart.some((line) => line.productId === cubanaC.id), "la hamburguesa cubana se quedó en la respuesta del dogo");

  const pendingPollo: PendingCatalogAsk = {
    sourceText: "cuatro hamburguesas de pollo",
    candidateIds: [polloC.id, polloG.id, burger.id, byName(george, "Hamburguesa de Res Chica").id],
    qty: 4,
    unit: "pz",
    variant: null,
    family: null,
    question: "¿Chica o grande?",
    count: 1,
  };
  const sizes = checkAiOutput(
    emptyAi({ cart: [{ product_id: burger.id, qty: 3, unit: "pz", variant: null }] }),
    george,
    { message: "tres grandes y una chica", pending: pendingPollo },
  );
  assert(sizes.cart.some((line) => line.productId === polloG.id && line.qty === 3), "«tres grandes» no se quedó en pollo");
  assert(sizes.cart.some((line) => line.productId === polloC.id && line.qty === 1), "«una chica» no se quedó en pollo");

  const pendingBistec: PendingCatalogAsk = {
    sourceText: "dos kilitos de bistec",
    candidateIds: [bistecRes.id, bistecPuerco.id, bistecPuercoM.id],
    qty: 2,
    unit: "kg",
    variant: null,
    family: null,
    question: "¿El bistec de res o de puerco?",
    count: 1,
  };
  const twoKilos = checkAiOutput(
    emptyAi({ cart: [{ product_id: bistecPuercoM.id, qty: 1, unit: "kg", variant: null }] }),
    central,
    { message: "del de puerco, el marinado", pending: pendingBistec },
  );
  assert(twoKilos.cart.some((line) => line.productId === bistecPuercoM.id && line.qty === 2), "la respuesta del bistec perdió los 2 kg");
  const pendingHaw: PendingCatalogAsk = {
    sourceText: "dos hamburguesas hawaianas",
    candidateIds: [hawC.id, hawG.id, burger.id, polloG.id],
    qty: 2,
    unit: "pz",
    variant: null,
    family: null,
    question: "¿Chica o grande?",
    count: 1,
  };
  const grandes = checkAiOutput(
    emptyAi({
      cart: [
        { product_id: burger.id, qty: 1, unit: "pz", variant: null },
        { product_id: polloG.id, qty: 1, unit: "pz", variant: null },
      ],
    }),
    george,
    { message: "grandes las dos", pending: pendingHaw },
  );
  assert(grandes.cart.length === 1 && grandes.cart[0]?.productId === hawG.id && grandes.cart[0]?.qty === 2, "«grandes las dos» no se quedó en la hawaiana");
  const deRes = checkAiOutput(emptyAi(), central, {
    message: "de res",
    pending: { ...pendingBistec, qty: 1, sourceText: "un kilo de bistec" },
  });
  assert(deRes.cart.some((line) => line.productId === bistecRes.id && line.qty === 1 && line.unit === "kg"), "«de res» dejó el carrito vacío");

  const guessed = checkAiOutput(
    emptyAi({
      cart: [{ product_id: polloC.id, qty: 1, unit: "pz", variant: null }],
      question: { text: "¿Chica o grande?", candidate_ids: [polloC.id, polloG.id] },
    }),
    george,
    { message: "una hamburguesa de pollo" },
  );
  assert(guessed.cart.length === 0 && guessed.question != null, "la línea adivinada se quedó mientras se preguntaba");

  const wholeMenu = checkAiOutput(
    emptyAi({ cart: central.rows.slice(0, 10).map((row) => ({ product_id: row.id, qty: 1, unit: row.unit, variant: null })) }),
    central,
    {
      message: "una de cada una",
      pending: {
        sourceText: "dos salsas",
        candidateIds: [salsaBbq.id, salsaHot.id],
        qty: 2,
        unit: "pz",
        variant: null,
        family: null,
        question: "¿Cuál salsa?",
        count: 1,
      },
    },
  );
  assert(wholeMenu.cart.length === 2 && wholeMenu.cart.every((line) => line.productId === salsaBbq.id || line.productId === salsaHot.id), "«una de cada una» agregó el menú completo");

  const offAndValid = checkAiOutput(
    emptyAi({
      cart: [{ product_id: bistecPuerco.id, qty: 1, unit: "kg", variant: null }],
      question: { text: "¿El pollo es de esta tienda?", candidate_ids: [] },
      not_on_menu: ["pollo entero"],
    }),
    central,
    { message: "un pollo entero y un kilo de bistec de puerco" },
  );
  assert(offAndValid.cart.some((line) => line.productId === bistecPuerco.id), "el pollo entero se llevó el bistec");
  assert(offAndValid.notOnMenu.includes("pollo entero") && offAndValid.question == null, "el pollo entero se volvió pregunta");

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
    assert(!kept.reply.includes("palabras sencillas"), "una línea inválida borró el carrito que sí estaba");
    const nothing = scripted([
      emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] }),
      emptyAi({ cart: [{ product_id: 999999, qty: 1, unit: "pz", variant: null }] }),
    ]);
    return runCatalogOrderTurn({
      message: "algo",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
      model: nothing,
    }).then((repeated) => {
      assert(repeated.reply.includes("palabras sencillas"), "sin nada válido no se pidió repetir");
      return runCatalogOrderTurn({
        message: "una coca",
        cart: [],
        pending: null,
        history: [],
        catalog: george,
        model: scripted([null]),
      });
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

    return runCatalogOrderTurn({
      message: "ya sería todo",
      cart: prior,
      pending: null,
      history: [],
      catalog: george,
      awaitingList: true,
      model: scripted([emptyAi({ cart: [{ product_id: burger.id, qty: 1, unit: "pz", variant: null }], confirmed: true })]),
    });
  }).then((done) => {
    assert(done.confirmedList && done.reply === "" && done.cart.length === 1, "«ya sería todo» no confirmó el mismo carrito");

    return runCatalogOrderTurn({
      message: "grandes las dos",
      cart: [],
      pending: null,
      history: [],
      catalog: george,
      awaitingList: true,
      model: scripted([emptyAi({ confirmed: true })]),
    });
  }).then((emptyConfirm) => {
    assert(!emptyConfirm.confirmedList, "un carrito vacío se confirmó");
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
