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
import { assembleCapturedItems } from "../src/lib/orderGrounding";
import type { PedidoItemInput } from "../src/lib/services/captureEngine";

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

console.log(`Restaurante: ${passed}/${passed + failures.length}`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
