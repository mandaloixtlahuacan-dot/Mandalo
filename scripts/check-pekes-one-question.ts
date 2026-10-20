/**
 * Peke's: una pregunta por mensaje, en el orden del cliente.
 * Replay de la tarde del 17 oct 2026, paquete de aguas, chile/salsa
 * y un pedido de 4 productos. Modelo simulado. No llama a OpenAI.
 * Correr: npx tsx scripts/check-pekes-one-question.ts
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { formatAbarrotesStoreAck, formatCatalogMenuCaption, type UxStore } from "../src/lib/customerUx";
import { confirmsShownProductList, isAffirmativeChatter } from "../src/lib/messages";
import { searchAgentProducts } from "../src/lib/orderAgent/catalog";
import { DEFAULT_ORDER_AGENT_ESCALATION_MODEL, DEFAULT_ORDER_AGENT_MODEL } from "../src/lib/orderAgent/env";
import { itemsFromAgentLines, runOrderAgentTurn, type AgentLine, type AgentPending, type AgentProduct, type AgentStore } from "../src/lib/orderAgent";
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
  sample("PAQUETE DE AGUAS", pack.reply);

  const four = "Coca Cola 2.5 Lt, sanitas, kombucha y jabon zote";
  let state = await turn(four, [], null);
  const fourLog: string[] = [`Cliente: ${four}`, "", state.reply];
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
    assertOneQuestion(state.reply, `4 productos, paso ${step + 1}`);
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
