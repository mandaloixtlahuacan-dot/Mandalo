/**
 * Aclaraciones de abarrotes: la respuesta llena la línea abierta, no abre otra,
 * y la misma pregunta no se repite.
 * Correr: npx tsx scripts/check-clarification-answers.ts
 */
import { advanceQuoteTurn, type PendingAsk } from "../src/lib/clarificationAnswers";
import { prepareQuoteItems, quoteQuestionForItems } from "../src/lib/quoteProductClarity";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";
import type { PedidoItemInput, PedidoSnapshot } from "../src/lib/services/captureEngine";
import { parseStoreProductText, type ListaProducto } from "../src/lib/storeProductList";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function line(item: PedidoItemInput): string {
  return [item.nombre_producto, item.marca, item.presentacion, item.cantidad, item.unidad, item.notas]
    .filter((part) => part != null && part !== "")
    .join(" | ");
}

function play(start: PedidoItemInput[], messages: string[], lista?: ListaProducto[]) {
  let items = start;
  let pending: PendingAsk | null = null;
  let avisos: string[] = [];
  const questions: string[] = [];
  for (const message of messages) {
    const turn = advanceQuoteTurn(items, message, pending, { lista, listaAvisos: avisos });
    items = turn.items;
    pending = turn.pendingAsk;
    avisos = turn.listaAvisos;
    questions.push(turn.question ?? "");
  }
  return { items, questions, pending };
}

const ORDER_116 = [
  "Quiero dos caguamas, 2 kilos de queso 3 Pepsis",
  "Serían caguamas corona",
  "Sería Lala",
  "Sería Lala",
  "Sería 1 kilo Lala",
  "Lala",
  "Sería caperucita",
  "1",
  "Grande",
  "Pepsi",
  "Es marca Pepsi",
  "Marca  2 litros Pepsi",
  "Marca Pepsi",
  "Coca Cola",
  "2 litros",
  "Marca la costeña",
  "Caguama",
  "Entera",
  "2 litros",
  "1",
  "3 litros",
  "3 litros de Lala",
  "2",
  "5",
  "2 litros de Lala",
  "3 litros de lala",
  "Leche de 2 litros",
  "1 litro de Santa Clara",
];

const replay = play([], ORDER_116);
const blob = replay.items.map(line).join(" || ");
console.log("--- pedido 116 ---");
replay.questions.forEach((question, index) => {
  console.log(`${index + 1}. ${ORDER_116[index]}`);
  console.log(question.split("\n")[0] || "(sin pregunta)");
});
console.log("FINAL", blob);

check("116 tiene cerveza, queso y refresco", replay.items.length === 3, blob);
check("116 cerveza corona caguama x2", /Cerveza/.test(blob) && /Corona/.test(blob) && /caguama/i.test(blob) && /2/.test(blob), blob);
check("116 queso 2 kilos", /Queso/.test(blob) && /2 kilos|2 \| kilo/.test(blob) && /Lala|Caperucita/.test(blob), blob);
check("116 pepsi x3 con tamaño", /Refresco/.test(blob) && /Pepsi/.test(blob) && /3/.test(blob) && /grande|2 litros/i.test(blob), blob);
check("116 sin leche ni coca", !/Leche|Coca/.test(blob), blob);

const counts = new Map<string, number>();
for (const question of replay.questions) {
  const key = question.replace(/\s+/g, " ").trim();
  if (!key) continue;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const repeated = [...counts.entries()].filter(([, count]) => count > 2);
check("116 ninguna pregunta más de dos veces", repeated.length === 0, repeated.map(([text, count]) => `${count}× ${text}`).join(" ; "));

const lecheAnswers = [
  "de 1 litro",
  "1 l",
  "el de litro",
  "2",
  "2 de un litro",
  "la grande",
  "la chica",
  "Lala",
  "del que sea",
  "cualquiera",
  "1 litro, 2 piezas",
  "3 litros de Lala",
  "Leche de 2 litros",
  "sí",
];
for (const answer of lecheAnswers) {
  const turn = play([], ["Quiero leche", answer]);
  const first = turn.questions[0].replace(/\s+/g, " ").trim();
  const second = turn.questions[1].replace(/\s+/g, " ").trim();
  check(`leche «${answer}» no repite la pregunta`, second !== first && second.length >= 0, `${first} -> ${second} :: ${turn.items.map(line).join(" || ")}`);
}

const poisoned = play(
  [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", unidad: "kilo", cantidad: 1 }],
  ["2 litros"],
);
check(
  "kilo envenenado se vuelve 2 litros",
  poisoned.items.length === 1 && poisoned.items[0].unidad === "litros" && poisoned.items[0].cantidad === 2 && !poisoned.questions[0].includes("cuántos litros"),
  poisoned.items.map(line).join(" || ") + " Q=" + poisoned.questions[0],
);

const queso = play([{ nombre_producto: "Queso", presentacion: "2 kilos", cantidad: 2, unidad: "kilo" }], ["Sería Lala"]);
check("Lala llena el queso y no abre leche", queso.items.length === 1 && queso.items[0].marca === "Lala" && queso.items[0].nombre_producto === "Queso", queso.items.map(line).join(" || "));

const pepsis = play([{ nombre_producto: "Pepsis", cantidad: 3 }], ["Pepsi"]);
check("Pepsi llena la línea abierta", pepsis.items.length === 1 && /Pepsi/i.test(`${pepsis.items[0].nombre_producto} ${pepsis.items[0].marca ?? ""}`), pepsis.items.map(line).join(" || "));
const cocas = play([{ nombre_producto: "Pepsis", cantidad: 3 }], ["Coca Cola"]);
check("Coca no abre otra línea", cocas.items.length === 1, cocas.items.map(line).join(" || "));

const both = play(
  [
    { nombre_producto: "Leche" },
    { nombre_producto: "Refresco", marca: "Coca" },
  ],
  ["la leche Lala de 2 litros y la Coca de 3"],
);
check(
  "un mensaje contesta las dos líneas",
  both.items.length === 2 && /Lala/.test(both.items[0].marca ?? "") && both.items[0].cantidad === 2 && both.items[1].cantidad === 3,
  both.items.map(line).join(" || "),
);

const nonsense = play([], ["Quiero leche", "xyzabc", "xyzabc"]);
check("segunda respuesta rara son opciones", /\*1\)\*/.test(nonsense.questions[1]), nonsense.questions[1]);
check("tercera respuesta rara cierra con la que sea", /la que sea/.test(line(nonsense.items[0] ?? { nombre_producto: "" })), nonsense.items.map(line).join(" || "));
const closed = validateCaptureForConfirmation({
  snapshot: { businessId: 1, businessName: "Abarrotes", pendingAsk: nonsense.pending, listaAvisos: [] } as PedidoSnapshot,
  items: nonsense.items,
  quoteStore: true,
  userMessage: "xyzabc",
  storeKind: "abarrotes",
});
check(
  "después de cerrar sigue a ¿Están bien?",
  (closed.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? "").includes("¿Están bien estos productos?"),
  closed.issues.find((issue) => issue.customerQuestion)?.customerQuestion,
);

const parsed = parseStoreProductText(`nombre,marca,presentacion,categoria,alias
Leche,Lala,entera 1 L,lacteos,lala entera|leche lala
Leche,Lala,deslactosada 1 L,lacteos,lala deslactosada
Leche,Lala,entera 1 L,lacteos,repite
Takis,Fuego,,botana,
`);
check("csv parsea y deduplica", parsed.length === 3 && Boolean(parsed[0].alias?.includes("lala entera")), JSON.stringify(parsed));
const plain = parseStoreProductText("# comentario\nLeche | Lala | entera 1 L\nPan Bimbo\n");
check("texto plano", plain.length === 2 && plain[0].marca === "Lala" && plain[1].nombre === "Pan Bimbo", JSON.stringify(plain));

const lista: ListaProducto[] = [
  { nombre: "Leche", marca: "Lala", presentacion: "entera 1 L", alias: ["lala entera"] },
  { nombre: "Leche", marca: "Lala", presentacion: "deslactosada 1 L", alias: ["lala deslactosada"] },
];
const listed = play([], ["Quiero leche Lala"], lista);
check("la lista pregunta entera o deslactosada", /entera 1 L/.test(listed.questions[0]) && /deslactosada 1 L/.test(listed.questions[0]) && !/cuántos litros/.test(listed.questions[0]), listed.questions[0]);
const picked = play([], ["Quiero leche Lala", "1"], lista);
check("el número elige la fila de la lista", /entera/.test(picked.items[0]?.presentacion ?? ""), picked.items.map(line).join(" || "));
const missing = play([], ["Quiero takis fuego"], lista);
check("lo que no está se anota y se avisa una vez", /Takis/i.test(missing.items.map(line).join(" ")) && missing.questions[0].includes("Lo anoto así"), missing.questions[0]);
check("el aviso no dice que no lo manejan", !/no lo manejamos/i.test(missing.questions[0]));

const style = nonsense.questions[1];
check("opciones en negrita y con línea en blanco", style.includes("*1)*") && style.includes("\n\n") && !style.includes("**"), style);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

void prepareQuoteItems;
void quoteQuestionForItems;
