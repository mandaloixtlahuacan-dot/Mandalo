import type { OrderState } from "@/lib/orderStateMachine";
import type {
  PedidoItemInput,
  PedidoSnapshot,
  ValidationIssue,
  ValidationResult,
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
  const zoneMatch =
    Boolean(zone?.addressZone) &&
    knownZoneNames.some((known) => normalizeZoneName(known) === normalizeZoneName(String(zone?.addressZone)));

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

export function validateItems(items: PedidoItemInput[]): ValidationResult["validatedItems"] {
  const issues: ValidationIssue[] = [];

  const normalizedItems = items
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

      if (isGenericProductName(nombre) && !marca && !presentacion && !notas) {
        issues.push({
          code: "GENERIC_ITEM_NEEDS_SPEC",
          field: "especificacion_producto",
          message: `El producto "${nombre}" necesita marca o presentación.`,
          itemIndex,
          itemName: nombre,
        });
      }

      return {
        nombre_producto: nombre,
        ...(marca ? { marca } : {}),
        ...(presentacion ? { presentacion } : {}),
        ...(cantidad != null ? { cantidad } : {}),
        ...(unidad ? { unidad } : {}),
        ...(notas ? { notas } : {}),
      } satisfies PedidoItemInput;
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
}): ValidationResult {
  const validatedBusiness = validateBusiness(params.snapshot);
  const validatedAddress = validateAddress(
    params.snapshot.addressText,
    { latitud: params.snapshot.latitud, longitud: params.snapshot.longitud },
    { addressZone: params.snapshot.addressZone, knownZoneNames: params.knownZoneNames },
  );
  const validatedItems = validateItems(params.items);

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

  const nextState = decideNextState({
    businessValid: validatedBusiness.isValid,
    addressValid: Boolean(validatedAddress?.isValid),
    hasItems: validatedItems.hasItems,
    allItemsSpecific: validatedItems.allItemsSpecific,
  });

  return {
    ok: nextState === "confirmacion_cliente",
    nextState,
    missingFields,
    issues,
    validatedAddress,
    validatedBusiness,
    validatedItems,
    readyForConfirmation: nextState === "confirmacion_cliente",
  };
}
