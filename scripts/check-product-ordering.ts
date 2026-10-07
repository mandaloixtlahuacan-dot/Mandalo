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
import { classifyProductListReply, isYesConfirmation, orderingStepAfterCustomer } from "../src/lib/messages";
import { assembleCapturedItems, ungroundedOrderLines } from "../src/lib/orderGrounding";
import { MANDALO_DELIVERY_FEE, MANDALO_SERVICE_FEE } from "../src/lib/ordenes";
import { mergeSnapshot, type PedidoItemInput, type PedidoSnapshot } from "../src/lib/services/captureEngine";
import { validateCaptureForConfirmation } from "../src/lib/services/validationEngine";

type StoreKind = "abarrotes" | "george" | "central";

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
  noAsk?: boolean;
};

type Scenario = {
  id: string;
  store: StoreKind;
  catalog?: CatalogPriceRow[];
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

function merged(prior: PedidoItemInput[], llm: PedidoItemInput[], store: StoreKind): PedidoItemInput[] {
  const name = store === "abarrotes" ? "ZAGU" : store === "george" ? "George" : "Carnicería La Central";
  return (
    mergeSnapshot({
      currentSnapshot: { businessId: 1, businessName: name, items: prior },
      llmOrderState: { business_id: 1, business_name: name, items: llm },
    }).items ?? []
  );
}

function quoteTurn(items: PedidoItemInput[], user: string) {
  const snapshot: PedidoSnapshot = { businessId: 1, businessName: "ZAGU", items };
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
  if (step.noAsk && ask && !listConfirm) errors.push(`preguntó de más: ${ask}`);
  return errors;
}

function run(scenario: Scenario, mode: "before" | "after"): string[] {
  let prior: PedidoItemInput[] = [];
  const errors: string[] = [];
  scenario.steps.forEach((step, index) => {
    const incoming = merged(prior, step.llm, scenario.store);
    let items: PedidoItemInput[] = [];
    let ask: string | null = null;
    let specific = false;
    if (scenario.store === "abarrotes") {
      const source =
        mode === "after"
          ? assembleCapturedItems({ prior, incoming, userMessage: step.user }).items
          : incoming;
      const validation = quoteTurn(source, step.user);
      items = validation.validatedItems.items;
      specific = validation.validatedItems.allItemsSpecific;
      ask = validation.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? null;
    } else {
      const catalog = scenario.catalog ?? (scenario.store === "central" ? central : george);
      if (mode === "after") {
        const assembled = assembleCapturedItems({ prior, incoming, userMessage: step.user, catalog });
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
    const stepErrors = checkStep(step, items, ask, specific).map((error) => `turno ${index + 1} («${step.user.slice(0, 48)}»): ${error}`);
    errors.push(...stepErrors);
    prior = items;
  });
  if (mode === "after") {
    const said = scenario.steps.map((step) => step.user).join(" \n ");
    const loose = ungroundedOrderLines(prior, said);
    if (loose.length) errors.push(`sin rastro en lo que dijo el cliente: ${loose.join(", ")}`);
  }
  return errors;
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
];

function tally(mode: "before" | "after") {
  const failed: Array<{ id: string; errors: string[] }> = [];
  const byStore: Record<StoreKind, { passed: number; total: number }> = {
    abarrotes: { passed: 0, total: 0 },
    george: { passed: 0, total: 0 },
    central: { passed: 0, total: 0 },
  };
  for (const scenario of scenarios) {
    byStore[scenario.store].total += 1;
    const errors = run(scenario, mode);
    if (errors.length) failed.push({ id: scenario.id, errors });
    else byStore[scenario.store].passed += 1;
  }
  return {
    total: scenarios.length,
    passed: scenarios.length - failed.length,
    failed,
    byStore,
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

if (after.failed.length) {
  for (const fail of after.failed) {
    console.error(`\n${fail.id}`);
    for (const error of fail.errors) console.error(`  - ${error}`);
  }
  process.exit(1);
}

const ambiguous = ["ok pero cambia la coca", "ajá", "👍", "¿sí?", "quiero saber si tienen coca", "ok, y también un dogo"];
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
