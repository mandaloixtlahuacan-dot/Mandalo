/**
 * Pedido #117 de George y las variantes de voz, plural y cantidad.
 * También La Central, por si el mismo parser se traga un corte.
 * No toca Supabase, WhatsApp ni OpenAI.
 *
 * Correr: npx tsx scripts/check-restaurant-orders.ts
 */
import { CARNICERIA_LA_CENTRAL_PRODUCTOS } from "../src/lib/carniceriaLaCentralCatalog";
import type { CatalogPriceRow } from "../src/lib/catalogQuantities";
import { advanceMenuAsk } from "../src/lib/catalogOrderSpeech";
import { classifyProductListReply, isProductListYes, isYesConfirmation, orderingStepAfterCustomer } from "../src/lib/messages";
import { applyCustomerEdits, planCustomerEdits } from "../src/lib/orderEdits";
import { assembleCapturedItems } from "../src/lib/orderGrounding";
import { formatProductListConfirm, type PedidoItemInput } from "../src/lib/services/captureEngine";

const george: CatalogPriceRow[] = `
Hamburguesa de Res Chica | 60
Hamburguesa de Res Grande | 100
Hamburguesa de Pollo Chica | 70
Hamburguesa de Pollo Grande | 110
Hamburguesa de Camarón Chica | 90
Hamburguesa de Camarón Grande | 130
Hamburguesa Hawaiana Chica | 90
Hamburguesa Hawaiana Grande | 120
Hamburguesa Cubana Chica | 90
Hamburguesa Cubana Grande | 120
Hamburguesa Mar y Tierra Chica | 90
Hamburguesa Mar y Tierra Grande | 140
Hamburguesa de Arrachera Chica | 70
Hamburguesa de Arrachera Grande | 100
Papas a la Francesa 300g | 70
Papas Gajo 315g | 70
Salchilocos 310g | 70
Dedos de Queso 6 piezas | 85
Boneless 10 piezas | 130
Botana Completa | 100
Dogo Clásico | 35
Dogo de Pollo | 45
Dogo Cubano | 60
Dogo Hawaiano | 60
Dogo de Camarón | 60
Dogoburguer | 50
Doridogo | 45
Dogo Arrachera | 45
Pizzadogo | 45
Refresco (Pepsi, Seven, Coca, Mirinda o Manzana) | 20
Torta de Pierna | 80
Torta Hawaiana | 100
Torta Cubana | 100
Torta Mexicana | 100
Torta de Arrachera | 80
Torta de Chorizo | 80
Torta Campechana | 80
Sincronizada de Pierna y Tocino | 70
Sincronizada de Tocino | 60
Sincronizada de Camarón | 80
Sincronizada de Arrachera | 70
Sincronizada de Chorizo | 70
Sincronizada Campechana | 70
Quesadilla de Tocino | 35
Quesadilla de Camarón | 80
Quesadilla Burrita | 35
Quesadilla Quesaburra | 70
Quesadilla de Arrachera | 45
Quesadilla de Chorizo | 45
Quesadilla Campechana | 55
Ingrediente Extra en Quesadilla | 20
Alitas 5 piezas | 70
Alitas 10 piezas | 130
Alitas 15 piezas | 185
Alitas 20 piezas | 225
Alitas 30 piezas | 325
`
  .trim()
  .split("\n")
  .map((line) => {
    const [nombreProducto, precio] = line.split(" | ");
    return { nombreProducto, precio: Number(precio) };
  });

const central: CatalogPriceRow[] = CARNICERIA_LA_CENTRAL_PRODUCTOS.map(({ nombreProducto, precio }) => ({
  nombreProducto,
  precio,
}));

const ORDER_117 = "Quiero dos hamburguesas de camarón grandes, unos Salchi, locos, dos Dogs, hawaianos y tres refrescos";
const MODEL_117: PedidoItemInput[] = [
  { nombre_producto: "Hamburguesa de Camarón", cantidad: 1 },
  { nombre_producto: "Refresco", cantidad: 1 },
  { nombre_producto: "Dogos hawaianos", cantidad: 1 },
  { nombre_producto: "Salchilocos", cantidad: 1 },
];

const failures: string[] = [];
let passed = 0;

function check(id: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${id}: ${detail}` : id);
}

function speak(message: string, prior: PedidoItemInput[] = [], incoming: PedidoItemInput[] = [], catalog = george) {
  return assembleCapturedItems({ prior, incoming, userMessage: message, catalog });
}

function line(items: PedidoItemInput[], re: RegExp): PedidoItemInput | undefined {
  return items.find((item) => re.test(`${item.nombre_producto} ${item.marca ?? ""}`.trim()));
}

function qty(item: PedidoItemInput | undefined): number | null {
  return typeof item?.cantidad === "number" ? item.cantidad : null;
}

function asked(result: ReturnType<typeof speak>): string {
  return `${result.catalogSpeech?.question ?? ""}\n${result.catalogSpeech?.reply ?? ""}`;
}

function order117ok(items: PedidoItemInput[], flavor: "open" | "pepsi" = "open"): string | null {
  const burger = line(items, /camar[oó]n grande/i);
  const salchi = line(items, /salchilocos/i);
  const dogo = line(items, /dogo hawaiano/i);
  const drink = items.filter((item) => /refresco/i.test(item.nombre_producto));
  if (qty(burger) !== 2) return `burger x${qty(burger)}`;
  if (qty(salchi) !== 1) return `salchi x${qty(salchi)}`;
  if (qty(dogo) !== 2) return `dogo x${qty(dogo)}`;
  if (items.some((item) => /torta/i.test(item.nombre_producto))) return "apareció una torta";
  if (flavor === "open") {
    if (drink.length !== 1 || qty(drink[0]) !== 3 || drink[0].marca) return `refresco ${drink.map((item) => `${item.marca ?? ""} x${item.cantidad}`).join(",")}`;
    if (/pepsi,\s*seven,\s*coca/i.test(drink[0].nombre_producto)) return "se mostró la lista cruda del menú";
  }
  if (flavor === "pepsi") {
    if (drink.length !== 1 || qty(drink[0]) !== 3 || !/pepsi/i.test(drink[0].marca ?? "")) return "no quedó Pepsi x3";
  }
  return null;
}

const empty = speak(ORDER_117);
const guessed = speak(ORDER_117, [], MODEL_117);
check("117-vacio", order117ok(empty.items) == null, order117ok(empty.items) ?? "");
check("117-modelo", order117ok(guessed.items) == null, order117ok(guessed.items) ?? "");
check(
  "117-solo-sabor",
  /marca/i.test(asked(empty)) && !/chica o grande/i.test(asked(empty)) && !/no lo manejamos/i.test(asked(empty)),
  asked(empty).slice(0, 240),
);
const sized = speak("La hamburguesa de camarón, la quiero grande", empty.items);
check("117-sigue-en-2", order117ok(sized.items) == null, order117ok(sized.items) ?? "");
check("117-sabor-sigue", /marca/i.test(asked(sized)) && !/chica o grande/i.test(asked(sized)), asked(sized).slice(0, 200));
const pepsi = speak("Pepsi", empty.items);
check("117-pepsi", order117ok(pepsi.items, "pepsi") == null && !/marca/i.test(asked(pepsi)), order117ok(pepsi.items, "pepsi") ?? asked(pepsi));
const split = speak("2 pepsi y 1 coca", empty.items);
const pepsiLine = split.items.find((item) => /pepsi/i.test(item.marca ?? ""));
const cocaLine = split.items.find((item) => /coca/i.test(item.marca ?? ""));
check(
  "117-parte-refrescos",
  qty(line(split.items, /camar[oó]n grande/i)) === 2 && qty(pepsiLine) === 2 && qty(cocaLine) === 1,
  split.items.map((item) => `${item.nombre_producto} ${item.marca ?? ""} x${item.cantidad}`).join(", "),
);

const unsized = [{ nombre_producto: "Hamburguesa de Camarón", cantidad: 2 }];
for (const answer of ["grandes", "Grandes", "la grande", "las grandes", "las dos grandes", "2 grandes"]) {
  const next = speak(answer, unsized);
  const burger = line(next.items, /camar[oó]n grande/i);
  check(
    `tamaño-${answer}`,
    qty(burger) === 2 && next.items.length === 1 && !/no lo manejamos/i.test(asked(next)) && !/chica o grande/i.test(asked(next)),
    `${next.items.map((item) => item.nombre_producto).join(", ")} ${asked(next).slice(0, 120)}`,
  );
}
const chicas = speak("chicas", [{ nombre_producto: "Hamburguesa de Pollo", cantidad: 2 }]);
check("tamaño-chicas", qty(line(chicas.items, /pollo chica/i)) === 2 && !/no lo manejamos/i.test(asked(chicas)));
const lasChicas = speak("las chicas", [{ nombre_producto: "Hamburguesa de Pollo", cantidad: 2 }]);
check("tamaño-las-chicas", qty(line(lasChicas.items, /pollo chica/i)) === 2);
const chico = speak("chico", [{ nombre_producto: "Hamburguesa de Pollo", cantidad: 2 }]);
check("tamaño-chico", qty(line(chico.items, /pollo chica/i)) === 2 && !/no lo manejamos/i.test(asked(chico)));
const mediana = speak("mediana", [{ nombre_producto: "Hamburguesa de Res", cantidad: 1 }]);
check(
  "tamaño-mediana",
  qty(line(mediana.items, /hamburguesa de res/i)) === 1 &&
    !/no lo manejamos/i.test(asked(mediana)) &&
    !/mediana/i.test(mediana.items.map((item) => item.nombre_producto).join(" ")),
  asked(mediana).slice(0, 160),
);

check("orden-grandes-de", qty(line(speak("dos hamburguesas grandes de camarón").items, /camar[oó]n grande/i)) === 2);
check("orden-pollo-chicas", qty(line(speak("2 hamburguesas de pollo chicas").items, /pollo chica/i)) === 2);
check("orden-hawaiana", qty(line(speak("dos hamburguesas hawaianas grandes").items, /hawaiana grande/i)) === 2);

for (const message of ["dos dogs hawaianos", "dos hot dogs hawaianos", "2 hotdogs hawaianos", "dos dogos hawaianos", "jot dog hawaiano"]) {
  const items = speak(message).items;
  const expected = /jot/.test(message) ? 1 : 2;
  check(
    `dogo-${message}`,
    qty(line(items, /dogo hawaiano/i)) === expected && !items.some((item) => /torta|hamburguesa/i.test(item.nombre_producto)),
    items.map((item) => item.nombre_producto).join(", "),
  );
}
check("dogo-clasico", qty(line(speak("un dog clásico").items, /dogo cl[aá]sico/i)) === 1);

for (const message of ["unos salchi locos", "salchilocos", "unos Salchi, locos", "salchiloco"]) {
  check(`salchi-${message}`, qty(line(speak(message).items, /salchilocos/i)) === 1, speak(message).items.map((item) => item.nombre_producto).join(", "));
}
check("salchi-dos", qty(line(speak("2 salchilocos").items, /salchilocos/i)) === 2);

const tres = speak("tres refrescos");
check("refresco-sabor", qty(line(tres.items, /^refresco$/i)) === 3 && /marca/i.test(asked(tres)) && !/cuántas/i.test(asked(tres)));
check("refresco-manzana", qty(line(speak("tres refrescos de manzana").items, /manzana/i)) === 3 && !/marca/i.test(asked(speak("tres refrescos de manzana"))));
check("refresco-pepsis", qty(line(speak("3 pepsis").items, /pepsi/i)) === 3 && !/te refieres a pepsis/i.test(asked(speak("3 pepsis"))));
const mix = speak("una coca y dos manzanitas");
check("refresco-mix", qty(line(mix.items, /coca/i)) === 1 && qty(line(mix.items, /manzana/i)) === 2);

check("qty-un", qty(line(speak("un dogo clásico").items, /cl[aá]sico/i)) === 1);
check("qty-digit", qty(line(speak("4 dogos clásicos").items, /cl[aá]sico/i)) === 4);
const otra = speak("y otra más", [{ nombre_producto: "Dogo Clásico", cantidad: 1 }]);
check("qty-otra", qty(line(otra.items, /cl[aá]sico/i)) === 2, otra.items.map((item) => `${item.nombre_producto} x${item.cantidad}`).join(", "));

const voice = speak("sería también unos Salchi, locos, y dos Dogs, hawaianos");
check(
  "voz-comas",
  qty(line(voice.items, /salchilocos/i)) === 1 && qty(line(voice.items, /dogo hawaiano/i)) === 2,
  voice.items.map((item) => `${item.nombre_producto} x${item.cantidad}`).join(", "),
);

const dropped = speak("dos dogs hawaianos y un sushi");
check(
  "no-se-traga",
  qty(line(dropped.items, /dogo hawaiano/i)) === 2 && /no lo manejamos|te refieres/i.test(asked(dropped)),
  asked(dropped).slice(0, 180),
);
const covered = speak(ORDER_117);
const blob = `${covered.items.map((item) => `${item.nombre_producto} ${item.marca ?? ""}`).join(" ")} ${asked(covered)}`;
for (const token of ["camar", "salchi", "hawaiano", "refresco"]) {
  check(`cubre-${token}`, blob.toLowerCase().includes(token), blob.slice(0, 180));
}

const both = speak("dos kilos de chorizo y un kilo de arrachera", [], [], central);
check(
  "central-los-dos",
  qty(line(both.items, /^chorizo$/i)) === 2 &&
    both.items.find((item) => /^chorizo$/i.test(item.nombre_producto))?.unidad === "kilo" &&
    qty(line(both.items, /arrachera/i)) === 1 &&
    line(both.items, /arrachera/i)?.unidad === "kilo",
  both.items.map((item) => `${item.nombre_producto} x${item.cantidad} ${item.unidad ?? ""}`).join(", "),
);
const chorizo = speak("dos kilos de chorizo", [], [], central);
const fino = speak("el argentino", chorizo.items, [], central);
check(
  "central-no-reinicia",
  fino.items.length === 1 && qty(line(fino.items, /argentino/i)) === 2 && line(fino.items, /argentino/i)?.unidad === "kilo",
  fino.items.map((item) => `${item.nombre_producto} x${item.cantidad} ${item.unidad ?? ""}`).join(", "),
);
const plural = speak("dos arracheras y un chorizo", [], [], central);
check(
  "central-plural",
  qty(line(plural.items, /arrachera/i)) === 2 && qty(line(plural.items, /chorizo/i)) === 1 && !/cuántas/i.test(asked(plural)),
  plural.items.map((item) => `${item.nombre_producto} x${item.cantidad}`).join(", "),
);
const commas = speak("unos chorizos, argentino, y carbon, fino", [], [], central);
check(
  "central-comas",
  Boolean(line(commas.items, /chorizo argentino/i)) && Boolean(line(commas.items, /carb[oó]n fino/i)),
  commas.items.map((item) => item.nombre_producto).join(", "),
);

const flavor = "¿Refresco, de qué marca? Por ejemplo Pepsi, Coca o Seven.";
const again = advanceMenuAsk({
  items: empty.items,
  question: flavor,
  reply: flavor,
  message: "no se",
  pending: { itemKey: "menu", slots: [], question: flavor, count: 1, mode: "ask" },
});
check("repite-opciones", /1\)/ .test(again.question ?? "") && /Pepsi/.test(again.question ?? "") && /El que sea/.test(again.question ?? ""), again.question ?? "");
const waived = advanceMenuAsk({
  items: again.items,
  question: again.question,
  reply: again.reply,
  message: "mmm",
  pending: again.pendingAsk,
});
check("repite-la-que-sea", /la que sea/i.test(waived.items.find((item) => /refresco/i.test(item.nombre_producto))?.marca ?? "") && waived.question == null);
const numbered = advanceMenuAsk({
  items: empty.items,
  question: flavor,
  reply: flavor,
  message: "1",
  pending: again.pendingAsk,
});
check("repite-numero", /pepsi/i.test(numbered.items.find((item) => /refresco/i.test(item.nombre_producto))?.marca ?? "") && numbered.question == null);

function shown(items: PedidoItemInput[]): string {
  return items.map((item) => `${item.nombre_producto} ${item.marca ?? ""} x${item.cantidad ?? "?"} ${item.unidad ?? ""}`.replace(/\s+/g, " ").trim()).join(" | ");
}

function hasLine(items: PedidoItemInput[], re: RegExp, n: number, unit?: string): boolean {
  const item = line(items, re);
  if (qty(item) !== n) return false;
  if (unit && item?.unidad !== unit) return false;
  return true;
}

const MSG_118_1 = "Quiero dos hamburguesas de res, dos dedos de queso, un dúo clásico y dos refrescos";
const MSG_118_2 = "La hamburguesa de res sería una chica y una grande y el refresco. Sería una Pepsi y una coca.";
const MODEL_118: PedidoItemInput[] = [
  { nombre_producto: "Hamburguesa de Res Chica", cantidad: 1 },
  { nombre_producto: "Hamburguesa de Res Grande", cantidad: 1 },
  { nombre_producto: "Dedos de Queso 6 piezas", cantidad: 2 },
  { nombre_producto: "Dogo Clásico", cantidad: 1 },
  { nombre_producto: "Refresco", marca: "Pepsi", cantidad: 1 },
  { nombre_producto: "Refresco", marca: "Coca", cantidad: 1 },
];

function order118ok(items: PedidoItemInput[]): string | null {
  if (!hasLine(items, /res chica/i, 1)) return `chica ${shown(items)}`;
  if (!hasLine(items, /res grande/i, 1)) return `grande ${shown(items)}`;
  if (!hasLine(items, /dedos de queso/i, 2)) return `dedos ${shown(items)}`;
  if (!hasLine(items, /dogo cl[aá]sico/i, 1)) return `dogo ${shown(items)}`;
  if (!hasLine(items, /pepsi/i, 1)) return `pepsi ${shown(items)}`;
  if (!hasLine(items, /coca/i, 1)) return `coca ${shown(items)}`;
  if (items.length !== 6) return `líneas ${items.length}: ${shown(items)}`;
  return null;
}

const turn1 = speak(MSG_118_1);
check("118-turno-1", hasLine(turn1.items, /res$/i, 2) && hasLine(turn1.items, /dedos/i, 2) && hasLine(turn1.items, /dogo cl[aá]sico/i, 1) && hasLine(turn1.items, /^refresco$/i, 2), shown(turn1.items));
check("118-sin-duo", !/duo/i.test(asked(turn1)) && /chica o grande/i.test(asked(turn1)) && /marca/i.test(asked(turn1)), asked(turn1).slice(0, 240));
const turn2 = speak(MSG_118_2, turn1.items, MODEL_118);
check("118-turno-2", order118ok(turn2.items) == null, order118ok(turn2.items) ?? asked(turn2).slice(0, 180));
check("118-sin-bien", !/bien/i.test(asked(turn2)) && !/no lo manejamos/i.test(asked(turn2)) && !/te refieres/i.test(asked(turn2)), asked(turn2).slice(0, 220));
const collapsed = speak(MSG_118_2, turn1.items, []);
check("118-sin-modelo", order118ok(collapsed.items) == null, order118ok(collapsed.items) ?? shown(collapsed.items));
const saidYes = "Si está bien mi pedido";
const yesTalk = speak(saidYes, turn2.items);
check("118-si-no-cambia", order118ok(yesTalk.items) == null && !/bien/i.test(asked(yesTalk)) && !/no lo manejamos/i.test(asked(yesTalk)), `${shown(yesTalk.items)} ${asked(yesTalk).slice(0, 120)}`);
check(
  "118-si-una-vez",
  classifyProductListReply(saidYes) === "confirm" &&
    isProductListYes(saidYes) &&
    !isYesConfirmation(saidYes) &&
    orderingStepAfterCustomer({ step: "final_ticket", customerMessage: saidYes }) === "stay" &&
    orderingStepAfterCustomer({ step: "product_list", customerMessage: "SÍ" }) === "location",
);

const pepsiDoble: PedidoItemInput[] = [
  { nombre_producto: "Refresco", marca: "Pepsi", cantidad: 2 },
  { nombre_producto: "Refresco", marca: "Coca", cantidad: 1 },
];
const quitaUno = "Quítame el refresco Pepsi nomás quiero debes de 2 quiero uno";
const planUno = planCustomerEdits(quitaUno);
const dejadoEnUno = applyCustomerEdits({ prior: pepsiDoble, plan: planUno, catalog: george });
check(
  "118-quiero-uno",
  planUno.ops.some((op) => op.kind === "setQty") &&
    !planUno.ops.some((op) => op.kind === "remove") &&
    hasLine(dejadoEnUno.items, /pepsi/i, 1) &&
    hasLine(dejadoEnUno.items, /coca/i, 1),
  `${planUno.ops.map((op) => op.kind).join(",")} ${shown(dejadoEnUno.items)}`,
);
for (const phrase of ["quítame la pepsi, de 2 quiero uno", "quita la pepsi dejalo en uno", "quita la pepsi solo uno", "quita la pepsi nomas quiero 1"]) {
  const plan = planCustomerEdits(phrase);
  const edited = applyCustomerEdits({ prior: pepsiDoble, plan, catalog: george });
  check(`edita-${phrase}`, plan.ops.some((op) => op.kind === "setQty") && hasLine(edited.items, /pepsi/i, 1), shown(edited.items));
}
const quitaDeVeras = planCustomerEdits("quita la pepsi");
const sinPepsi = applyCustomerEdits({ prior: pepsiDoble, plan: quitaDeVeras, catalog: george });
check("quita-sigue-borrando", quitaDeVeras.ops.some((op) => op.kind === "remove") && !line(sinPepsi.items, /pepsi/i) && hasLine(sinPepsi.items, /coca/i, 1));

function splitOk(message: string, prior: PedidoItemInput[] = []): boolean {
  const result = speak(message, prior);
  return order118ok.length >= 0 && hasLine(result.items, /res chica/i, 1) && hasLine(result.items, /res grande/i, 1) && !/no lo manejamos/i.test(asked(result));
}
check("mix-chica-grande", splitOk("una hamburguesa de res chica y una grande"));
check("mix-reparte-2", splitOk("2 hamburguesas de res, una chica y una grande"));
check("mix-de-res", splitOk("una de res chica y una grande"));
check("mix-las-dos", splitOk("las dos de res, una chica y una grande"));
const pollo = speak("quiero una hamburguesa de pollo grande y una chica");
check(
  "mix-pollo",
  hasLine(pollo.items, /pollo grande/i, 1) && hasLine(pollo.items, /pollo chica/i, 1) && pollo.items.length === 2,
  shown(pollo.items),
);
const otraChica = speak("hamburguesa de pollo grande y otra chica");
check(
  "mix-otra-chica",
  hasLine(otraChica.items, /pollo grande/i, 1) &&
    hasLine(otraChica.items, /pollo chica/i, 1) &&
    otraChica.items.length === 2 &&
    !/te refieres/i.test(asked(otraChica)) &&
    !/no lo manejamos/i.test(asked(otraChica)),
  `${shown(otraChica.items)} ${asked(otraChica).slice(0, 160)}`,
);
const laOtraChica = speak("quiero una hamburguesa de pollo grande y la otra chica");
check(
  "mix-la-otra-chica",
  hasLine(laOtraChica.items, /pollo grande/i, 1) &&
    hasLine(laOtraChica.items, /pollo chica/i, 1) &&
    laOtraChica.items.length === 2 &&
    !/te refieres/i.test(asked(laOtraChica)) &&
    !/no lo manejamos/i.test(asked(laOtraChica)),
  `${shown(laOtraChica.items)} ${asked(laOtraChica).slice(0, 160)}`,
);
const dogos = speak("dos dogos, uno clásico y uno hawaiano");
check(
  "mix-dogos",
  hasLine(dogos.items, /dogo cl[aá]sico/i, 1) && hasLine(dogos.items, /dogo hawaiano/i, 1) && !/hawaiano\?/i.test(asked(dogos)) && dogos.items.length === 2,
  `${shown(dogos.items)} ${asked(dogos).slice(0, 120)}`,
);
const respondeTamano = speak("una chica y una grande", [{ nombre_producto: "Hamburguesa de Res", cantidad: 2 }]);
check("mix-responde-tamano", hasLine(respondeTamano.items, /res chica/i, 1) && hasLine(respondeTamano.items, /res grande/i, 1) && respondeTamano.items.length === 2, shown(respondeTamano.items));
const respondeSabor = speak("una Pepsi y una coca", [{ nombre_producto: "Refresco", cantidad: 2 }]);
check("mix-responde-sabor", hasLine(respondeSabor.items, /pepsi/i, 1) && hasLine(respondeSabor.items, /coca/i, 1) && respondeSabor.items.length === 2, shown(respondeSabor.items));
const noSuma = speak("3 hamburguesas de res, una chica y una grande");
check(
  "mix-no-suma",
  hasLine(noSuma.items, /res chica/i, 1) &&
    hasLine(noSuma.items, /res grande/i, 1) &&
    (noSuma.catalogSpeech?.question ?? "").match(/te refieres/gi)?.length === 1,
  `${shown(noSuma.items)} ${asked(noSuma).slice(0, 160)}`,
);
const bistec = speak("1 kilo de bistec de res y medio de cerdo", [], [], central);
check(
  "mix-cerdo",
  hasLine(bistec.items, /bistec de res/i, 1, "kilo") &&
    hasLine(bistec.items, /bistec de puerco$/i, 0.5, "kilo") &&
    !/marinad/i.test(shown(bistec.items)) &&
    bistec.items.length === 2,
  shown(bistec.items),
);
const chorizos = speak("2 kilos de chorizo, uno argentino y uno de la casa", [], [], central);
check(
  "mix-chorizo",
  hasLine(chorizos.items, /^chorizo$/i, 1, "kilo") && hasLine(chorizos.items, /chorizo argentino/i, 1, "kilo") && chorizos.items.length === 2,
  shown(chorizos.items),
);

const yesPhrases = [
  "sí", "si", "siii", "sip", "simón", "ok", "okey", "va", "va que va", "sale", "ya", "listo", "es todo",
  "eso es todo", "así", "así está bien", "así está bien mi pedido", "sí está bien mi pedido", "está bien",
  "todo bien", "todo está bien", "sí todo está bien", "sí, así", "correcto", "es correcto", "sí, es correcto",
  "perfecto", "de acuerdo", "dale", "ándale", "confirmo", "así déjalo", "así mero", "está perfecto",
  "sí gracias", "sí por favor", "si esta vien", "asi esta bn", "ta bien", "ok si", "sii ok",
];
for (const phrase of yesPhrases) {
  check(`si-${phrase}`, classifyProductListReply(phrase) === "confirm" && isProductListYes(phrase), classifyProductListReply(phrase));
}
for (const phrase of ["sí, pero quita la coca", "agrega 1 pepsi", "está bien pero sin cebolla", "¿está bien?", "no", "no está bien"]) {
  check(`no-si-${phrase}`, classifyProductListReply(phrase) !== "confirm");
}
for (const kind of ["abarrotes", "carniceria", "restaurante"] as const) {
  const prompt = formatProductListConfirm([{ nombre_producto: "Prueba", cantidad: 1 }], kind);
  check(
    `pregunta-${kind}`,
    prompt.includes("*Si tu pedido está bien, responde sí.*") &&
      prompt.includes("*¿Están bien estos productos?*") &&
      prompt.includes("Solo es un ejemplo, no está en tu pedido"),
    prompt.slice(prompt.indexOf("¿Están"), 220),
  );
}

console.log(`Restaurante: ${passed}/${passed + failures.length}`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
