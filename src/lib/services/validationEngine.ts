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

  return {
    businessId,
    businessName,
    isValid: Boolean(businessId || businessName),
  };
}

export function validateAddress(
  addressText?: string | null,
  coords?: { latitud?: number | null; longitud?: number | null } | null,
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

  return {
    raw,
    normalized,
    hasStreet,
    hasNumber,
    hasReference,
    isValid: hasCoords || (raw.length >= 15 && hasStreet && hasNumber && hasReference),
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
}): ValidationResult {
  const validatedBusiness = validateBusiness(params.snapshot);
  const validatedAddress = validateAddress(params.snapshot.addressText, {
    latitud: params.snapshot.latitud,
    longitud: params.snapshot.longitud,
  });
  const validatedItems = validateItems(params.items);

  const issues: ValidationIssue[] = [...validatedItems.issues];
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
