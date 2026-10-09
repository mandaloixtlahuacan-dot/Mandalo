import type { StoreKind } from "@/lib/categoryCopy";
import { formatStuckCorrection } from "@/lib/customerUx";
import { formatCheckedLine } from "@/lib/messageStyle";
import type { OrderState } from "@/lib/orderStateMachine";
import { isProductListRequest, messageCorrectsOrder } from "@/lib/messages";
import { pendingEditNote } from "@/lib/orderEdits";
import { advanceQuoteTurn, type PendingAsk } from "@/lib/clarificationAnswers";
import type { ListaProducto } from "@/lib/storeProductList";
import {
  isGuidedQuoteItem,
  quoteItemNeedsDetail,
  quoteLineSignature,
} from "@/lib/quoteProductClarity";
import {
  ADDRESS_ASK_MESSAGE,
  formatProductListConfirm,
  formatSpecificItemLine,
  type PedidoItemInput,
  type PedidoSnapshot,
  type ValidationIssue,
  type ValidationResult,
} from "@/lib/services/captureEngine";

const GENERIC_PRODUCTS = new Set([
  "salchichas",
  "papas",
  "takis",
  "mayonesa",
  "coca",
  "refresco",
  "hielos",
  "pan",
  "leche",
  "jamon",
  "jamón",
  "queso",
  "cigarros",
  "cerveza",
  "agua",
]);

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function isGenericProductName(name: string): boolean {
  return GENERIC_PRODUCTS.has(name.toLowerCase().trim());
}

export function validateBusiness(snapshot: PedidoSnapshot): ValidationResult["validatedBusiness"] {
  const businessId = snapshot.businessId ?? null;
  const businessName = cleanText(snapshot.businessName);

  // Requiere el ID real de la tienda, no solo el nombre en texto libre: sin
  // ID, mandaloFlow.upsertPedidoTienda nunca crea la fila en pedido_tiendas,
  // y sin esa fila no hay teléfono al que mandar la cotización — el pedido
  // llegaría a confirmacion_cliente y se quedaría esperando para siempre
  // (bug raíz reportado en Mandalo_Brief_Final_ClaudeCode_2.md, sección 7).
  return {
    businessId,
    businessName,
    isValid: businessId != null,
  };
}

// Normaliza un nombre de zona para comparar ("Calle Venustiano Carranza" ->
// "venustiano carranza") — quita acentos, mayúsculas, el prefijo genérico
// (calle/colonia/boulevard/avenida) y cualquier paréntesis aclaratorio como
// el "(Ixtlahuacán del Río)" de la entrada "Centro". Mismo criterio en
// ambos lados de la comparación (BD y lo que sugiere la IA).
function normalizeZoneName(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/^(calle|colonia|col\.?|boulevard|blvd\.?|avenida|av\.?)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateAddress(
  addressText?: string | null,
  coords?: { latitud?: number | null; longitud?: number | null } | null,
  zone?: { addressZone?: string | null; knownZoneNames?: string[] } | null,
): ValidationResult["validatedAddress"] {
  const raw = cleanText(addressText) ?? "";
  const normalized = raw.toLowerCase();
  const hasStreet = raw.length >= 10;
  const hasNumber = /\d/.test(raw);
  const hasReference = /(col\.?|colonia|frente|entre|esquina|referencia|cerca|junto a|cp|c\.p\.)/i.test(raw);

  // Un pin de GPS real siempre cuenta como dirección válida — es más preciso
  // que cualquier heurística de texto libre (Regla de oro #1).
  const hasCoords =
    typeof coords?.latitud === "number" &&
    Number.isFinite(coords.latitud) &&
    typeof coords?.longitud === "number" &&
    Number.isFinite(coords.longitud);

  // Zona de cobertura confirmada contra zonas_cobertura (mismo patrón que
  // resolveTiendaStrictByName: la IA sugiere el nombre, aquí se verifica con
  // match exacto —normalizado— contra la lista real de la BD, nunca se
  // confía en el string de la IA a ciegas). Reemplaza la vieja heurística
  // que daba por válida CUALQUIER dirección de texto suficientemente larga
  // sin verificar nunca si de verdad caía dentro del radio de cobertura —
  // hueco real de Regla de oro #1 detectado en producción (agosto 2026).
  const knownZoneNames = zone?.knownZoneNames ?? [];
  const normalizedAddressZone = zone?.addressZone ? normalizeZoneName(String(zone.addressZone)) : "";
  // Un cliente puede mencionar más de una zona conocida en el mismo mensaje
  // ("San José y Pino") — address_zone es un solo campo, así que exigir que
  // coincidiera EXACTO con una sola fila descartaba direcciones válidas para
  // siempre (sin GPS, la única otra vía a isValid), sin importar cuántos
  // detalles más diera el cliente después — bug real confirmado en
  // producción (pedido #40: nunca llegó a confirmacion_cliente esa noche).
  // Ahora basta con que alguna zona conocida aparezca dentro de lo
  // capturado, en vez de exigir coincidencia exacta de cadena completa.
  const zoneMatch =
    normalizedAddressZone.length > 0 &&
    knownZoneNames.some((known) => {
      const normalizedKnown = normalizeZoneName(known);
      return normalizedKnown.length > 0 && normalizedAddressZone.includes(normalizedKnown);
    });

  // Con la zona ya confirmada, solo falta un dato mínimo para que el
  // repartidor ubique la casa exacta — un número o una referencia clara.
  const hasMinimalDetail = raw.length >= 8 && (hasNumber || hasReference);

  return {
    raw,
    normalized,
    hasStreet,
    hasNumber,
    hasReference,
    isValid: hasCoords || (zoneMatch && hasMinimalDetail),
  };
}

export function validateItems(
  items: PedidoItemInput[],
  options?: {
    quoteStore?: boolean;
    userMessage?: string | null;
    ignoreText?: string | null;
    pendingAsk?: PendingAsk | null;
    lista?: ListaProducto[] | null;
    listaAvisos?: string[] | null;
  },
): ValidationResult["validatedItems"] & { pendingAsk?: PendingAsk | null; listaAvisos?: string[] } {
  const issues: ValidationIssue[] = [];
  const quoteStore = options?.quoteStore === true;
  const turn = quoteStore
    ? advanceQuoteTurn(items, options?.userMessage ?? "", options?.pendingAsk ?? null, {
        ignoreText: options?.ignoreText,
        lista: options?.lista,
        listaAvisos: options?.listaAvisos,
      })
    : null;
  const source = turn ? turn.items : items;
  const quoteQuestion = turn ? turn.question : null;
  let quoteQuestionUsed = false;

  const normalizedItems = source
    .map((item, itemIndex) => {
      const nombre = cleanText(item.nombre_producto);
      const marca = cleanText(item.marca);
      const presentacion = cleanText(item.presentacion);
      const unidad = cleanText(item.unidad);
      const notas = cleanText(item.notas);
      const cantidad = typeof item.cantidad === "number" && Number.isFinite(item.cantidad) ? item.cantidad : null;

      if (!nombre) {
        issues.push({
          code: "INVALID_ITEM_NAME",
          field: "productos",
          message: "Hay un producto sin nombre válido.",
          itemIndex,
        });
        return null;
      }

      const normalizedItem = {
        nombre_producto: nombre,
        ...(marca ? { marca } : {}),
        ...(presentacion ? { presentacion } : {}),
        ...(cantidad != null ? { cantidad } : {}),
        ...(unidad ? { unidad } : {}),
        ...(notas ? { notas } : {}),
      } satisfies PedidoItemInput;

      if (quoteStore && isGuidedQuoteItem(normalizedItem) && quoteItemNeedsDetail(normalizedItem)) {
        const customerQuestion = !quoteQuestionUsed ? quoteQuestion ?? undefined : undefined;
        if (customerQuestion) quoteQuestionUsed = true;
        issues.push({
          code: "GENERIC_ITEM_NEEDS_SPEC",
          field: "especificacion_producto",
          message: `El producto "${nombre}" necesita más detalle para que la tienda lo cotice.`,
          itemIndex,
          itemName: nombre,
          ...(customerQuestion ? { customerQuestion } : {}),
        });
      } else if (isGenericProductName(nombre) && !marca && !presentacion && !notas) {
        issues.push({
          code: "GENERIC_ITEM_NEEDS_SPEC",
          field: "especificacion_producto",
          message: `El producto "${nombre}" necesita marca o presentación.`,
          itemIndex,
          itemName: nombre,
        });
      }

      return normalizedItem;
    })
    .filter((item) => item !== null) as PedidoItemInput[];

  if (!normalizedItems.length) {
    issues.push({
      code: "ITEMS_EMPTY",
      field: "productos",
      message: "El pedido no tiene productos válidos.",
    });
  }

  return {
    items: normalizedItems,
    hasItems: normalizedItems.length > 0,
    allItemsSpecific: !issues.some((issue) => issue.code === "GENERIC_ITEM_NEEDS_SPEC"),
    issues,
    pendingAsk: turn?.pendingAsk ?? null,
    listaAvisos: turn?.listaAvisos ?? options?.listaAvisos ?? [],
  };
}

function decideNextState(params: {
  businessValid: boolean;
  addressValid: boolean;
  hasItems: boolean;
  allItemsSpecific: boolean;
}): OrderState {
  const ready =
    params.businessValid && params.addressValid && params.hasItems && params.allItemsSpecific;
  return ready ? "confirmacion_cliente" : "seleccion_productos";
}

export function validateCaptureForConfirmation(params: {
  snapshot: PedidoSnapshot;
  items: PedidoItemInput[];
  knownZoneNames?: string[];
  quoteStore?: boolean;
  userMessage?: string | null;
  /** Lista de antes de este turno. Si no viene, se compara contra `items`. */
  priorItems?: PedidoItemInput[] | null;
  storeKind?: StoreKind | null;
  lista?: ListaProducto[] | null;
}): ValidationResult {
  const validatedBusiness = validateBusiness(params.snapshot);
  const validatedAddress = validateAddress(
    params.snapshot.addressText,
    { latitud: params.snapshot.latitud, longitud: params.snapshot.longitud },
    { addressZone: params.snapshot.addressZone, knownZoneNames: params.knownZoneNames },
  );
  const validatedItems = validateItems(params.items, {
    quoteStore: params.quoteStore === true,
    userMessage: params.userMessage,
    ignoreText: params.snapshot.businessName,
    pendingAsk: params.snapshot.pendingAsk ?? null,
    lista: params.lista,
    listaAvisos: params.snapshot.listaAvisos,
  });

  // Orden de prioridad de issues/missingFields: tienda -> dirección -> producto,
  // igual que la regla de decisión del prompt (mandaloPrompt.ts, BLOQUE 5). Los issues de producto
  // van al final aunque validateItems los calcule primero, para que "¿qué falta
  // primero?" siempre refleje esa misma prioridad cuando falta más de una cosa.
  const issues: ValidationIssue[] = [];
  const missingFields: ValidationResult["missingFields"] = [];

  if (!validatedBusiness.isValid) {
    issues.push({
      code: "BUSINESS_MISSING",
      field: "negocio",
      message: "Falta seleccionar un negocio.",
    });
    missingFields.push("negocio");
  }

  if (!validatedAddress?.isValid) {
    issues.push({
      code: "ADDRESS_INCOMPLETE",
      field: "direccion",
      message: "La dirección está incompleta. Debe incluir calle, número y referencia.",
    });
    missingFields.push("direccion");
  }

  issues.push(...validatedItems.issues);

  if (!validatedItems.hasItems) {
    missingFields.push("productos");
  } else if (!validatedItems.allItemsSpecific) {
    missingFields.push("especificacion_producto");
  }

  const productsReady =
    validatedBusiness.isValid && validatedItems.hasItems && validatedItems.allItemsSpecific;
  const productosConfirmados = params.snapshot.flags?.productosConfirmados === true;
  const awaitingProductConfirm = params.snapshot.flags?.awaitingProductConfirm === true;
  const wantsProductList = isProductListRequest(params.userMessage ?? "");
  const revisesProducts = messageCorrectsOrder(params.userMessage ?? "");
  // Lista de productos antes del GPS. Si la dirección ya venía de antes y
  // nadie está esperando esa lista, se sigue al resumen de siempre.
  // Pedir la lista otra vez, o agregar/cambiar algo, la vuelve a mandar.
  // El GPS solo sale después de un SÍ limpio.
  const showProductList =
    productsReady &&
    ((wantsProductList && !validatedAddress?.isValid) ||
      (revisesProducts && !validatedAddress?.isValid) ||
      (!productosConfirmados && (!validatedAddress?.isValid || awaitingProductConfirm)));

  const beforeItems = params.priorItems ?? params.items;
  const linesChanged = quoteLineSignature(beforeItems) !== quoteLineSignature(validatedItems.items);
  const kind: StoreKind = params.storeKind ?? params.snapshot.storeKind ?? "abarrotes";
  const listLines = validatedItems.items.map((item) => formatCheckedLine(formatSpecificItemLine(item), item.nombre_producto));
  const priorStreak = params.snapshot.flags?.correccionesSinCambio ?? 0;
  let correccionesSinCambio = linesChanged ? 0 : priorStreak;

  if (showProductList) {
    const clarify = pendingEditNote(params.userMessage ?? "", validatedItems.items);
    const stuck = !linesChanged && revisesProducts && !clarify;
    if (stuck) correccionesSinCambio = priorStreak + 1;
    else if (linesChanged || clarify) correccionesSinCambio = 0;
    const question = stuck
      ? formatStuckCorrection(correccionesSinCambio, { kind, itemLines: listLines })
      : clarify
        ? `${clarify}\n\n${formatProductListConfirm(validatedItems.items, kind)}`
        : formatProductListConfirm(validatedItems.items, kind);
    const addressIssue = issues.find((issue) => issue.field === "direccion");
    if (addressIssue) addressIssue.customerQuestion = question;
    else {
      issues.push({
        code: "ADDRESS_INCOMPLETE",
        field: "direccion",
        message: "Falta confirmar los productos antes de pedir la dirección.",
        customerQuestion: question,
      });
    }
  } else if (productsReady && !validatedAddress?.isValid && productosConfirmados) {
    const addressIssue = issues.find((issue) => issue.field === "direccion");
    if (addressIssue && !addressIssue.customerQuestion) addressIssue.customerQuestion = ADDRESS_ASK_MESSAGE;
  }

  let nextState = decideNextState({
    businessValid: validatedBusiness.isValid,
    addressValid: Boolean(validatedAddress?.isValid),
    hasItems: validatedItems.hasItems,
    allItemsSpecific: validatedItems.allItemsSpecific,
  });
  if (showProductList) nextState = "seleccion_productos";

  return {
    ok: nextState === "confirmacion_cliente",
    nextState,
    missingFields,
    issues,
    validatedAddress,
    validatedBusiness,
    validatedItems,
    readyForConfirmation: nextState === "confirmacion_cliente",
    correccionesSinCambio,
    pendingAsk: showProductList ? null : validatedItems.pendingAsk ?? null,
    listaAvisos: validatedItems.listaAvisos ?? [],
  };
}
