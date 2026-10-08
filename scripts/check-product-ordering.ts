/**
 * Pedidos de prueba de la fase de productos. No toca Supabase, WhatsApp ni OpenAI.
 * Compara el merge anterior (se queda lo que el modelo agregue) con el
 * armado anclado al pedido previo y a las palabras del cliente.
 *
 * Correr: npx tsx scripts/check-product-ordering.ts
 */
import { applyCatalogSpeech } from "../src/lib/catalogOrderSpeech";
import { CARNICERIA_LA_CENTRAL_PRODUCTOS } from "../src/lib/carniceriaLaCentralCatalog";
import { priceCatalogOrder, type CatalogPriceRow } from "../src/lib/catalogQuantities";
import { ABARROTES_PRODUCT_REQUEST, formatStuckCorrection } from "../src/lib/customerUx";
import { classifyProductListReply, isCancelIntent, isNewOrderIntent, isYesConfirmation, orderingStepAfterCustomer } from "../src/lib/messages";
import { pickRemoval } from "../src/lib/orderEdits";
import { assembleCapturedItems, ungroundedOrderLines } from "../src/lib/orderGrounding";
import { MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "../src/lib/ordenes";
import { prepareQuoteItems } from "../src/lib/quoteProductClarity";
import { mergeSnapshot, type PedidoItemInput, type PedidoSnapshot } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";

type StoreKind = "abarrotes" | "george" | "central";
type ScenarioKind = "add" | "remove" | "add-one" | "qty" | "replace" | "slang" | "off-menu" | "confirm";

type Step = {
  user: string;
  /** Lo que el modelo devolvería en este turno, a veces de más o de menos. */
  llm: PedidoItemInput[];
  count?: number;
  has?: RegExp[];
  absent?: RegExp[];
  qty?: Array<{ name: RegExp; n: number }>;
  brand?: Array<{ name: RegExp; re: RegExp }>;
  unit?: Array<{ name: RegExp; u: string }>;
  specific?: boolean;
  asks?: RegExp;
  asksNot?: RegExp;
  noAsk?: boolean;
  notBoth?: Array<[RegExp, RegExp]>;
  marcaAbsent?: Array<{ name: RegExp; re: RegExp }>;
  presentacion?: Array<{ name: RegExp; re: RegExp }>;
  /** Un sí mezclado con un cambio no avanza a la ubicación. */
  stays?: boolean;
};

type Scenario = {
  id: string;
  store: StoreKind;
  kind?: ScenarioKind;
  catalog?: CatalogPriceRow[];
  /** Líneas ya anotadas, como si el turno anterior las hubiera dejado mal. */
  start?: PedidoItemInput[];
  steps: Step[];
};

const central: CatalogPriceRow[] = CARNICERIA_LA_CENTRAL_PRODUCTOS.map(({ nombreProducto, precio }) => ({
  nombreProducto,
  precio,
}));

const george: CatalogPriceRow[] = [
  { nombreProducto: "Hamburguesa Mar y Tierra Chica", precio: 90 },
  { nombreProducto: "Hamburguesa Mar y Tierra Grande", precio: 140 },
  { nombreProducto: "Hamburguesa de pollo", precio: 55 },
  { nombreProducto: "Hamburguesa Hawaiana", precio: 75 },
  { nombreProducto: "Hamburguesa Cubana", precio: 80 },
  { nombreProducto: "Hamburguesa de Res Chica", precio: 75 },
  { nombreProducto: "Hamburguesa de Res Grande", precio: 100 },
  { nombreProducto: "Dogo clásico", precio: 40 },
  { nombreProducto: "Dogo arrachera", precio: 45 },
  { nombreProducto: "Salchi locos", precio: 65 },
  { nombreProducto: "Papas Gajo 315g", precio: 45 },
  { nombreProducto: "Refresco", precio: 20 },
];

const george85: CatalogPriceRow[] = [
  { nombreProducto: "Hamburguesa de Res Chica", precio: 75 },
  { nombreProducto: "Hamburguesa de Res Grande", precio: 100 },
  { nombreProducto: "Papas Gajo 315g", precio: 45 },
  { nombreProducto: "Pepsi", precio: 22 },
  { nombreProducto: "Manzana", precio: 22 },
];

const coca: PedidoItemInput = { nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" };
const pollo: PedidoItemInput = { nombre_producto: "Pollo", cantidad: 1, unidad: "kilo" };
const sabritas: PedidoItemInput = { nombre_producto: "Sabritas", marca: "Sabritas", cantidad: 1 };

function blob(item: PedidoItemInput): string {
  return [item.nombre_producto, item.marca, item.presentacion, item.unidad, item.notas].filter(Boolean).join(" ");
}

function normName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function merged(prior: PedidoItemInput[], llm: PedidoItemInput[], store: StoreKind): PedidoItemInput[] {
  const name = store === "abarrotes" ? "ZAGU" : store === "george" ? "George" : "Carnicería La Central";
  return (
    mergeSnapshot({
      currentSnapshot: { businessId: 1, businessName: name, items: prior },
      llmOrderState: { business_id: 1, business_name: name, items: llm },
    }).items ?? []
  );
}

function quoteTurn(items: PedidoItemInput[], user: string, flags?: PedidoSnapshot["flags"]) {
  const snapshot: PedidoSnapshot = { businessId: 1, businessName: "ZAGU", items, flags };
  return validateCaptureForConfirmation({
    snapshot,
    items,
    knownZoneNames: ["Calle Hidalgo"],
    quoteStore: true,
    userMessage: user,
  });
}

function checkStep(step: Step, items: PedidoItemInput[], ask: string | null, specific: boolean): string[] {
  const errors: string[] = [];
  if (step.count != null && items.length !== step.count) {
    errors.push(`esperaba ${step.count} líneas y hay ${items.length}: ${items.map((item) => item.nombre_producto).join(" | ")}`);
  }
  for (const re of step.has ?? []) {
    if (!items.some((item) => re.test(blob(item)))) errors.push(`falta /${re.source}/`);
  }
  for (const re of step.absent ?? []) {
    if (items.some((item) => re.test(blob(item)))) errors.push(`sobra /${re.source}/`);
  }
  for (const qty of step.qty ?? []) {
    const item = items.find((row) => qty.name.test(blob(row)));
    if (!item) errors.push(`sin línea para cantidad /${qty.name.source}/`);
    else if (item.cantidad !== qty.n) errors.push(`/${qty.name.source}/ cantidad ${item.cantidad} ≠ ${qty.n}`);
  }
  for (const brand of step.brand ?? []) {
    const item = items.find((row) => brand.name.test(row.nombre_producto));
    if (!item) errors.push(`sin línea para marca /${brand.name.source}/`);
    else if (!brand.re.test(String(item.marca ?? ""))) errors.push(`marca de /${brand.name.source}/ es "${item.marca ?? ""}"`);
  }
  for (const unit of step.unit ?? []) {
    const item = items.find((row) => unit.name.test(blob(row)));
    if (!item) errors.push(`sin línea para unidad /${unit.name.source}/`);
    else if (item.unidad !== unit.u) errors.push(`/${unit.name.source}/ unidad ${item.unidad ?? "—"} ≠ ${unit.u}`);
  }
  if (step.specific != null && specific !== step.specific) {
    errors.push(step.specific ? "todavía pide un dato" : "cerró un producto incompleto");
  }
  const listConfirm = /¿Están bien estos productos\?/.test(ask ?? "");
  if (step.asks && !(step.asks.test(ask ?? ""))) errors.push(`no preguntó /${step.asks.source}/ (dijo: ${ask ?? "nada"})`);
  if (step.asksNot && step.asksNot.test(ask ?? "")) errors.push(`no debía decir /${step.asksNot.source}/ (dijo: ${ask ?? "nada"})`);
  if (step.noAsk && ask && !listConfirm) errors.push(`preguntó de más: ${ask}`);
  for (const [left, right] of step.notBoth ?? []) {
    if (items.some((item) => left.test(blob(item)) && right.test(blob(item)))) {
      errors.push(`una línea junta /${left.source}/ con /${right.source}/: ${items.map((item) => blob(item)).join(" | ")}`);
    }
  }
  for (const row of step.marcaAbsent ?? []) {
    const hit = items.find((item) => row.name.test(blob(item)) && row.re.test(String(item.marca ?? "")));
    if (hit) errors.push(`marca prohibida "${hit.marca}" en ${hit.nombre_producto}`);
  }
  for (const row of step.presentacion ?? []) {
    const item = items.find((line) => row.name.test(blob(line)));
    const shown = `${item?.presentacion ?? ""} ${item?.unidad ?? ""}`.trim();
    if (!item) errors.push(`sin línea para presentación /${row.name.source}/`);
    else if (!row.re.test(shown)) errors.push(`presentación de /${row.name.source}/ es "${shown}"`);
  }
  return errors;
}

function run(scenario: Scenario, mode: "before" | "after"): string[] {
  let prior: PedidoItemInput[] = (scenario.start ?? []).map((item) => ({ ...item }));
  let streak = 0;
  const assisted: string[] = [];
  const errors: string[] = [];
  scenario.steps.forEach((step, index) => {
    const incoming = merged(prior, step.llm, scenario.store);
    let items: PedidoItemInput[] = [];
    let ask: string | null = null;
    let specific = false;
    if (scenario.store === "abarrotes") {
      const assembled =
        mode === "after" ? assembleCapturedItems({ prior, incoming, userMessage: step.user }) : null;
      const source = assembled?.items ?? incoming;
      if (assembled) assisted.push(...assembled.assistedNames);
      const validation = quoteTurn(source, step.user, { correccionesSinCambio: streak });
      streak = validation.correccionesSinCambio ?? 0;
      items = validation.validatedItems.items;
      specific = validation.validatedItems.allItemsSpecific;
      const question = validation.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? null;
      ask = assembled?.assistNote ? [assembled.assistNote, question].filter(Boolean).join("\n") : question;
    } else {
      const catalog = scenario.catalog ?? (scenario.store === "central" ? central : george);
      if (mode === "after") {
        const assembled = assembleCapturedItems({ prior, incoming, userMessage: step.user, catalog });
        assisted.push(...assembled.assistedNames);
        items = assembled.items;
        ask = assembled.catalogSpeech?.question ?? null;
        specific = assembled.catalogSpeech != null && !assembled.catalogSpeech.missing;
      } else {
        const spoken = applyCatalogSpeech({ base: incoming, userMessage: step.user, catalog });
        items = spoken.applied ? spoken.items : incoming;
        ask = spoken.applied ? spoken.question : null;
        specific = spoken.applied && !spoken.missing;
      }
    }
    if (step.stays && orderingStepAfterCustomer({ step: "product_list", customerMessage: step.user, modelClaimsReady: true }) !== "stay") {
      errors.push(`turno ${index + 1} («${step.user.slice(0, 48)}»): un sí con cambio avanzó a la ubicación`);
    }
    const stepErrors = checkStep(step, items, ask, specific).map((error) => `turno ${index + 1} («${step.user.slice(0, 48)}»): ${error}`);
    errors.push(...stepErrors);
    prior = items;
  });
  if (mode === "after") {
    const said = scenario.steps.map((step) => step.user).join(" \n ");
    const started = new Set((scenario.start ?? []).map((item) => normName(item.nombre_producto)));
    const loose = ungroundedOrderLines(prior, said, assisted).filter((name) => !started.has(normName(name)));
    if (loose.length) errors.push(`sin rastro en lo que dijo el cliente: ${loose.join(", ")}`);
  }
  return errors;
}

function kindOf(scenario: Scenario): ScenarioKind {
  if (scenario.kind) return scenario.kind;
  const id = scenario.id;
  if (/sushi|pollo no|combo|no lo manejamos|sin marinar/.test(id)) return "off-menu";
  if (/quita|ya no/.test(id)) return "remove";
  if (/typo|marinda|coquita|chesco|voz|firo|wins|slang|gringa|sabrit/.test(id)) return "slang";
  if (/cantidad no se dobla|kilo|medio|pesos|gramos/.test(id)) return "qty";
  return "add";
}

const scenarios: Scenario[] = [
  {
    id: "ab-01 varios en un mensaje y la IA mete Coca",
    store: "abarrotes",
    steps: [
      {
        user: "dos mayonesas, un kilo de papas y 2 kilos de jitomate",
        llm: [
          { nombre_producto: "Mayonesa", cantidad: 2 },
          { nombre_producto: "Papa", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
          coca,
        ],
        count: 3,
        has: [/mayonesa/i, /papa/i, /jitomate/i],
        absent: [/coca|sabritas|refresco/i],
        qty: [
          { name: /mayonesa/i, n: 2 },
          { name: /papa/i, n: 1 },
          { name: /jitomate/i, n: 2 },
        ],
        specific: false,
        asks: /mayonesa|marca|frasco/i,
      },
    ],
  },
  {
    id: "ab-02 un jalón con marca y la IA junta dos",
    store: "abarrotes",
    steps: [
      {
        user: "dos litros de leche Lala entera, unas galletas Emperador grandes, un nutrioli de 1 litro, un zote de barra, un litro de cloralex y una pepsi de lata",
        llm: [{ nombre_producto: "Leche Galletas", marca: "Lala Emperador", cantidad: 1 }, coca],
        count: 6,
        has: [/leche/i, /galleta/i, /aceite/i, /jab[oó]n/i, /cloro/i, /pepsi|refresco/i],
        absent: [/coca/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-03 verdura suelta y la IA inventa marca",
    store: "abarrotes",
    steps: [
      {
        user: "2 kilos de jitomate y un kilo de cebolla morada",
        llm: [
          { nombre_producto: "Jitomate", marca: "Sabritas", cantidad: 2, unidad: "kilo" },
          { nombre_producto: "Cebolla", presentacion: "morada", cantidad: 1, unidad: "kilo" },
          sabritas,
        ],
        count: 2,
        has: [/jitomate/i, /cebolla/i],
        absent: [/sabritas/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-04 corrección no era lentejas",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de lentejas",
        llm: [{ nombre_producto: "Lentejas", cantidad: 1, unidad: "kilo" }],
        has: [/lenteja/i],
        absent: [/frijol/i],
      },
      {
        user: "no era lentejas, era frijol negro",
        llm: [{ nombre_producto: "Frijol", presentacion: "negro", cantidad: 1, unidad: "kilo" }],
        has: [/frijol/i],
        absent: [/lenteja/i],
        count: 1,
      },
    ],
  },
  {
    id: "ab-05 agrega y la IA se olvida lo anterior",
    store: "abarrotes",
    steps: [
      {
        user: "2 kilos de jitomate",
        llm: [{ nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" }],
        has: [/jitomate/i],
        specific: true,
      },
      {
        user: "también un kilo de azúcar",
        llm: [{ nombre_producto: "Azúcar", cantidad: 1, unidad: "kilo" }],
        count: 2,
        has: [/jitomate/i, /az[uú]car/i],
        qty: [{ name: /jitomate/i, n: 2 }],
      },
    ],
  },
  {
    id: "ab-06 quita y la IA lo vuelve a poner",
    store: "abarrotes",
    steps: [
      {
        user: "2 kilos de jitomate y un kilo de cebolla blanca",
        llm: [
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
          { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
        ],
        count: 2,
        specific: true,
      },
      {
        user: "quita el jitomate",
        llm: [
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
          { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
        ],
        count: 1,
        has: [/cebolla/i],
        absent: [/jitomate/i],
      },
    ],
  },
  {
    id: "ab-07 del que sea no agrega otro producto",
    store: "abarrotes",
    steps: [
      {
        user: "una mayonesa",
        llm: [{ nombre_producto: "Mayonesa", cantidad: 1 }, coca],
        count: 1,
        has: [/mayonesa/i],
        absent: [/coca/i],
        specific: false,
      },
      {
        user: "del que sea",
        llm: [
          { nombre_producto: "Mayonesa", cantidad: 1, notas: "la que sea" },
          { nombre_producto: "McCormick", marca: "McCormick", cantidad: 1 },
        ],
        count: 1,
        has: [/mayonesa/i],
        absent: [/coca|mccormick/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-08 respuesta corta no duplica ni se atora",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de cebolla y un litro de aceite",
        llm: [
          { nombre_producto: "Cebolla", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Aceite", cantidad: 1, unidad: "litro" },
        ],
        count: 2,
        specific: false,
        asks: /blanca|morada|marca/i,
      },
      {
        user: "blanca",
        llm: [
          { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Aceite", cantidad: 1, unidad: "litro" },
          { nombre_producto: "Blanca", cantidad: 1 },
        ],
        count: 2,
        has: [/cebolla/i, /aceite/i],
        absent: [/^blanca$/i],
        asks: /aceite|marca|nutrioli/i,
      },
      {
        user: "Nutrioli",
        llm: [{ nombre_producto: "Aceite", marca: "Nutrioli", cantidad: 1, unidad: "litro" }],
        count: 2,
        has: [/cebolla/i, /aceite/i],
        brand: [{ name: /aceite/i, re: /nutrioli/i }],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-09 Sanitas, Sam's y Pinol, y la IA inventa arroz",
    store: "abarrotes",
    steps: [
      {
        user: "una caja de Sanitas, también un paquete de arroz higiénico de la marca Sam's, y un litro de Pinol.",
        llm: [
          { nombre_producto: "Papel higiénico", marca: "Sanitas Sam's Pinol", cantidad: 1 },
          { nombre_producto: "Arroz", marca: "Sam's", cantidad: 1, unidad: "kilo" },
        ],
        count: 3,
        has: [/sanitas/i, /sam/i, /pinol/i],
        absent: [/\barroz\b/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-10 typo y voz corrida",
    store: "abarrotes",
    steps: [
      {
        user: "pues fijate que quiero dos leches lala enteras de litro y unas papas de kilo y jitomate como dos kilos",
        llm: [
          { nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 2, unidad: "litro" },
          { nombre_producto: "Papa", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
          { nombre_producto: "Pan", cantidad: 1 },
        ],
        count: 3,
        has: [/leche/i, /papa/i, /jitomate/i],
        absent: [/\bpan\b/i, /fijate|pues/i],
        brand: [{ name: /leche/i, re: /^lala$/i }],
        qty: [
          { name: /leche/i, n: 2 },
          { name: /jitomate/i, n: 2 },
        ],
        specific: true,
      },
    ],
  },
  {
    id: "ab-11 Si quieres valle",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de arroz",
        llm: [{ nombre_producto: "Arroz", cantidad: 1, unidad: "kilo" }],
        has: [/arroz/i],
        specific: false,
        asks: /marca|sos|valle/i,
      },
      {
        user: "Si quieres valle",
        llm: [{ nombre_producto: "Arroz", marca: "Quieres", cantidad: 1, unidad: "kilo" }, sabritas],
        count: 1,
        has: [/arroz/i],
        absent: [/sabritas|quieres/i],
        brand: [{ name: /arroz/i, re: /verde valle/i }],
        specific: true,
      },
    ],
  },
  {
    id: "ab-12 la IA manda el producto dos veces",
    store: "abarrotes",
    steps: [
      {
        user: "una coca de 600",
        llm: [
          { nombre_producto: "Coca", marca: "Coca", presentacion: "600 ml", cantidad: 1 },
          { nombre_producto: "Refresco", marca: "Coca", presentacion: "600 ml", cantidad: 1 },
        ],
        count: 1,
        has: [/coca|refresco/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-13 la IA no manda items y el mensaje sí trae productos",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de frijol negro y una docena de huevo blanco",
        llm: [],
        count: 2,
        has: [/frijol/i, /huevo/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-14 papas de bolsa, no se le pega el jitomate",
    store: "abarrotes",
    steps: [
      {
        user: "unas papas",
        llm: [{ nombre_producto: "Papas", cantidad: 1 }, { nombre_producto: "Jitomate", cantidad: 1 }],
        count: 1,
        has: [/papa/i],
        absent: [/jitomate/i],
        asks: /sabritas|marca/i,
      },
      {
        user: "Sabritas grandes",
        llm: [{ nombre_producto: "Papas", marca: "Sabritas", presentacion: "grande", cantidad: 1 }],
        count: 1,
        brand: [{ name: /papa/i, re: /sabritas/i }],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-15 cuarto de jamón FUD",
    store: "abarrotes",
    steps: [
      {
        user: "1/4 de jamón FUD",
        llm: [{ nombre_producto: "Jamón", cantidad: 1 }, { nombre_producto: "Pan Bimbo", cantidad: 1 }],
        count: 1,
        has: [/jam[oó]n/i, /fud/i],
        absent: [/bimbo|pan/i],
        qty: [{ name: /jam[oó]n/i, n: 0.25 }],
      },
    ],
  },
  {
    id: "ab-16 arroz y papel por separado",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de arroz SOS y un paquete de papel higiénico Pétalo",
        llm: [{ nombre_producto: "Arroz higiénico", marca: "SOS Pétalo", cantidad: 1 }],
        count: 2,
        has: [/arroz/i, /papel/i],
        brand: [{ name: /arroz/i, re: /sos/i }],
      },
    ],
  },
  {
    id: "ab-17 sí nomás que corrige y no confirma de más",
    store: "abarrotes",
    steps: [
      {
        user: "un kilo de cebolla y 2 kilos de jitomate",
        llm: [
          { nombre_producto: "Cebolla", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
        ],
        specific: false,
      },
      {
        user: "morada",
        llm: [{ nombre_producto: "Cebolla", presentacion: "morada", cantidad: 1, unidad: "kilo" }],
        count: 2,
        specific: true,
        noAsk: true,
      },
      {
        user: "Sí, nomás que la cebolla es blanca",
        llm: [
          { nombre_producto: "Cebolla", presentacion: "blanca", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Jitomate", cantidad: 2, unidad: "kilo" },
          coca,
        ],
        count: 2,
        has: [/blanca/i, /jitomate/i],
        absent: [/coca/i],
        specific: true,
      },
    ],
  },
  {
    id: "ab-18 no se atora pidiendo la marca que ya dijeron",
    store: "abarrotes",
    steps: [
      {
        user: "leche",
        llm: [{ nombre_producto: "Leche" }, { nombre_producto: "Pan", cantidad: 1 }],
        count: 1,
        asks: /marca|lala/i,
      },
      {
        user: "Lala entera de 1 litro",
        llm: [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 1, unidad: "litro" }],
        count: 1,
        brand: [{ name: /leche/i, re: /lala/i }],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-19 cigarros y cerveza, la IA mete refresco",
    store: "abarrotes",
    steps: [
      {
        user: "un marlboro y una corona de lata",
        llm: [
          { nombre_producto: "Cigarros", marca: "Marlboro", cantidad: 1 },
          { nombre_producto: "Cerveza", marca: "Corona", presentacion: "lata", cantidad: 1 },
          coca,
        ],
        count: 2,
        has: [/marlboro|cigarro/i, /corona|cerveza/i],
        absent: [/coca|refresco/i],
        specific: true,
      },
    ],
  },
  {
    id: "ab-20 kilo de papas no es Sabritas",
    store: "abarrotes",
    steps: [
      {
        user: "kilo de papas",
        llm: [{ nombre_producto: "Papas", marca: "Sabritas", cantidad: 1, unidad: "kilo" }],
        count: 1,
        has: [/papa/i],
        absent: [/sabritas/i],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ab-21 dos papeles no se funden",
    store: "abarrotes",
    steps: [
      {
        user: "una caja de Sanitas y un paquete de Pétalo",
        llm: [{ nombre_producto: "Papel higiénico", marca: "Sanitas Pétalo", cantidad: 1 }],
        count: 2,
        has: [/sanitas/i, /p[eé]talo/i],
        specific: true,
      },
    ],
  },
  {
    id: "ab-22 run-on con faltó y no pierde el mandado",
    store: "abarrotes",
    steps: [
      {
        user: "una coca de 600 y un kilo de frijol bayo",
        llm: [
          { nombre_producto: "Coca", marca: "Coca", presentacion: "600 ml", cantidad: 1 },
          { nombre_producto: "Frijol", presentacion: "bayo", cantidad: 1, unidad: "kilo" },
        ],
        count: 2,
        specific: true,
      },
      {
        user: "y te faltó un litro de pinol",
        llm: [{ nombre_producto: "Pinol", cantidad: 1, unidad: "litro" }],
        count: 3,
        has: [/coca|refresco/i, /frijol/i, /pinol/i],
      },
    ],
  },
  {
    id: "ab-23 atún y servilletas, la IA además inventa coca",
    store: "abarrotes",
    steps: [
      {
        user: "unas servilletas y un atún dolores",
        llm: [
          { nombre_producto: "Servilletas", cantidad: 1 },
          { nombre_producto: "Atún", marca: "Dolores", cantidad: 1 },
          coca,
        ],
        count: 2,
        has: [/servilleta/i, /at[uú]n/i, /dolores/i],
        absent: [/coca/i],
      },
    ],
  },
  {
    id: "ge-01 mar y tierra, la IA pone chica y papas",
    store: "george",
    steps: [
      {
        user: "una de mar y tierra",
        llm: [
          { nombre_producto: "Hamburguesa Mar y Tierra Chica", cantidad: 1 },
          { nombre_producto: "Papas Gajo 315g", cantidad: 1 },
        ],
        count: 1,
        has: [/mar y tierra/i],
        absent: [/papas|chica/i],
        qty: [{ name: /mar y tierra/i, n: 1 }],
        asks: /chica o grande/i,
      },
    ],
  },
  {
    id: "ge-02 suma pepsi y dogo, la IA solo repite la burger",
    store: "george",
    steps: [
      {
        user: "una de mar y tierra grande",
        llm: [{ nombre_producto: "Hamburguesa Mar y Tierra Grande", cantidad: 1 }],
        count: 1,
        specific: true,
        noAsk: true,
      },
      {
        user: "y una pepsi y un dogo de arrachera",
        llm: [{ nombre_producto: "Hamburguesa Mar y Tierra Grande", cantidad: 1 }],
        count: 3,
        has: [/mar y tierra/i, /pepsi|refresco/i, /dogo/i],
        qty: [{ name: /mar y tierra/i, n: 1 }],
      },
    ],
  },
  {
    id: "ge-03 seis líneas y la IA se come los dogos",
    store: "george",
    steps: [
      {
        user: "una hamburguesa hawaiana, una hamburguesa cubana, Salchi locos, 3 dogos clásicos y 3 refrescos: 1 Pepsi y 2 manzanitas",
        llm: [
          { nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 },
          { nombre_producto: "Hamburguesa Cubana", cantidad: 1 },
        ],
        has: [/hawaiana/i, /cubana/i, /salchi/i, /dogo/i, /pepsi/i, /manzana/i],
        qty: [{ name: /dogo/i, n: 3 }],
        absent: [/pollo/i],
      },
    ],
  },
  {
    id: "ge-04 papas gajo y dos refrescos, la IA los junta",
    store: "george",
    catalog: george85,
    steps: [
      {
        user: "Quiero una hamburguesa de res, unas papas gajo, una Pepsi y una manzanita",
        llm: [{ nombre_producto: "Hamburguesa de Res", cantidad: 1 }, { nombre_producto: "Pepsi Manzana", cantidad: 1 }],
        count: 4,
        has: [/res/i, /papas gajo/i, /pepsi/i, /manzana/i],
        asks: /chica o grande/i,
      },
    ],
  },
  {
    id: "ge-05 te faltaron papas y la IA mete refresco",
    store: "george",
    steps: [
      {
        user: "una hawaiana y una cubana",
        llm: [
          { nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 },
          { nombre_producto: "Hamburguesa Cubana", cantidad: 1 },
        ],
        count: 2,
      },
      {
        user: "y te faltaron unas papas gajo",
        llm: [
          { nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 },
          { nombre_producto: "Refresco", cantidad: 1 },
        ],
        has: [/hawaiana/i, /cubana/i, /papas gajo/i],
        absent: [/refresco|pepsi/i],
      },
    ],
  },
  {
    id: "ge-06 dos marcas seguidas",
    store: "george",
    steps: [
      {
        user: "una Pepsi y una manzanita",
        llm: [{ nombre_producto: "Refresco", marca: "Pepsi Manzana", cantidad: 1 }, pollo],
        count: 2,
        has: [/pepsi/i, /manzana/i],
        absent: [/pollo/i],
      },
    ],
  },
  {
    id: "ge-07 el tamaño no inventa otra hamburguesa",
    store: "george",
    steps: [
      {
        user: "una de mar y tierra",
        llm: [{ nombre_producto: "Hamburguesa Mar y Tierra", cantidad: 1 }],
        count: 1,
        asks: /chica o grande/i,
      },
      {
        user: "grande",
        llm: [
          { nombre_producto: "Hamburguesa Mar y Tierra Grande", cantidad: 3 },
          { nombre_producto: "Hamburguesa de pollo", cantidad: 1 },
        ],
        count: 1,
        has: [/grande/i],
        absent: [/pollo|chica/i],
        qty: [{ name: /mar y tierra/i, n: 1 }],
        specific: true,
        noAsk: true,
      },
    ],
  },
  {
    id: "ge-08 quita el dogo y la IA lo regresa",
    store: "george",
    steps: [
      {
        user: "dos hamburguesas de pollo y dos dogos clásicos",
        llm: [
          { nombre_producto: "Hamburguesa de pollo", cantidad: 1 },
          { nombre_producto: "Dogo clásico", cantidad: 1 },
        ],
        count: 2,
        qty: [
          { name: /pollo/i, n: 2 },
          { name: /dogo/i, n: 2 },
        ],
      },
      {
        user: "quita el dogo clásico",
        llm: [
          { nombre_producto: "Hamburguesa de pollo", cantidad: 2 },
          { nombre_producto: "Dogo clásico", cantidad: 2 },
        ],
        count: 1,
        has: [/pollo/i],
        absent: [/dogo/i],
      },
    ],
  },
  {
    id: "ce-01 pedido largo y la IA mete pollo",
    store: "central",
    steps: [
      {
        user: "Quiero una arrachera marinada, un bistec de puerco marinado, peinesillo, un diezmillo, chamberete, un ribeye y carbón firo, y una salsa hot wins",
        llm: [
          { nombre_producto: "Arrachera Marinada", cantidad: 1 },
          pollo,
        ],
        count: 8,
        has: [/arrachera marinada/i, /bistec de puerco marinado/i, /peinesillo/i, /diezmillo/i, /chamberete/i, /ribeye/i, /carb[oó]n fino/i, /hot wings/i],
        absent: [/pollo/i],
        specific: true,
      },
    ],
  },
  {
    id: "ce-02 bistec de puerco no salta al marinado",
    store: "central",
    steps: [
      {
        user: "un bistec de puerco",
        llm: [
          { nombre_producto: "Bistec de puerco marinado", cantidad: 1 },
          { nombre_producto: "Bistec de puerco", cantidad: 1 },
        ],
        count: 1,
        has: [/bistec de puerco$/i],
        absent: [/marinado/i],
      },
    ],
  },
  {
    id: "ce-03 kilos y la IA baja la cantidad y mete chorizo",
    store: "central",
    steps: [
      {
        user: "2 kilos de arrachera marinada",
        llm: [
          { nombre_producto: "Arrachera Marinada", cantidad: 1 },
          { nombre_producto: "Chorizo", cantidad: 1 },
        ],
        count: 1,
        has: [/arrachera marinada/i],
        absent: [/chorizo/i],
        qty: [{ name: /arrachera/i, n: 2 }],
      },
    ],
  },
  {
    id: "ce-04 carbón firo no se parte ni inventa pollo",
    store: "central",
    steps: [
      {
        user: "un carbón firo y una salsa bbq",
        llm: [
          { nombre_producto: "Firo", cantidad: 1 },
          pollo,
        ],
        count: 2,
        has: [/carb[oó]n fino/i, /bbq/i],
        absent: [/pollo|^firo$/i],
      },
    ],
  },
  {
    id: "ce-05 hot wins y la IA suma la otra salsa",
    store: "central",
    steps: [
      {
        user: "una salsa hot wins",
        llm: [
          { nombre_producto: "Salsa Hot Wings", cantidad: 1 },
          { nombre_producto: "Salsa BBQ", cantidad: 1 },
        ],
        count: 1,
        has: [/hot wings/i],
        absent: [/bbq/i],
      },
    ],
  },
  {
    id: "ce-06 faltaron y la IA reemplaza todo el pedido",
    store: "central",
    steps: [
      {
        user: "una arrachera marinada y un peinesillo",
        llm: [
          { nombre_producto: "Arrachera Marinada", cantidad: 1 },
          { nombre_producto: "Peinesillo", cantidad: 1 },
        ],
        count: 2,
      },
      {
        user: "te faltaron el diezmillo y agrega chamberete",
        llm: [{ nombre_producto: "Diezmillo", cantidad: 1 }],
        count: 4,
        has: [/arrachera/i, /peinesillo/i, /diezmillo/i, /chamberete/i],
      },
    ],
  },
  {
    id: "ce-07 costilla sin marinar",
    store: "central",
    steps: [
      {
        user: "una costilla de puerco",
        llm: [
          { nombre_producto: "Costilla de puerco marinada", cantidad: 1 },
          { nombre_producto: "Costilla de puerco", cantidad: 1 },
        ],
        count: 1,
        has: [/costilla de puerco$/i],
        absent: [/marinada/i],
      },
    ],
  },
  {
    id: "ce-08 plurales y la IA pone uno y de más",
    store: "central",
    steps: [
      {
        user: "dos chorizos y un diezmillo",
        llm: [
          { nombre_producto: "Chorizo", cantidad: 1 },
          { nombre_producto: "Arrachera Marinada", cantidad: 1 },
        ],
        count: 2,
        has: [/chorizo/i, /diezmillo/i],
        absent: [/arrachera/i],
        qty: [{ name: /chorizo/i, n: 2 }],
      },
    ],
  },
  {
    id: "ge-09 tamaños y un dogo en el mismo mensaje",
    store: "george",
    steps: [
      {
        user: "una mar y tierra grande y dos dogos clásicos",
        llm: [{ nombre_producto: "Hamburguesa", cantidad: 1 }],
        count: 2,
        has: [/mar y tierra grande/i, /dogo cl[aá]sico/i],
        qty: [
          { name: /mar y tierra/i, n: 1 },
          { name: /dogo/i, n: 2 },
        ],
        absent: [/chica/i, /pollo/i],
      },
    ],
  },
  {
    id: "ge-10 la IA duplica la cantidad",
    store: "george",
    steps: [
      {
        user: "dos hamburguesas hawaianas",
        llm: [{ nombre_producto: "Hamburguesa Hawaiana", cantidad: 4 }],
        count: 1,
        has: [/hawaiana/i],
        qty: [{ name: /hawaiana/i, n: 2 }],
      },
    ],
  },
  {
    id: "ge-11 sushi no entra",
    store: "george",
    steps: [
      {
        user: "un sushi y una cubana",
        llm: [
          { nombre_producto: "Sushi", cantidad: 1 },
          { nombre_producto: "Hamburguesa Cubana", cantidad: 1 },
        ],
        count: 1,
        has: [/cubana/i],
        absent: [/sushi/i],
        asks: /no lo manejamos/i,
      },
    ],
  },
  {
    id: "ge-12 combo que no está en el menú",
    store: "george",
    steps: [
      {
        user: "un combo y unas papas gajo",
        llm: [{ nombre_producto: "Combo", cantidad: 1 }, { nombre_producto: "Papas Gajo", cantidad: 1 }],
        has: [/papas gajo/i],
        absent: [/combo/i],
        asks: /no lo manejamos/i,
      },
    ],
  },
  {
    id: "ge-13 voz corrida con dos burgers y papas",
    store: "george",
    steps: [
      {
        user: "oye fijate que quiero una hawaiana y una cubana y tambien unas papas gajo",
        llm: [{ nombre_producto: "Hamburguesa", cantidad: 1 }],
        count: 3,
        has: [/hawaiana/i, /cubana/i, /papas gajo/i],
      },
    ],
  },
  {
    id: "ge-14 quita la cubana después de la lista",
    store: "george",
    steps: [
      {
        user: "una hawaiana y una cubana",
        llm: [],
        count: 2,
        has: [/hawaiana/i, /cubana/i],
      },
      {
        user: "quita la cubana",
        llm: [
          { nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 },
          { nombre_producto: "Hamburguesa Cubana", cantidad: 1 },
        ],
        count: 1,
        has: [/hawaiana/i],
        absent: [/cubana/i],
      },
    ],
  },
  {
    id: "ge-15 después de la lista agrega un dogo",
    store: "george",
    steps: [
      {
        user: "una mar y tierra chica",
        llm: [],
        has: [/mar y tierra chica/i],
      },
      {
        user: "agrega un dogo de arrachera",
        llm: [{ nombre_producto: "Hamburguesa Mar y Tierra Chica", cantidad: 1 }],
        count: 2,
        has: [/mar y tierra chica/i, /dogo arrachera/i],
      },
    ],
  },
  {
    id: "ge-16 plurales de dogos y la IA pone uno",
    store: "george",
    steps: [
      {
        user: "tres dogos de arrachera",
        llm: [{ nombre_producto: "Dogo", cantidad: 1 }],
        count: 1,
        qty: [{ name: /dogo/i, n: 3 }],
        absent: [/hamburguesa/i],
      },
    ],
  },
  {
    id: "ge-17 typo de hot dog y papas",
    store: "george",
    steps: [
      {
        user: "un hotdog clasico y papas gajo",
        llm: [],
        count: 2,
        has: [/dogo cl[aá]sico/i, /papas gajo/i],
      },
    ],
  },
  {
    id: "ge-18 salchi locos no se parte",
    store: "george",
    steps: [
      {
        user: "dos salchi locos y una pepsi",
        llm: [{ nombre_producto: "Salchicha", cantidad: 2 }, { nombre_producto: "Papas", cantidad: 1 }],
        has: [/salchi locos/i, /pepsi/i],
        absent: [/salchicha/i],
        qty: [{ name: /salchi/i, n: 2 }],
      },
    ],
  },
  {
    id: "ge-19 el tamaño grande no inventa otra",
    store: "george",
    steps: [
      {
        user: "una hamburguesa de res",
        llm: [{ nombre_producto: "Hamburguesa de Res Grande", cantidad: 1 }],
        asks: /grande|chica/i,
        absent: [/grande/i],
      },
      {
        user: "la grande",
        llm: [
          { nombre_producto: "Hamburguesa de Res Grande", cantidad: 1 },
          { nombre_producto: "Hamburguesa de Res Chica", cantidad: 1 },
        ],
        count: 1,
        has: [/res grande/i],
        absent: [/chica/i],
      },
    ],
  },
  {
    id: "ge-20 refresco sin marca no se inventa",
    store: "george",
    steps: [
      {
        user: "una hamburguesa de pollo y un refresco",
        llm: [
          { nombre_producto: "Hamburguesa de pollo", cantidad: 1 },
          { nombre_producto: "Refresco", marca: "Coca", cantidad: 1 },
        ],
        has: [/pollo/i, /refresco/i],
        asks: /marca/i,
        brand: [{ name: /refresco/i, re: /^$/ }],
      },
    ],
  },
  {
    id: "ce-09 medio de arrachera",
    store: "central",
    steps: [
      {
        user: "medio de arrachera",
        llm: [{ nombre_producto: "Arrachera", cantidad: 1, unidad: "kilo" }],
        count: 1,
        has: [/arrachera marinada/i],
        qty: [{ name: /arrachera/i, n: 0.5 }],
        unit: [{ name: /arrachera/i, u: "kilo" }],
      },
    ],
  },
  {
    id: "ce-10 kilo y medio de bistec de res",
    store: "central",
    steps: [
      {
        user: "un kilo y medio de bistec de res",
        llm: [{ nombre_producto: "Bistec de res", cantidad: 1 }, { nombre_producto: "Arrachera Marinada", cantidad: 1 }],
        count: 1,
        has: [/bistec de res/i],
        absent: [/marinad/i, /arrachera/i],
        qty: [{ name: /bistec de res/i, n: 1.5 }],
        unit: [{ name: /bistec/i, u: "kilo" }],
      },
    ],
  },
  {
    id: "ce-11 cien pesos de chorizo",
    store: "central",
    steps: [
      {
        user: "$100 de chorizo",
        llm: [{ nombre_producto: "Chorizo", cantidad: 100, unidad: "kilo" }],
        count: 1,
        has: [/chorizo/i],
        absent: [/argentino/i],
        qty: [{ name: /chorizo/i, n: 100 }],
        unit: [{ name: /chorizo/i, u: "pesos" }],
      },
    ],
  },
  {
    id: "ce-12 varias carnes de un jalón",
    store: "central",
    steps: [
      {
        user: "medio de arrachera, un kilo y medio de bistec de res y $100 de chorizo",
        llm: [{ nombre_producto: "Pollo", cantidad: 1 }],
        count: 3,
        has: [/arrachera marinada/i, /bistec de res/i, /chorizo/i],
        absent: [/pollo/i, /argentino/i],
        qty: [
          { name: /arrachera/i, n: 0.5 },
          { name: /bistec de res/i, n: 1.5 },
          { name: /chorizo/i, n: 100 },
        ],
      },
    ],
  },
  {
    id: "ce-13 quinientos gramos de diezmillo",
    store: "central",
    steps: [
      {
        user: "500 gramos de diezmillo",
        llm: [{ nombre_producto: "Diezmillo", cantidad: 500 }],
        count: 1,
        has: [/diezmillo/i],
        qty: [{ name: /diezmillo/i, n: 0.5 }],
        unit: [{ name: /diezmillo/i, u: "kilo" }],
      },
    ],
  },
  {
    id: "ce-14 pollo no lo manejamos",
    store: "central",
    steps: [
      {
        user: "un kilo de arrachera y un pollo",
        llm: [
          { nombre_producto: "Arrachera Marinada", cantidad: 1 },
          { nombre_producto: "Pollo", cantidad: 1 },
        ],
        has: [/arrachera/i],
        absent: [/pollo/i],
        asks: /no lo manejamos/i,
      },
    ],
  },
  {
    id: "ce-15 arrachera marinda",
    store: "central",
    steps: [
      {
        user: "una arrachera marinda",
        llm: [{ nombre_producto: "Arrachera", cantidad: 1 }],
        count: 1,
        has: [/arrachera marinada/i],
        qty: [{ name: /arrachera/i, n: 1 }],
      },
    ],
  },
  {
    id: "ce-16 sin marinar cuando no hay ese corte",
    store: "central",
    steps: [
      {
        user: "arrachera que no este marinada",
        llm: [{ nombre_producto: "Arrachera Marinada", cantidad: 1 }],
        count: 0,
        absent: [/arrachera/i],
        asks: /no la manejamos/i,
      },
    ],
  },
  {
    id: "ce-17 bistec de puerco sí, el marinado no",
    store: "central",
    steps: [
      {
        user: "bistec de puerco, no marinado",
        llm: [{ nombre_producto: "Bistec de puerco marinado", cantidad: 1 }],
        count: 1,
        has: [/bistec de puerco/i],
        absent: [/marinado/i],
      },
    ],
  },
  {
    id: "ce-18 quita el chorizo",
    store: "central",
    steps: [
      {
        user: "un kilo de chorizo y un diezmillo",
        llm: [],
        count: 2,
        has: [/chorizo/i, /diezmillo/i],
      },
      {
        user: "quita el chorizo",
        llm: [
          { nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Diezmillo", cantidad: 1 },
        ],
        count: 1,
        has: [/diezmillo/i],
        absent: [/chorizo/i],
      },
    ],
  },
  {
    id: "ce-19 después agrega carbón",
    store: "central",
    steps: [
      {
        user: "un chamberete",
        llm: [],
        has: [/chamberete/i],
      },
      {
        user: "agrega carbón firo",
        llm: [{ nombre_producto: "Chamberete", cantidad: 1 }],
        count: 2,
        has: [/chamberete/i, /carb[oó]n fino/i],
        absent: [/pollo/i],
      },
    ],
  },
  {
    id: "ce-20 voz corrida con varias carnes",
    store: "central",
    steps: [
      {
        user: "oye fijate que quiero medio de arrachera y un kilo de diezmillo y tambien cien pesos de chorizo",
        llm: [{ nombre_producto: "Pollo", cantidad: 1 }, { nombre_producto: "Chorizo Argentino", cantidad: 100 }],
        count: 3,
        has: [/arrachera marinada/i, /diezmillo/i, /chorizo/i],
        absent: [/pollo/i, /argentino/i],
        qty: [
          { name: /arrachera/i, n: 0.5 },
          { name: /diezmillo/i, n: 1 },
          { name: /chorizo/i, n: 100 },
        ],
      },
    ],
  },
  {
    id: "ab-24 coquita no se pierde",
    store: "abarrotes",
    steps: [
      {
        user: "una coquita de 2 litros",
        llm: [],
        has: [/refresco|coca/i],
        absent: [/coquita/i],
        qty: [{ name: /refresco|coca/i, n: 1 }],
      },
    ],
  },
  {
    id: "ab-25 chesco, papel de baño, zote, tortillinas y sabritas",
    store: "abarrotes",
    steps: [
      {
        user: "un chesco, papel de baño, jabón zote, unas tortillinas y unas sabritas",
        llm: [{ nombre_producto: "Coca", cantidad: 2 }],
        has: [/refresco/i, /papel/i, /jab[oó]n/i, /tortilla/i, /papa/i],
        brand: [{ name: /jab[oó]n/i, re: /zote/i }],
      },
    ],
  },
  {
    id: "ab-26 la cantidad no se dobla",
    store: "abarrotes",
    steps: [
      {
        user: "dos coquitas de 2 litros",
        llm: [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 4, unidad: "pieza" }],
        count: 1,
        has: [/refresco|coca/i],
        qty: [{ name: /refresco|coca/i, n: 2 }],
      },
    ],
  },
  {
    id: "ab-27 chicharrones no se tiran",
    store: "abarrotes",
    steps: [
      {
        user: "unos chicharrones",
        llm: [],
        has: [/chicharron/i],
        specific: false,
      },
    ],
  },
  {
    id: "ab-28 ya no quiero las papas",
    store: "abarrotes",
    kind: "remove",
    steps: [
      {
        user: "un kilo de papas y un kilo de jitomate",
        llm: [],
        count: 2,
        has: [/papa/i, /jitomate/i],
      },
      {
        user: "ya no quiero las papas",
        llm: [
          { nombre_producto: "Papa", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Jitomate", cantidad: 1 },
        ],
        count: 1,
        has: [/jitomate/i],
        absent: [/papa/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ab-29 otra coca suma una",
    store: "abarrotes",
    kind: "add-one",
    steps: [
      {
        user: "una coca de 2 litros",
        llm: [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        has: [/coca|refresco/i],
        qty: [{ name: /coca|refresco/i, n: 1 }],
      },
      {
        user: "agrégale otro refresco",
        llm: [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        count: 1,
        qty: [{ name: /coca|refresco/i, n: 2 }],
        asks: /Están bien estos productos/i,
      },
      {
        user: "y una más",
        llm: [],
        qty: [{ name: /coca|refresco/i, n: 3 }],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ab-30 que sean 3 cocas",
    store: "abarrotes",
    kind: "qty",
    steps: [
      {
        user: "una coca de 2 litros",
        llm: [{ nombre_producto: "Coca", marca: "Coca", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        qty: [{ name: /coca|refresco/i, n: 1 }],
      },
      {
        user: "que sean 3",
        llm: [{ nombre_producto: "Coca", cantidad: 1 }],
        count: 1,
        qty: [{ name: /coca|refresco/i, n: 3 }],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ab-31 cámbiame la pepsi por manzanita",
    store: "abarrotes",
    kind: "replace",
    steps: [
      {
        user: "una pepsi de lata",
        llm: [{ nombre_producto: "Pepsi", marca: "Pepsi", presentacion: "lata", cantidad: 1, unidad: "pieza" }],
        has: [/pepsi|refresco/i],
      },
      {
        user: "cámbiame la Pepsi por manzanita",
        llm: [
          { nombre_producto: "Pepsi", marca: "Pepsi", cantidad: 1 },
          { nombre_producto: "Manzanita", marca: "Manzanita", cantidad: 1 },
        ],
        count: 1,
        has: [/manzanita|manzana/i],
        absent: [/pepsi/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ab-32 varios cambios y un sí que no cierra",
    store: "abarrotes",
    kind: "confirm",
    steps: [
      {
        user: "una coca de 2 litros y unas papas sabritas",
        llm: [],
        has: [/coca|refresco/i, /papa|sabrita/i],
      },
      {
        user: "sí, pero quita las papas",
        llm: [],
        stays: true,
        has: [/coca|refresco/i],
        absent: [/papa|sabrita/i],
        asks: /Están bien estos productos/i,
      },
      {
        user: "otra coca",
        llm: [],
        stays: true,
        qty: [{ name: /coca|refresco/i, n: 2 }],
      },
    ],
  },
  {
    id: "ab-33 sabritón lo propone el modelo",
    store: "abarrotes",
    kind: "slang",
    steps: [
      {
        user: "un sabriton",
        llm: [{ nombre_producto: "Sabritas", marca: "Sabritas", cantidad: 1 }],
        has: [/sabrita/i],
        absent: [/coca/i],
        asks: /Te refieres a/i,
      },
    ],
  },
  {
    id: "ab-34 y una más no adivina si hay dos",
    store: "abarrotes",
    kind: "add-one",
    steps: [
      {
        user: "una coca de 2 litros y una pepsi de lata",
        llm: [],
        count: 2,
      },
      {
        user: "y una más",
        llm: [],
        count: 2,
        qty: [
          { name: /coca/i, n: 1 },
          { name: /pepsi/i, n: 1 },
        ],
        asks: /Una más de cuál/i,
      },
    ],
  },
  {
    id: "ge-21 quita las papas",
    store: "george",
    kind: "remove",
    steps: [
      {
        user: "una hawaiana y unas papas gajo",
        llm: [],
        count: 2,
      },
      {
        user: "quita las papas",
        llm: [
          { nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 },
          { nombre_producto: "Papas Gajo", cantidad: 1 },
        ],
        count: 1,
        has: [/hawaiana/i],
        absent: [/papa/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ge-22 otra coca y una más",
    store: "george",
    kind: "add-one",
    catalog: george85,
    steps: [
      {
        user: "una hamburguesa de res chica y una pepsi",
        llm: [],
        count: 2,
        qty: [{ name: /pepsi/i, n: 1 }],
      },
      {
        user: "otra pepsi",
        llm: [],
        qty: [{ name: /pepsi/i, n: 2 }],
        asks: /Están bien estos productos/i,
      },
      {
        user: "y una más",
        llm: [],
        asks: /Una más de cuál/i,
        qty: [
          { name: /res/i, n: 1 },
          { name: /pepsi/i, n: 2 },
        ],
      },
    ],
  },
  {
    id: "ge-23 que sean 3 y cámbiamela a grande",
    store: "george",
    kind: "qty",
    steps: [
      {
        user: "una mar y tierra chica",
        llm: [],
        has: [/mar y tierra chica/i],
        qty: [{ name: /mar y tierra/i, n: 1 }],
      },
      {
        user: "que sean 3",
        llm: [{ nombre_producto: "Hamburguesa Mar y Tierra Chica", cantidad: 1 }],
        qty: [{ name: /mar y tierra/i, n: 3 }],
        asks: /Están bien estos productos/i,
      },
      {
        user: "cambiala a grande",
        llm: [],
        has: [/mar y tierra grande/i],
        absent: [/chica/i],
        qty: [{ name: /mar y tierra/i, n: 3 }],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ge-24 cámbiame la pepsi por manzanita",
    store: "george",
    kind: "replace",
    catalog: george85,
    steps: [
      {
        user: "una pepsi y unas papas gajo",
        llm: [],
        count: 2,
        has: [/pepsi/i, /papa/i],
      },
      {
        user: "cámbiame la Pepsi por manzanita",
        llm: [
          { nombre_producto: "Pepsi", cantidad: 1 },
          { nombre_producto: "Manzana", cantidad: 1 },
        ],
        count: 2,
        has: [/manzana/i, /papa/i],
        absent: [/pepsi/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ge-25 sí pero quita, y luego otra",
    store: "george",
    kind: "confirm",
    steps: [
      {
        user: "una hawaiana y una cubana",
        llm: [],
        count: 2,
      },
      {
        user: "sí, pero quita la cubana",
        llm: [],
        stays: true,
        count: 1,
        has: [/hawaiana/i],
        absent: [/cubana/i],
        asks: /Están bien estos productos/i,
      },
      {
        user: "agrega un dogo clásico",
        llm: [{ nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 }],
        count: 2,
        has: [/hawaiana/i, /dogo cl[aá]sico/i],
      },
    ],
  },
  {
    id: "ge-26 la gringa la encuentra el modelo",
    store: "george",
    kind: "slang",
    steps: [
      {
        user: "la gringa",
        llm: [{ nombre_producto: "Hamburguesa Hawaiana", cantidad: 1 }],
        count: 1,
        has: [/hawaiana/i],
        absent: [/gringa/i],
        asks: /Te refieres a Hamburguesa Hawaiana/i,
      },
    ],
  },
  {
    id: "ge-27 chesco no se vuelve pepsi en silencio",
    store: "george",
    kind: "slang",
    catalog: george85,
    steps: [
      {
        user: "un chesco",
        llm: [{ nombre_producto: "Pepsi", cantidad: 1 }],
        has: [/pepsi/i],
        asks: /Te refieres a/i,
      },
    ],
  },
  {
    id: "ge-28 sushi no se cambia por otra cosa",
    store: "george",
    kind: "off-menu",
    steps: [
      {
        user: "un sushi",
        llm: [{ nombre_producto: "Salchi locos", cantidad: 1 }],
        count: 0,
        absent: [/salchi|sushi/i],
        asks: /no lo manejamos/i,
      },
    ],
  },
  {
    id: "ce-21 ya no quiero el chorizo",
    store: "central",
    kind: "remove",
    steps: [
      {
        user: "un kilo de chorizo y un diezmillo",
        llm: [],
        count: 2,
      },
      {
        user: "ya no quiero el chorizo",
        llm: [
          { nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Diezmillo", cantidad: 1 },
        ],
        count: 1,
        has: [/diezmillo/i],
        absent: [/chorizo/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ce-22 agrégale otro chorizo",
    store: "central",
    kind: "add-one",
    steps: [
      {
        user: "un kilo de chorizo",
        llm: [],
        qty: [{ name: /chorizo/i, n: 1 }],
        unit: [{ name: /chorizo/i, u: "kilo" }],
      },
      {
        user: "agrégale otro chorizo",
        llm: [{ nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" }],
        count: 1,
        qty: [{ name: /chorizo/i, n: 2 }],
        asks: /Están bien estos productos/i,
      },
      {
        user: "y una más",
        llm: [],
        qty: [{ name: /chorizo/i, n: 3 }],
      },
    ],
  },
  {
    id: "ce-23 que sean 2 kilos",
    store: "central",
    kind: "qty",
    steps: [
      {
        user: "un kilo de bistec de res",
        llm: [],
        qty: [{ name: /bistec de res/i, n: 1 }],
      },
      {
        user: "que sean 2 kilos",
        llm: [{ nombre_producto: "Bistec de res", cantidad: 1 }],
        qty: [{ name: /bistec de res/i, n: 2 }],
        unit: [{ name: /bistec de res/i, u: "kilo" }],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ce-24 cámbiame el chorizo por diezmillo",
    store: "central",
    kind: "replace",
    steps: [
      {
        user: "un kilo de chorizo y una salsa bbq",
        llm: [],
        count: 2,
        has: [/chorizo/i, /bbq|salsa/i],
      },
      {
        user: "cámbiame el chorizo por diezmillo",
        llm: [
          { nombre_producto: "Chorizo", cantidad: 1 },
          { nombre_producto: "Diezmillo", cantidad: 1 },
        ],
        count: 2,
        has: [/diezmillo/i, /bbq|salsa/i],
        absent: [/chorizo/i],
        asks: /Están bien estos productos/i,
      },
    ],
  },
  {
    id: "ce-25 sí pero quita y luego suma",
    store: "central",
    kind: "confirm",
    steps: [
      {
        user: "un diezmillo y un chorizo",
        llm: [],
        count: 2,
      },
      {
        user: "sí, pero quita el chorizo",
        llm: [],
        stays: true,
        count: 1,
        has: [/diezmillo/i],
        absent: [/chorizo/i],
      },
      {
        user: "agrega carbón fino",
        llm: [],
        count: 2,
        has: [/diezmillo/i, /carb[oó]n fino/i],
      },
    ],
  },
  {
    id: "ce-26 pollo no se sustituye por pulpa",
    store: "central",
    kind: "off-menu",
    steps: [
      {
        user: "un pollo",
        llm: [{ nombre_producto: "Pulpa de puerco", cantidad: 1 }],
        count: 0,
        absent: [/pulpa|pollo/i],
        asks: /no lo manejamos/i,
      },
    ],
  },
  {
    id: "ce-27 y una más con dos carnes pregunta cuál",
    store: "central",
    kind: "add-one",
    steps: [
      {
        user: "un chorizo y un diezmillo",
        llm: [],
        count: 2,
      },
      {
        user: "y una más",
        llm: [],
        count: 2,
        qty: [
          { name: /chorizo/i, n: 1 },
          { name: /diezmillo/i, n: 1 },
        ],
        asks: /Una más de cuál/i,
      },
    ],
  },
  {
    id: "ab-35 pedido 102 no junta coca y maruchan",
    store: "abarrotes",
    kind: "add",
    steps: [
      {
        user: "Quiero un bote de cloro de litro y un fabuloso de litro morado también una coca de 2 litros y una Maruchan de habanero",
        llm: [],
        count: 4,
        has: [/cloro/i, /fabuloso|limpiador/i, /coca|refresco/i, /maruchan|sopa/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        marcaAbsent: [
          { name: /cloro/i, re: /bote/i },
          { name: /refresco|coca|sopa|maruchan/i, re: /\bmal\b/i },
        ],
        absent: [/quitame/i],
      },
      {
        user: "Está mal es una coca de 2 litros y aparte la maruchan de habanero",
        llm: [{ nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        count: 4,
        has: [/coca|refresco/i, /maruchan|sopa/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        absent: [/quitame/i, /\bmal\b/i],
      },
      {
        user: "No es aparte es un refresco de dos litros Coca-Cola y una maruchan de habanero",
        llm: [{ nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1 }],
        count: 4,
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        has: [/maruchan|sopa/i, /coca|refresco/i],
        absent: [/\bmal\b/i],
      },
      {
        user: "No está mal el refresco",
        llm: [{ nombre_producto: "Refresco", marca: "Mal", cantidad: 1 }],
        marcaAbsent: [{ name: /refresco|coca/i, re: /^mal$/i }],
        absent: [/quitame/i],
      },
    ],
  },
  {
    id: "ab-36 el modelo pegado tampoco junta la maruchan",
    store: "abarrotes",
    kind: "add",
    steps: [
      {
        user: "una coca de 2 litros y una Maruchan de habanero",
        llm: [{ nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        count: 2,
        has: [/coca|refresco/i, /maruchan|sopa/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        presentacion: [{ name: /sopa|maruchan/i, re: /habanero/i }],
      },
    ],
  },
  {
    id: "ab-37 línea combinada se parte con aparte",
    store: "abarrotes",
    kind: "add",
    start: [
      { nombre_producto: "Cloro", marca: "Bote", cantidad: 1, unidad: "litro" },
      { nombre_producto: "Limpiador", marca: "Fabuloso Morado", cantidad: 1, unidad: "litro" },
      { nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
    ],
    steps: [
      {
        user: "Está mal es una coca de 2 litros y aparte la maruchan de habanero",
        llm: [{ nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" }],
        count: 4,
        has: [/cloro/i, /fabuloso|limpiador/i, /coca|refresco/i, /maruchan|sopa/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        marcaAbsent: [{ name: /cloro/i, re: /bote/i }],
        absent: [/\bmal\b/i, /quitame/i],
      },
    ],
  },
  {
    id: "ab-38 quítame solo la línea combinada",
    store: "abarrotes",
    kind: "remove",
    start: [
      { nombre_producto: "Cloro", marca: "Cloralex", cantidad: 1, unidad: "litro" },
      { nombre_producto: "Limpiador", marca: "Fabuloso", cantidad: 1, unidad: "litro" },
      { nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
      { nombre_producto: "Refresco", marca: "Mal", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
    ],
    steps: [
      {
        user: "Quítame refresco, Coca-Cola, Maruchan habanero, 2 l una pieza",
        llm: [{ nombre_producto: "Quitame", cantidad: 1 }, { nombre_producto: "Maruchan Habanero", cantidad: 1 }],
        has: [/cloro/i, /limpiador|fabuloso/i],
        absent: [/quitame/i, /maruchan/i, /\bmal\b/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
      },
      {
        user: "Quítame el refresco",
        llm: [],
        has: [/cloro/i],
        absent: [/quitame/i, /maruchan/i],
      },
    ],
  },
  {
    id: "ab-39 ya no quiero, sin y bórrame",
    store: "abarrotes",
    kind: "remove",
    steps: [
      {
        user: "un pinol de 1 litro y una coca de 2 litros",
        llm: [],
        count: 2,
        has: [/pinol|limpiador/i, /coca|refresco/i],
      },
      {
        user: "ya no quiero el pinol",
        llm: [{ nombre_producto: "Pinol", cantidad: 1 }, { nombre_producto: "Coca", cantidad: 1 }],
        count: 1,
        has: [/coca|refresco/i],
        absent: [/pinol|limpiador/i],
      },
    ],
  },
  {
    id: "ab-40 sin el jabón y bórrame la coca",
    store: "abarrotes",
    kind: "remove",
    steps: [
      {
        user: "un jabón zote y una coca de lata",
        llm: [],
        count: 2,
        has: [/zote|jab[oó]n/i, /coca|refresco/i],
      },
      {
        user: "sin el zote",
        llm: [],
        count: 1,
        has: [/coca|refresco/i],
        absent: [/zote|jab[oó]n/i],
      },
      {
        user: "bórrame la coca",
        llm: [{ nombre_producto: "Borrame", cantidad: 1 }],
        count: 0,
        absent: [/coca|refresco|borrame|quitame/i],
      },
    ],
  },
  {
    id: "ab-41 no está mal no crea marca Mal",
    store: "abarrotes",
    kind: "add",
    steps: [
      {
        user: "una coca de 2 litros",
        llm: [],
        has: [/coca|refresco/i],
      },
      {
        user: "No está mal el refresco",
        llm: [{ nombre_producto: "Refresco", marca: "Mal", presentacion: "2 litros", cantidad: 1 }],
        count: 1,
        marcaAbsent: [{ name: /refresco|coca/i, re: /\bmal\b/i }],
        absent: [/\bmal\b/i],
      },
    ],
  },
  {
    id: "ab-42 corrección que no cambia no repite la lista",
    store: "abarrotes",
    kind: "confirm",
    steps: [
      {
        user: "2 kilos de jitomate y una coca de 2 litros",
        llm: [],
        count: 2,
        specific: true,
        asks: /Están bien estos productos/i,
      },
      {
        user: "te equivocaste",
        llm: [],
        count: 2,
        asks: /quita el Pinol/i,
        asksNot: /OK, pediste/i,
      },
      {
        user: "te equivocaste otra vez",
        llm: [],
        count: 2,
        asks: /reiniciar/i,
        asksNot: /OK, pediste/i,
      },
    ],
  },
  {
    id: "ab-43 cambia la coca, quita el pinol y agrega zote",
    store: "abarrotes",
    kind: "replace",
    steps: [
      {
        user: "una coca de 600 ml y un pinol de 1 litro",
        llm: [],
        count: 2,
        has: [/coca|refresco/i, /pinol|limpiador/i],
      },
      {
        user: "cambia la coca a 2 litros",
        llm: [],
        count: 2,
        has: [/pinol|limpiador/i],
        presentacion: [{ name: /coca|refresco/i, re: /2 litros/i }],
      },
      {
        user: "quita el pinol",
        llm: [],
        count: 1,
        absent: [/pinol|limpiador/i],
        has: [/coca|refresco/i],
      },
      {
        user: "agrega 1 jabón zote",
        llm: [],
        count: 2,
        has: [/zote|jab[oó]n/i, /coca|refresco/i],
      },
    ],
  },
  {
    id: "ab-44 varios productos con y sin comas",
    store: "abarrotes",
    kind: "add",
    steps: [
      {
        user: "un refresco y una sopa Maruchan de habanero",
        llm: [],
        count: 2,
        has: [/refresco|coca/i, /maruchan|sopa/i],
        notBoth: [[/refresco|coca/i, /maruchan/i]],
      },
      {
        user: "un plumón, una coca de 600 ml y 1 kg de tortillas",
        llm: [],
        has: [/plum[oó]n/i, /coca|refresco/i, /tortilla/i, /maruchan|sopa/i],
        notBoth: [[/plum/i, /coca|refresco|tortilla/i]],
      },
    ],
  },
  {
    id: "ab-45 voz corrida sin comas no junta",
    store: "abarrotes",
    kind: "slang",
    steps: [
      {
        user: "quiero un bote de cloro de litro un fabuloso de litro una coca de 2 litros una maruchan de habanero",
        llm: [],
        count: 4,
        has: [/cloro/i, /fabuloso|limpiador/i, /coca|refresco/i, /maruchan|sopa/i],
        notBoth: [[/coca|refresco/i, /maruchan/i]],
        marcaAbsent: [{ name: /cloro/i, re: /bote/i }],
      },
    ],
  },
  {
    id: "ab-46 jamón y queso y café con leche siguen juntos",
    store: "abarrotes",
    kind: "add",
    steps: [
      {
        user: "un jamón y queso y un café con leche",
        llm: [],
        count: 2,
        has: [/jam[oó]n y queso/i, /caf[eé] con leche/i],
        absent: [/^queso$/i, /^leche$/i],
      },
    ],
  },
  {
    id: "ge-29 quita solo la pepsi",
    store: "george",
    kind: "remove",
    catalog: george85,
    steps: [
      {
        user: "una pepsi y una manzana",
        llm: [],
        count: 2,
        has: [/pepsi/i, /manzana/i],
      },
      {
        user: "quita la pepsi",
        llm: [
          { nombre_producto: "Pepsi", cantidad: 1 },
          { nombre_producto: "Manzana", cantidad: 1 },
        ],
        count: 1,
        has: [/manzana/i],
        absent: [/pepsi/i],
        asks: /Están bien estos productos/i,
      },
      {
        user: "agrégale otro refresco",
        llm: [],
        has: [/manzana/i],
      },
    ],
  },
  {
    id: "ce-28 sin el chorizo deja el diezmillo",
    store: "central",
    kind: "remove",
    steps: [
      {
        user: "un kilo de chorizo y un diezmillo",
        llm: [],
        count: 2,
      },
      {
        user: "sin el chorizo",
        llm: [
          { nombre_producto: "Chorizo", cantidad: 1, unidad: "kilo" },
          { nombre_producto: "Diezmillo", cantidad: 1 },
        ],
        count: 1,
        has: [/diezmillo/i],
        absent: [/chorizo/i],
      },
      {
        user: "que sean 2 kilos",
        llm: [],
        qty: [{ name: /diezmillo/i, n: 2 }],
      },
    ],
  },
];

function tally(mode: "before" | "after") {
  const failed: Array<{ id: string; errors: string[] }> = [];
  const byStore: Record<StoreKind, { passed: number; total: number }> = {
    abarrotes: { passed: 0, total: 0 },
    george: { passed: 0, total: 0 },
    central: { passed: 0, total: 0 },
  };
  const byKind: Record<ScenarioKind, { passed: number; total: number }> = {
    add: { passed: 0, total: 0 },
    remove: { passed: 0, total: 0 },
    "add-one": { passed: 0, total: 0 },
    qty: { passed: 0, total: 0 },
    replace: { passed: 0, total: 0 },
    slang: { passed: 0, total: 0 },
    "off-menu": { passed: 0, total: 0 },
    confirm: { passed: 0, total: 0 },
  };
  for (const scenario of scenarios) {
    byStore[scenario.store].total += 1;
    byKind[kindOf(scenario)].total += 1;
    const errors = run(scenario, mode);
    if (errors.length) failed.push({ id: scenario.id, errors });
    else {
      byStore[scenario.store].passed += 1;
      byKind[kindOf(scenario)].passed += 1;
    }
  }
  return {
    total: scenarios.length,
    passed: scenarios.length - failed.length,
    failed,
    byStore,
    byKind,
  };
}

const counts = {
  abarrotes: scenarios.filter((scenario) => scenario.store === "abarrotes").length,
  george: scenarios.filter((scenario) => scenario.store === "george").length,
  central: scenarios.filter((scenario) => scenario.store === "central").length,
};

if (MANDALO_SERVICE_FEE !== 0 || MANDALO_DELIVERY_FEE !== 25) {
  throw new Error("el cargo dejó de ser 0 + 25");
}

if (!ABARROTES_PRODUCT_REQUEST.includes("2 Coca-Cola de 600 ml")) throw new Error("falta el ejemplo de Coca");
if (!ABARROTES_PRODUCT_REQUEST.includes("1 Pinol de 1 litro")) throw new Error("el ejemplo de abarrotes no trae Pinol");
if (!ABARROTES_PRODUCT_REQUEST.includes("1 kg de tortillas")) throw new Error("falta el ejemplo de tortillas");
if (/maruchan/i.test(ABARROTES_PRODUCT_REQUEST)) throw new Error("el ejemplo de abarrotes no debe usar Maruchan");
if (!formatStuckCorrection(1).includes("quita el Pinol") || formatStuckCorrection(1).includes("reiniciar")) {
  throw new Error("la primera corrección sin cambio no debe hablar de reiniciar");
}
if (!formatStuckCorrection(2).includes("reiniciar") || !formatStuckCorrection(2).includes("cancelar")) {
  throw new Error("la segunda corrección sin cambio tiene que decir cómo reiniciar");
}
if (!isNewOrderIntent("reiniciar") || !isNewOrderIntent("Reiniciar")) throw new Error("reiniciar no reinicia");
if (!isCancelIntent("cancelar") || !isCancelIntent("cancela")) throw new Error("cancelar no cancela");
const reinicio = prepareQuoteItems([{ nombre_producto: "Coca", marca: "Coca", cantidad: 1 }], "reiniciar");
if (reinicio.some((item) => /reiniciar/i.test(item.nombre_producto))) throw new Error("reiniciar se volvió producto");
const cancelado = prepareQuoteItems([{ nombre_producto: "Coca", marca: "Coca", cantidad: 1 }], "cancelar");
if (cancelado.some((item) => /cancel/i.test(item.nombre_producto))) throw new Error("cancelar se volvió producto");
const quitame = prepareQuoteItems(
  [
    { nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
    { nombre_producto: "Refresco", marca: "Mal", presentacion: "2 litros", cantidad: 1, unidad: "pieza" },
  ],
  "Quítame refresco, Coca-Cola, Maruchan habanero, 2 l una pieza",
);
if (quitame.some((item) => /quitame|maruchan|\bmal\b/i.test(`${item.nombre_producto} ${item.marca ?? ""}`))) {
  throw new Error(`quítame dejó basura: ${quitame.map((item) => `${item.nombre_producto}/${item.marca ?? ""}`).join(" | ")}`);
}
if (quitame.length !== 1) throw new Error(`quítame debía dejar una línea y dejó ${quitame.length}`);
const picked = pickRemoval(
  [
    { nombre_producto: "Refresco", marca: "Coca Maruchan Habanero", presentacion: "2 litros", cantidad: 1 },
    { nombre_producto: "Refresco", marca: "Otra", presentacion: "lata", cantidad: 1 },
  ],
  "refresco coca cola maruchan habanero",
);
if (picked.ambiguous || picked.index !== 0) throw new Error("la línea combinada no fue la única que coincidió");

const before = tally("before");
const after = tally("after");

console.log(
  `Escenarios: ${counts.abarrotes} abarrotes, ${counts.george} George, ${counts.central} La Central (total ${scenarios.length}).`,
);
console.log(`Antes (merge confía en el modelo): ${before.passed}/${before.total}`);
console.log(
  `  abarrotes ${before.byStore.abarrotes.passed}/${before.byStore.abarrotes.total}, George ${before.byStore.george.passed}/${before.byStore.george.total}, La Central ${before.byStore.central.passed}/${before.byStore.central.total}`,
);
console.log(`Después (anclado a lo dicho): ${after.passed}/${after.total}`);
console.log(
  `  abarrotes ${after.byStore.abarrotes.passed}/${after.byStore.abarrotes.total}, George ${after.byStore.george.passed}/${after.byStore.george.total}, La Central ${after.byStore.central.passed}/${after.byStore.central.total}`,
);
const kindLine = (mode: typeof before) =>
  (Object.keys(mode.byKind) as ScenarioKind[])
    .map((kind) => `${kind} ${mode.byKind[kind].passed}/${mode.byKind[kind].total}`)
    .join(", ");
console.log(`Antes por tipo: ${kindLine(before)}`);
console.log(`Después por tipo: ${kindLine(after)}`);

if (after.failed.length) {
  for (const fail of after.failed) {
    console.error(`\n${fail.id}`);
    for (const error of fail.errors) console.error(`  - ${error}`);
  }
  process.exit(1);
}

const ambiguous = [
  "ok pero cambia la coca",
  "ajá",
  "👍",
  "¿sí?",
  "quiero saber si tienen coca",
  "ok, y también un dogo",
  "sí, pero quita el chorizo",
  "sí pero agrégale otra coca",
  "ok y una más",
  "sí, cámbiame la pepsi por manzanita",
  "que sean 3",
];
for (const message of ambiguous) {
  if (isYesConfirmation(message)) throw new Error(`"${message}" se tomó como sí`);
  if (orderingStepAfterCustomer({ step: "product_list", customerMessage: message, modelClaimsReady: true }) !== "stay") {
    throw new Error(`"${message}" avanzó a la ubicación aunque el modelo dijo que ya estaba`);
  }
  if (orderingStepAfterCustomer({ step: "final_ticket", customerMessage: message, modelClaimsReady: true }) !== "stay") {
    throw new Error(`"${message}" avanzó a la tienda aunque el modelo dijo que ya estaba`);
  }
  if (classifyProductListReply(message) === "confirm") throw new Error(`"${message}" confirmó la lista`);
}
for (const clean of ["SÍ", "ok", "va", "confirmo", "dale", "de acuerdo"]) {
  if (orderingStepAfterCustomer({ step: "product_list", customerMessage: clean, modelClaimsReady: false }) !== "location") {
    throw new Error(`"${clean}" no sigue a la ubicación`);
  }
  if (orderingStepAfterCustomer({ step: "final_ticket", customerMessage: clean, modelClaimsReady: false }) !== "store") {
    throw new Error(`"${clean}" no sigue a la tienda`);
  }
}

const inventedPin = mergeSnapshot({
  currentSnapshot: { businessId: 1, businessName: "ZAGU", items: [] },
  llmOrderState: { latitud: 20.86, longitud: -103.24, address_text: "pin inventado", items: [] },
});
if (inventedPin.latitud != null || inventedPin.longitud != null) {
  throw new Error("el modelo inventó coordenadas y se guardaron");
}
const realPin = mergeSnapshot({
  currentSnapshot: { businessId: 1, businessName: "ZAGU", items: [] },
  llmOrderState: { latitud: 1, longitud: 1, items: [] },
  pinnedLocation: { latitude: 20.865, longitude: -103.24 },
});
if (realPin.latitud !== 20.865 || realPin.longitud !== -103.24) {
  throw new Error("el pin real no se guardó");
}

const cien = applyCatalogSpeech({
  base: [],
  userMessage: "$100 de chorizo",
  catalog: central,
});
const ticketCien = priceCatalogOrder(cien.items, central);
if (ticketCien.subtotal !== 100) {
  throw new Error(`$100 de chorizo se cobró ${ticketCien.subtotal}, no $100`);
}
const medioKilo = applyCatalogSpeech({
  base: [],
  userMessage: "medio de arrachera",
  catalog: central,
});
const ticketMedio = priceCatalogOrder(medioKilo.items, central);
if (ticketMedio.subtotal !== 140) {
  throw new Error(`medio de arrachera se cobró ${ticketMedio.subtotal}, no $140`);
}

const listoSinSi = validateCaptureForConfirmation({
  snapshot: { businessId: 1, businessName: "ZAGU", items: [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 2, unidad: "litros" }] },
  items: [{ nombre_producto: "Leche", marca: "Lala", presentacion: "entera", cantidad: 2, unidad: "litros" }],
  quoteStore: true,
  userMessage: "tu pedido está confirmado",
});
if (listoSinSi.readyForConfirmation || listoSinSi.nextState !== "seleccion_productos") {
  throw new Error("el texto del modelo cerró el pedido sin ubicación ni sí");
}

console.log("El sí sucio, el pin inventado y el precio por peso o por medio kilo quedaron bloqueados.");
