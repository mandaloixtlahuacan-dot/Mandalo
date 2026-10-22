/**
 * Peke's: una pregunta por mensaje, en el orden del cliente.
 * Replay de la tarde del 17 oct 2026, paquete de aguas, chile/salsa
 * y un pedido de 4 productos. Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-pekes-one-question.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { formatAbarrotesStoreAck, formatCatalogMenuCaption, type UxStore } from "../src/lib/customerUx";
import { confirmsShownProductList, isAffirmativeChatter, isCancelIntent } from "../src/lib/messages";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { DEFAULT_ORDER_AGENT_ESCALATION_MODEL, DEFAULT_ORDER_AGENT_MODEL } from "../src/lib/orderAgent/env";
import { itemsFromAgentLines, runOrderAgentTurn, type AgentLine, type AgentModel, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
import { orderClauses, sharesProductType } from "../src/lib/orderAgent/match";
import { ADDRESS_ASK_MESSAGE } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import { createSimAgentModel } from "./sim/agent-model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Fixture = {
  id: number;
  nombre_producto: string;
  precio?: number | null;
  disponible?: boolean;
  categoria?: string | null;
  marca?: string | null;
  presentacion?: string | null;
  alias?: string[] | null;
};

function loadCatalog(): AgentProduct[] {
  const raw = gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz"));
  const rows = JSON.parse(raw.toString("utf8")) as Fixture[];
  assert(rows.length === 12865, `el catálogo completo trae ${rows.length}`);
  return rows
    .filter((row) => row.disponible !== false)
    .map((row) => ({
      id: row.id,
      name: row.nombre_producto,
      price: row.precio ?? null,
      available: true,
      unit: "pz" as const,
      variants: [],
      brand: row.marca ?? null,
      presentation: row.presentacion ?? null,
      alias: row.alias ?? [],
      category: row.categoria ?? null,
    }));
}

const products = loadCatalog();
const store: AgentStore = {
  id: 7,
  name: "Mini Super Peke's",
  category: "abarrotes",
  catalogMode: "list",
  hasProductList: true,
};

function questionCount(reply: string): number {
  return (reply.match(/¿/g) ?? []).length;
}

function assertOneQuestion(reply: string, label: string): void {
  const count = questionCount(reply);
  assert(count <= 1, `${label} juntó ${count} preguntas:\n${reply}`);
}

async function turn(message: string, cart: AgentLine[], pending: AgentPending | null, history: Array<{ role: "user" | "assistant"; text: string }> = [], awaitingList = false) {
  const result = await runOrderAgentTurn({
    message,
    cart,
    pending,
    history,
    awaitingList,
    store,
    products: [],
    search: async (query) => searchAgentProducts(products, query, 24),
    model: createSimAgentModel(message),
    escalationModel: null,
    logEvent: () => {},
  });
  return result;
}

function optionNumber(reply: string, name: RegExp): string {
  for (const line of reply.split("\n")) {
    const match = line.match(/^(\d+)\.\s/);
    if (match && name.test(line)) return match[1];
  }
  throw new Error(`no está ${name} en:\n${reply}`);
}

function lineOf(lineId: string, name: string, productId: number | null, qty = 1): AgentLine {
  return {
    lineId,
    productId,
    freeText: null,
    name,
    qty,
    unit: "pz",
    variant: null,
    note: null,
    unitPrice: null,
    brand: null,
    presentation: null,
  };
}

function optionLines(reply: string): string[] {
  return reply.split("\n").filter((row) => /^\d+\.\s/.test(row));
}

function progressTotal(reply: string): number | null {
  const match = reply.match(/\*Producto \d+ de (\d+)\*/);
  return match ? Number(match[1]) : null;
}

function locationAsk(cart: AgentLine[], userMessage: string): string {
  const items = itemsFromAgentLines(cart);
  const confirm = validateCaptureForConfirmation({
    snapshot: {
      businessId: store.id,
      businessName: store.name,
      storeKind: "abarrotes",
      items,
      flags: { productosConfirmados: true, awaitingProductConfirm: false, agentCart: true },
    },
    items,
    quoteStore: false,
    userMessage,
    storeKind: "abarrotes",
  });
  return confirm.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "";
}

const samples: string[] = [];
function sample(title: string, body: string): void {
  samples.push(`\n===== ${title} =====\n${body}`);
}

async function main(): Promise<void> {
  assert(DEFAULT_ORDER_AGENT_MODEL === "gpt-4o-mini", "el agente no debe cambiar el modelo de arranque");
  assert(DEFAULT_ORDER_AGENT_ESCALATION_MODEL === "gpt-4.1-mini", "el salto del agente sigue en gpt-4.1-mini");

  const afternoon = "Quiero un paquete de aguas, member, Mark una coca de 2 l y medio un chile Costa brava";
  const clauses = orderClauses(afternoon);
  assert(clauses.length === 3, `member Mark se partió: ${clauses.join(" | ")}`);
  assert(clauses.some((clause) => /member mark/i.test(clause) && /agua/i.test(clause)), "la marca no se pegó al agua");
  assert(clauses.some((clause) => /2 l y medio/i.test(clause)), "2 l y medio se partió");
  assert(clauses.some((clause) => /costa brava/i.test(clause)), "Costa Brava se partió");

  const yesTalk = "Sí, qué tal lo realiza que sigues con el pedido";
  assert(isAffirmativeChatter(yesTalk), "el sí con charla no se reconoció");
  assert(confirmsShownProductList(yesTalk), "el sí con charla no confirma la lista");
  const agua = products.find((product) => product.id === 3644);
  const mayo = products.find((product) => product.id === 3662);
  assert(agua && sharesProductType("OK, mira la Agua si él no es me refiero a la Agua marca member Mark", agua), "3644 no comparte tipo con la aclaración");
  assert(mayo && !sharesProductType("la Agua marca member Mark", mayo), "la mayonesa Member's Mark pasó como agua");

  const first = await turn(afternoon, [], null);
  assertOneQuestion(first.reply, "tarde 3:38");
  assert(first.cart.some((line) => line.productId === 6392), `la coca de 2.5 no se anotó: ${first.cart.map((line) => line.name).join(" | ")}`);
  assert(!/de member,/i.test(first.reply) && !/de mark,/i.test(first.reply), "member y Mark salieron como dos preguntas");
  assert(/costa brava|salsa costa/i.test(first.reply), "el chile Costa Brava no ofreció la salsa");
  assert(/no contamos/i.test(first.reply) === false, "el chile Costa Brava dijo que no hay");
  assert(!first.reply.includes("¿Están bien estos productos?"), "con una duda abierta ya pidió confirmar");
  sample("TARDE — mensaje 1 (chile)", first.reply);

  const clarify = "OK, mira la Agua si él no es me refiero a la Agua marca member Mark";
  const second = await turn(clarify, first.cart, first.pending, [
    { role: "user", text: afternoon },
    { role: "assistant", text: first.reply },
  ]);
  assertOneQuestion(second.reply, "tarde 4:28");
  assert(second.reply.includes("Agua Members Mark 1 Lt"), "no ofreció el agua Members Mark de 1 Lt");
  assert(!/mayonesa/i.test(second.reply), "la aclaración de agua ofreció mayonesa");
  assert(!second.cart.some((line) => /agua/i.test(line.name) && /45pz/i.test(line.name)), "el paquete de 45 se quedó después de la aclaración");
  assert(second.pending?.queue?.some((item) => /costa|brava|chile/i.test(`${item.query} ${item.question}`)), "el chile no esperó en la cola");
  sample("TARDE — aclaración del agua", second.reply);

  const waterPick = optionNumber(second.reply, /Agua Members Mark 1 Lt/);
  const third = await turn(waterPick, second.cart, second.pending);
  assertOneQuestion(third.reply, "elige agua");
  assert(third.cart.some((line) => line.productId === 3644), "no anotó Agua Members Mark 1 Lt");
  assert(/costa brava|salsa costa/i.test(third.reply), "después del agua no siguió el chile");
  sample("TARDE — elige 1 Lt, sigue el chile", third.reply);

  const removed = await turn("quita la coca", third.cart, third.pending);
  assertOneQuestion(removed.reply, "quita en medio");
  assert(!removed.cart.some((line) => /coca/i.test(line.name)), "no quitó la coca");
  assert(/costa brava|salsa costa/i.test(removed.reply), "al quitar no siguió con el chile");
  const putBack = await turn("agrega una Coca Cola 2.5 Lt", removed.cart, removed.pending);
  assertOneQuestion(putBack.reply, "agrega en medio");
  assert(putBack.cart.some((line) => line.productId === 6392), "no volvió a anotar la coca de 2.5");
  assert(/costa brava|salsa costa/i.test(putBack.reply), "al agregar no siguió con el chile");

  const salsaPick = optionNumber(putBack.reply, /Salsa Costa Brava 370gr/);
  const fourth = await turn(salsaPick, putBack.cart, putBack.pending);
  assertOneQuestion(fourth.reply, "cierra el chile");
  assert(fourth.reply.includes("¿Están bien estos productos?"), "al terminar las dudas no mostró el carrito");
  assert(!fourth.reply.includes("Envío: $15") && !fourth.reply.includes("servicio $10"), "la lista de productos no cobra todavía");
  assert(fourth.cart.some((line) => /Salsa Costa Brava 370gr/i.test(line.name)), "no anotó la salsa");
  assert(fourth.cart.some((line) => line.productId === 6392 && line.qty === 1), "la coca de 2.5 no quedó en 1");
  sample("TARDE — carrito", fourth.reply);

  const confirmed = await turn(yesTalk, fourth.cart, fourth.pending, [
    { role: "assistant", text: fourth.reply },
  ], true);
  assert(confirmed.confirmedList === true, "el sí con charla no avanzó");
  assert(confirmed.reply === "", "el sí volvió a armar un mensaje de productos");
  assert(confirmed.pending == null, "el sí dejó una pregunta abierta");
  const ask = locationAsk(confirmed.cart, yesTalk);
  assert(ask === ADDRESS_ASK_MESSAGE, `el sí no pidió la ubicación:\n${ask}`);
  sample("TARDE — ubicación", ask);

  const pack = await turn("un paquete de aguas", [], null);
  assertOneQuestion(pack.reply, "paquete de aguas");
  assert(pack.cart.length === 0, `un paquete de aguas se anotó solo: ${pack.cart.map((line) => line.name).join(" | ")}`);
  assert(/1\. \*/.test(pack.reply) && /2\. \*/.test(pack.reply), "un paquete de aguas no dio opciones");
  assert(/ciel|kirkland|bonafont/i.test(pack.reply), "las opciones de agua no salieron");
  assert(
    pack.reply.includes("*Si arriba no salió lo que buscas, responde QUITAR para sacarlo de la lista o escríbelo de otra forma.*"),
    `el paquete de aguas no cerró con QUITAR:\n${pack.reply}`,
  );
  sample("PAQUETE DE AGUAS", pack.reply);

  const four = "Coca Cola 2.5 Lt, sanitas, kombucha y jabon zote";
  let state = await turn(four, [], null);
  const fourLog: string[] = [`Cliente: ${four}`, "", state.reply];
  const progressTotals: number[] = [];
  const noteProgress = (reply: string) => {
    const total = progressTotal(reply);
    if (total != null) progressTotals.push(total);
  };
  noteProgress(state.reply);
  assertOneQuestion(state.reply, "4 productos, inicio");
  assert(state.cart.some((line) => line.productId === 6392), "la Coca 2.5 exacta no se anotó");
  assert(/sanitas/i.test(state.reply), "el primer pendiente no fue sanitas");
  assert(!/zote|kombucha/i.test(state.reply), "el primer mensaje juntó los otros productos");
  assert(/Producto 2 de 4/.test(state.reply), `no salió el progreso:\n${state.reply}`);
  for (let step = 0; step < 6 && state.pending; step += 1) {
    const reply = state.reply;
    let answer = "1";
    if (/deseas quitarlo de la lista/i.test(reply)) {
      assert(/no contamos con kombucha/i.test(reply), `el faltante no nombró kombucha:\n${reply}`);
      answer = "sí";
    } else if (/sanitas/i.test(reply)) {
      answer = optionNumber(reply, /Sanitas 100 Toallas/);
    } else if (/zote/i.test(reply)) {
      answer = optionNumber(reply, /Zote/);
    }
    fourLog.push("", `Cliente: ${answer}`, "", "");
    state = await turn(answer, state.cart, state.pending);
    fourLog.push(state.reply);
    noteProgress(state.reply);
    assertOneQuestion(state.reply, `4 productos, paso ${step + 1}`);
  }
  for (let index = 1; index < progressTotals.length; index += 1) {
    assert(progressTotals[index] >= progressTotals[index - 1], `el total del progreso bajó de ${progressTotals[index - 1]} a ${progressTotals[index]}`);
  }
  assert(!state.pending, "el pedido de 4 productos no cerró las dudas");
  assert(state.reply.includes("¿Están bien estos productos?"), "el pedido de 4 no pidió confirmación");
  assert(state.cart.some((line) => /Sanitas 100 Toallas/i.test(line.name)), "no anotó Sanitas 100 Toallas");
  assert(state.cart.some((line) => /zote/i.test(line.name)), "no anotó el Zote");
  assert(!state.cart.some((line) => /kombucha/i.test(line.name)), "anotó la kombucha");
  const fourYes = await turn("sí", state.cart, null, [{ role: "assistant", text: state.reply }], true);
  assert(fourYes.confirmedList === true, "el sí del pedido de 4 no confirmó");
  const fourAsk = locationAsk(fourYes.cart, "sí");
  assert(fourAsk === ADDRESS_ASK_MESSAGE, "el pedido de 4 no pidió la ubicación");
  fourLog.push("", "Cliente: sí", "", fourAsk);
  sample("PEDIDO DE 4", fourLog.join("\n"));

  assert(isCancelIntent("cansela"), "cansela no cancela");
  assert(isCancelIntent("cánsela"), "cánsela no cancela");
  assert(isCancelIntent("cancelo"), "cancelo no cancela");
  assert(isCancelIntent("candela"), "candela suelta no cancela");
  assert(isCancelIntent("borrar todo"), "borrar todo no cancela");
  assert(isCancelIntent("reiniciar"), "reiniciar no cancela");
  assert(!isCancelIntent("canela en polvo"), "canela en polvo se tomó como cancelar");
  assert(!isCancelIntent("quiero canela"), "quiero canela se tomó como cancelar");
  assert(!isCancelIntent("candela de chocolate"), "candela de chocolate se tomó como cancelar");
  const cansela = await turn("cansela", [], null);
  assert(/cancelar el pedido/i.test(cansela.reply), `cansela no preguntó si cancela:\n${cansela.reply}`);
  const canela = await turn("canela en polvo", [], null);
  assert(!/cancelar el pedido/i.test(canela.reply), `canela en polvo canceló:\n${canela.reply}`);
  assert(/canela/i.test(canela.reply), `canela en polvo no se entendió:\n${canela.reply}`);

  const birotes = await turn("Tienes birotes ?", [], null);
  assert(/bolillo/i.test(birotes.reply), `birotes no ofreció bolillo:\n${birotes.reply}`);
  assert(!/tienes birotes/i.test(birotes.reply), `birotes repitió el texto crudo:\n${birotes.reply}`);
  assert(!/no contamos con tienes/i.test(birotes.reply), `birotes dijo que no hay «tienes»:\n${birotes.reply}`);
  sample("BIROTES", birotes.reply);
  const borrar = await turn("Borrar todo", [lineOf("l1", "Coca Cola 2.5 Lt", 6392)], null);
  assert(/cancelar el pedido/i.test(borrar.reply), `borrar todo no preguntó si cancela:\n${borrar.reply}`);
  assert(!/no contamos/i.test(borrar.reply), `borrar todo dijo que no hay:\n${borrar.reply}`);

  const shampoo = await turn("shampoo medicasp", [], null);
  assert(/no encontr[eé]|no contamos con shampoo medicasp/i.test(shampoo.reply), `medicasp no dijo que no está:\n${shampoo.reply}`);
  assert(!/huggies/i.test(shampoo.reply), `medicasp ofreció Huggies:\n${shampoo.reply}`);
  sample("MEDICASP", shampoo.reply);

  const pasta = await turn("2 pasta espagueti", [], null);
  assert(!/colgate/i.test(pasta.reply), `pasta ofreció Colgate:\n${pasta.reply}`);
  assert(/spagueti|spaghetti/i.test(pasta.reply) && !/no contamos con pasta espagueti/i.test(pasta.reply), `pasta no ofreció el espagueti:\n${pasta.reply}`);
  const pastaLines = pasta.cart.filter((item) => /fusil|spaghetti|espagueti|spagueti/i.test(item.name));
  assert(pastaLines.length <= 1, `la pasta se duplicó: ${pastaLines.map((item) => `${item.qty} ${item.name}`).join(" | ")}`);
  sample("PASTA", pasta.reply);

  const tortillas = await turn("tortillas tía rosa", [], null);
  assert(/tortill/i.test(tortillas.reply), `tortillas no ofreció tortillas:\n${tortillas.reply}`);
  assert(!/bolo/i.test(tortillas.reply), `tortillas ofreció bolo:\n${tortillas.reply}`);
  assert(!/concha/i.test(tortillas.reply), `tortillas ofreció conchas:\n${tortillas.reply}`);
  for (const row of optionLines(tortillas.reply)) {
    assert(!/bolo/i.test(row), `tortillas ofreció bolo:\n${row}`);
    assert(/tortill/i.test(row), `tortillas ofreció algo que no es tortilla:\n${row}`);
  }
  sample("TORTILLAS", tortillas.reply);

  const lecheCarton = await turn("3 litros de leche Lala de cartón", [], null);
  const lalaLines = lecheCarton.cart.filter((item) => /lala/i.test(item.name) && /leche/i.test(item.name));
  assert(lalaLines.length <= 1, `la leche Lala se duplicó: ${lalaLines.map((item) => `${item.qty} ${item.name}`).join(" | ")}`);
  if (lalaLines.length) {
    assert(!/leche lala/i.test(lecheCarton.pending?.query ?? ""), `la leche ya anotada se volvió a preguntar:\n${lecheCarton.pending?.question ?? ""}`);
  }
  sample("LECHE LALA CARTÓN", lecheCarton.reply);

  const takis = await turn("takis fuego", [], null);
  assert(takis.cart.filter((item) => /takis/i.test(item.name) && /fuego/i.test(item.name)).length <= 1, "Takis Fuego quedó en más de una línea");
  const air = await turn("2 air wick", [], null);
  assert(air.cart.filter((item) => /air wick|airwick/i.test(item.name)).length <= 1, "Air Wick quedó en más de una línea");
  sample("TAKIS", takis.reply);
  sample("AIR WICK", air.reply);

  const tres = [
    lineOf("l1", "Leche Lala Entera 1 Lt", 4933),
    lineOf("l2", "Bolillo", 324),
    lineOf("l3", "Takis Fuego", 11362),
  ];
  const cual = [
    "❓ *¿Cuál quieres quitar?*",
    "",
    "1. *1 Leche Lala Entera 1 Lt*",
    "2. *1 Bolillo*",
    "3. *1 Takis Fuego*",
    "",
    "_Responde con el número._",
  ].join("\n");
  const quitaDos = await turn("2", tres, {
    question: cual,
    candidateIds: [],
    qty: null,
    unit: null,
    axis: null,
    query: "quitar",
  });
  assert(!quitaDos.cart.some((item) => /bolillo/i.test(item.name)), "el número 2 no quitó el bolillo");
  assert(quitaDos.cart.length === 2, `quitar el 2 dejó ${quitaDos.cart.length} líneas`);
  assert(quitaDos.cart.some((item) => /leche/i.test(item.name)) && quitaDos.cart.some((item) => /takis/i.test(item.name)), "el 2 quitó otra línea");

  for (const phrase of ["quítalo", "sácalo", "no lo quiero"]) {
    const gone = await turn(phrase, [lineOf("l1", "Takis Fuego", 11362)], null);
    assert(gone.cart.length === 0, `${phrase} no vació la única línea`);
  }
  const sinBolillo = await turn("no quiero bolillo", tres, null);
  assert(!sinBolillo.cart.some((item) => /bolillo/i.test(item.name)), "no quiero bolillo lo dejó");
  assert(sinBolillo.cart.length === 2, "no quiero bolillo quitó de más");

  const solo = await turn("solo leche y bolillo", tres, null);
  assert(solo.cart.some((item) => /leche/i.test(item.name)) && solo.cart.some((item) => /bolillo/i.test(item.name)), "solo leche y bolillo no conservó las dos");
  assert(!solo.cart.some((item) => /takis/i.test(item.name)), "solo leche y bolillo dejó los Takis");
  assert(solo.reply.includes("¿Están bien estos productos?"), "solo leche y bolillo no rehízo la lista");

  const ninguno = await turn("ninguno", [lineOf("l1", "Bolillo", 324)], {
    question: "❓ *De Takis Fuego, ¿cuál de estos?*\n\n1. *Takis Fuego*",
    candidateIds: [11362],
    qty: 1,
    unit: "pz",
    axis: "size",
    query: "takis fuego",
  });
  assert(ninguno.pending == null, "ninguno dejó la pregunta de Takis");
  assert(!/cuál de estos/i.test(ninguno.reply), "ninguno volvió a preguntar los Takis");
  assert(ninguno.cart.some((item) => /bolillo/i.test(item.name)), "ninguno quitó el bolillo que ya estaba");

  const lecheDoble: AgentModel = {
    name: "sim-leche-doble",
    async complete(request) {
      const searched = request.toolTrace.some((entry) => entry.call.name === "search_products");
      if (!searched) {
        return { toolCalls: [{ id: "s1", name: "search_products", arguments: { query: "leche lala" } }], text: null };
      }
      return {
        toolCalls: [
          { id: "set1", name: "set_cart_line", arguments: { product_id: 4933, qty: 1, unit: "pz" } },
          { id: "ask1", name: "ask_customer", arguments: { text: "¿Qué leche Lala quieres?", candidate_ids: [4870, 4933] } },
        ],
        text: null,
      };
    },
  };
  const doble = await runOrderAgentTurn({
    message: "Leche Lala Entera 1 Lt",
    cart: [],
    pending: null,
    history: [],
    awaitingList: false,
    store,
    products: [],
    search: async (query) => searchAgentProducts(products, query, 24),
    model: lecheDoble,
    escalationModel: null,
    logEvent: () => {},
  });
  const dobleLala = doble.cart.filter((item) => /lala/i.test(item.name) && /leche/i.test(item.name));
  assert(dobleLala.length === 1, `add_line no dejó una sola leche: ${dobleLala.map((item) => item.name).join(" | ") || doble.toolCalls.map((item) => `${item.call.name} ${JSON.stringify(item.result)}`).join(" ; ")}`);
  assert(!/leche lala/i.test(doble.pending?.query ?? ""), `la pregunta de la leche ya anotada no se tragó:\n${doble.reply}`);

  const pekes: UxStore = {
    id: 7,
    nombre: "Mini Super Peke's",
    categoria: "Abarrotes",
    telefono: "0",
    abierta: true,
    abreTexto: "",
    usaCatalogoFijo: false,
  };
  const george: UxStore = {
    id: 5,
    nombre: "Hamburguesas Hotdogs George",
    categoria: "Restaurante",
    telefono: "0",
    abierta: true,
    abreTexto: "",
    usaCatalogoFijo: true,
  };
  const central: UxStore = {
    id: 6,
    nombre: "Carnicería La Central",
    categoria: "Carnicerías",
    telefono: "0",
    abierta: true,
    abreTexto: "",
    usaCatalogoFijo: true,
  };
  const pekesHi = formatAbarrotesStoreAck(pekes);
  const georgeHi = formatCatalogMenuCaption(george);
  const centralHi = formatCatalogMenuCaption(central);
  for (const [name, text] of [["Peke's", pekesHi], ["George", georgeHi], ["La Central", centralHi]] as const) {
    assert(/cómo pedir/i.test(text), `${name} no explica cómo pedir`);
    assert(/cómo agregar/i.test(text), `${name} no explica cómo agregar`);
    assert(/cómo quitar/i.test(text), `${name} no explica cómo quitar`);
    assert(/cómo corregir/i.test(text), `${name} no explica cómo corregir`);
    assert(/producto por producto/i.test(text), `${name} no recomienda ir de uno en uno`);
    assert(/varios juntos/i.test(text), `${name} dejó de aceptar varios juntos`);
    assert(!text.includes("Envío: $15") && !text.includes("servicio $10"), `${name} cobra antes del resumen`);
  }
  assert(pekesHi.includes("2 Coca-Cola de 600 ml") && pekesHi.includes("Pinol") && pekesHi.includes("tortillas"), "Peke's perdió los ejemplos de siempre");
  assert(pekesHi.includes("agrega 1 Pinol de 1 litro") && pekesHi.includes("quita la leche") && pekesHi.includes("cambia la leche Lala a 2 litros"), "Peke's no usa los comandos reales");
  assert(georgeHi.includes("Te paso el menú de") && georgeHi.includes("2 hamburguesas sencillas"), "George perdió el menú o el ejemplo");
  assert(georgeHi.includes("agrega 1 refresco") && georgeHi.includes("quita las papas") && georgeHi.includes("cambia la hamburguesa a grande"), "George no usa sus comandos");
  assert(!/pinol|zote|takis|fud|mccormick/i.test(georgeHi), "George se contaminó con abarrotes");
  assert(centralHi.includes("1 kg de chorizo") && centralHi.includes("agrega 1 kilo de carne"), "La Central no explica el corte");
  assert(centralHi.includes("quita el pastor") && centralHi.includes("cambia el carbón a 2 bolsas"), "La Central no usa sus comandos");
  assert(!/pinol|coca|zote|takis/i.test(centralHi), "La Central se contaminó con abarrotes");
  sample("BIENVENIDA PEKE'S", pekesHi);
  sample("BIENVENIDA GEORGE", georgeHi);
  sample("BIENVENIDA LA CENTRAL", centralHi);

  console.log(samples.join("\n"));
  console.log("\n[pekes-one-question] una pregunta por mensaje, Members Mark, sí a ubicación, 4 productos.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
