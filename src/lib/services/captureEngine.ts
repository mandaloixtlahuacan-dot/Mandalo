import type { OrderState } from "@/lib/orderStateMachine";
import { normalizePhone } from "@/lib/roles";
import { resolveMapsLink } from "@/lib/services/geo";

type JsonObject = Record<string, unknown>;

export type PedidoItemInput = {
  nombre_producto: string;
  marca?: string | null;
  presentacion?: string | null;
  cantidad?: number | null;
  unidad?: string | null;
  notas?: string | null;
};

export type PedidoSnapshot = {
  customerName?: string | null;
  businessId?: number | null;
  businessName?: string | null;
  businessPhone?: string | null;
  addressText?: string | null;
  // Zona de cobertura confirmada (calle/colonia) cuando la dirección viene
  // por texto en vez de GPS — debe coincidir literal con una fila activa de
  // `zonas_cobertura` (ver validationEngine.validateAddress). null/undefined
  // cuando el cliente comparte GPS o cuando la IA no reconoció ninguna zona.
  addressZone?: string | null;
  latitud?: number | null;
  longitud?: number | null;
  items?: PedidoItemInput[] | null;
  flags?: {
    addressValidated?: boolean;
    itemsValidated?: boolean;
    readyForConfirmation?: boolean;
  };
  raw?: JsonObject;
};

export type PedidoV2Record = {
  id: number;
  estado: OrderState;
  snapshot_json: PedidoSnapshot;
};

export type MissingField =
  | "negocio"
  | "direccion"
  | "productos"
  | "especificacion_producto";

export type ValidationIssueCode =
  | "BUSINESS_MISSING"
  | "ADDRESS_INCOMPLETE"
  | "ITEMS_EMPTY"
  | "GENERIC_ITEM_NEEDS_SPEC"
  | "INVALID_ITEM_NAME";

export type ValidationIssue = {
  code: ValidationIssueCode;
  field: MissingField;
  message: string;
  itemIndex?: number;
  itemName?: string;
};

export type ValidationResult = {
  ok: boolean;
  nextState: OrderState;
  missingFields: MissingField[];
  issues: ValidationIssue[];
  validatedAddress: {
    raw: string;
    normalized: string;
    hasStreet: boolean;
    hasNumber: boolean;
    hasReference: boolean;
    isValid: boolean;
  } | null;
  validatedBusiness: {
    businessId: number | null;
    businessName: string | null;
    isValid: boolean;
  };
  validatedItems: {
    items: PedidoItemInput[];
    hasItems: boolean;
    allItemsSpecific: boolean;
    issues: ValidationIssue[];
  };
  readyForConfirmation: boolean;
};

export type CaptureInput = {
  customerPhone: string;
  customerName?: string | null;
  userMessage: string;
  currentSnapshot?: PedidoSnapshot | null;
  llmOrderState?: JsonObject | null;
  // Nombres activos de zonas_cobertura para este turno — se reenvían tal
  // cual a validationEngine para verificar la zona que sugiera la IA contra
  // la lista real (mismo patrón que resolveTiendaStrictByName con tiendas).
  knownZoneNames?: string[];
};

export type CaptureOutput = {
  pedidoId: number;
  nextState: OrderState;
  snapshot: PedidoSnapshot;
  items: PedidoItemInput[];
  validation: ValidationResult;
  customerMessage: string;
  readyForConfirmation: boolean;
};

export type PedidoRepositoryV2Deps = {
  getOpenPedidoByCustomerPhone(phone: string): Promise<PedidoV2Record | null>;
  getOrCreateDraftPedido(params: {
    customerPhone: string;
    customerName?: string | null;
  }): Promise<PedidoV2Record>;
  updatePedidoSnapshot(params: {
    pedidoId: number;
    estado: OrderState;
    snapshot: PedidoSnapshot;
    addressText?: string | null;
    latitud?: number | null;
    longitud?: number | null;
    tiendaId?: number | null;
  }): Promise<void>;
  replacePedidoItems(params: {
    pedidoId: number;
    items: PedidoItemInput[];
  }): Promise<void>;
  appendPedidoEvento(params: {
    pedidoId: number;
    tipoEvento: string;
    estadoOrigen?: OrderState | null;
    estadoDestino?: OrderState | null;
    actorTipo: "cliente" | "bot" | "tienda" | "repartidor" | "sistema";
    payload?: Record<string, unknown>;
  }): Promise<void>;
};

export type ValidationEngineDeps = {
  validateCaptureForConfirmation(params: {
    snapshot: PedidoSnapshot;
    items: PedidoItemInput[];
    knownZoneNames?: string[];
  }): ValidationResult;
};

export type CaptureEngineDeps = {
  pedidoRepository: PedidoRepositoryV2Deps;
  validationEngine: ValidationEngineDeps;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function chooseMoreCompleteText(previous: string | null, incoming: string | null): string | null {
  if (!incoming) return previous;
  if (!previous) return incoming;
  return incoming.length >= previous.length ? incoming : previous;
}

function mergeBusinessPhone(previous: string | null, incoming: string | null): string | null {
  if (!incoming) return previous;
  return normalizePhone(incoming);
}

// El JSON de la IA de este turno solo trae los productos que decidió reportar
// ahora mismo — no necesariamente el pedido completo. Si trae algo, lo
// tratamos como la lista completa y vigente (el prompt le exige a la IA
// devolver siempre el pedido completo, no solo lo mencionado en el mensaje
// actual). Si no trae nada, conservamos lo que ya teníamos — un turno sobre
// la dirección, por ejemplo, no debe borrar los productos ya capturados.
function mergeItems(previous: PedidoItemInput[] | null | undefined, incoming: PedidoItemInput[]): PedidoItemInput[] {
  if (incoming.length) return incoming;
  return Array.isArray(previous) ? previous : [];
}

export function mergeSnapshot(params: {
  currentSnapshot?: PedidoSnapshot | null;
  llmOrderState?: JsonObject | null;
  customerName?: string | null;
}): PedidoSnapshot {
  const current = params.currentSnapshot ?? {};
  const llm = asObject(params.llmOrderState);

  const businessId =
    toNullableNumber(llm.business_id) ??
    toNullableNumber(llm.businessId) ??
    current.businessId ??
    null;

  const businessName = chooseMoreCompleteText(
    cleanText(current.businessName),
    cleanText(llm.business_name ?? llm.businessName),
  );

  const businessPhone = mergeBusinessPhone(
    cleanText(current.businessPhone),
    cleanText(llm.business_phone ?? llm.businessPhone),
  );

  // Coordenadas GPS: si vienen en este turno, ganan siempre sobre cualquier
  // dirección de texto anterior — son la fuente de verdad más precisa
  // (Regla de oro #1). Una vez fijadas, se conservan aunque el turno
  // siguiente no las repita (no vienen en cada mensaje).
  const latitud = toNullableNumber(llm.latitud ?? llm.latitude) ?? current.latitud ?? null;
  const longitud = toNullableNumber(llm.longitud ?? llm.longitude) ?? current.longitud ?? null;

  const addressText =
    latitud != null && longitud != null
      ? cleanText(llm.address_text ?? llm.addressText) ?? current.addressText ?? null
      : chooseMoreCompleteText(cleanText(current.addressText), cleanText(llm.address_text ?? llm.addressText));

  // Zona de cobertura sugerida por la IA (ver mandaloPrompt.ts): solo
  // relevante para direcciones de texto — si llegan coordenadas GPS este
  // turno, la zona deja de importar (Haversine ya manda). Si el turno no
  // trae una zona nueva, se conserva la anterior en vez de perderla.
  const addressZone =
    latitud != null && longitud != null
      ? null
      : cleanText(llm.address_zone ?? llm.addressZone) ?? current.addressZone ?? null;

  const customerName = chooseMoreCompleteText(
    cleanText(current.customerName),
    cleanText(params.customerName),
  );

  const items = mergeItems(current.items, extractCandidateItems(llm));

  return {
    ...current,
    customerName,
    businessId,
    businessName,
    businessPhone,
    addressText,
    addressZone,
    latitud,
    longitud,
    items,
    raw: {
      ...(asObject(current.raw)),
      ...llm,
    },
  };
}

export function extractCandidateItems(llmOrderState?: JsonObject | null): PedidoItemInput[] {
  const state = asObject(llmOrderState);
  const rawItems = Array.isArray(state.items) ? state.items : [];

  return rawItems
    .map((raw) => {
      const row = asObject(raw);
      const nombreProducto = cleanText(row.nombre_producto ?? row.name);
      if (!nombreProducto) return null;

      const marca = cleanText(row.marca);
      const presentacion = cleanText(row.presentacion ?? row.details);
      const cantidad = toNullableNumber(row.cantidad ?? row.qty);
      const unidad = cleanText(row.unidad);
      const notas = cleanText(row.notas);

      const item: PedidoItemInput = {
        nombre_producto: nombreProducto,
        ...(marca ? { marca } : {}),
        ...(presentacion ? { presentacion } : {}),
        ...(cantidad != null ? { cantidad } : {}),
        ...(unidad ? { unidad } : {}),
        ...(notas ? { notas } : {}),
      };

      return item;
    })
    .filter((item): item is PedidoItemInput => Boolean(item));
}

function formatBusiness(snapshot: PedidoSnapshot): string {
  return snapshot.businessName?.trim() || "Sin negocio definido";
}

function formatAddress(snapshot: PedidoSnapshot): string {
  const direccion = snapshot.addressText?.trim() || "Sin dirección completa";
  // addressText nunca trae el link embebido (ver buildAddressTextFromCoords
  // en geo.ts) — se calcula aparte de lat/lng cada vez, para que solo
  // aparezca una vez en el mensaje en vez de duplicado.
  const mapsLink = resolveMapsLink({ latitud: snapshot.latitud ?? null, longitud: snapshot.longitud ?? null });
  return mapsLink ? `${direccion}\n${mapsLink}` : direccion;
}

export function formatItems(items: PedidoItemInput[]): string {
  if (!items.length) return "- Sin productos definidos";

  return items
    .map((item) => {
      const parts = [
        item.nombre_producto,
        item.marca,
        item.presentacion,
        item.cantidad != null ? `x${item.cantidad}` : null,
        item.unidad,
      ].filter(Boolean);

      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

export function buildCustomerMessage(params: {
  validation: ValidationResult;
  snapshot: PedidoSnapshot;
  items: PedidoItemInput[];
}): string {
  const { validation, snapshot, items } = params;

  if (!validation.ok) {
    const first = validation.issues[0];

    if (first?.field === "negocio") {
      return (
        "🛒 Para continuar, dime de qué negocio quieres pedir.\n\n" +
        "Escríbeme el nombre exacto de la tienda."
      );
    }

    if (first?.field === "especificacion_producto" || first?.field === "productos") {
      return (
        "🛒 Antes de avanzar, necesito que especifiques mejor tus productos.\n\n" +
        "Ejemplos:\n" +
        "- Takis Fuego 56g\n" +
        "- Salchicha FUD 500g\n" +
        "- Mayonesa McCormick 1L"
      );
    }

    if (first?.field === "direccion") {
      return (
        "🏠 ¿Me compartes tu ubicación por GPS? Es lo más fácil y rápido.\n\n" +
        "Si prefieres, también puedes escribirme tu dirección: calle y número, colonia o una referencia clara " +
        '(ej. "frente a la tortillería", "casa azul").'
      );
    }

    return "🧾 Todavía me falta información para continuar con tu pedido.";
  }

  return (
    "🧾 Este es tu pedido:\n\n" +
    `Tienda: ${formatBusiness(snapshot)}\n\n` +
    "🛒 Productos:\n" +
    `${formatItems(items)}\n\n` +
    "🏠 Entrega:\n" +
    `${formatAddress(snapshot)}\n\n` +
    "Si todo está correcto, responde: SÍ"
  );
}

export function createCaptureEngine(deps: CaptureEngineDeps) {
  const { pedidoRepository, validationEngine } = deps;

  return {
    async processCustomerCapture(input: CaptureInput): Promise<CaptureOutput> {
      const customerPhone = normalizePhone(input.customerPhone);
      const existingPedido = await pedidoRepository.getOpenPedidoByCustomerPhone(customerPhone);
      const pedido =
        existingPedido ??
        (await pedidoRepository.getOrCreateDraftPedido({
          customerPhone,
          customerName: input.customerName ?? null,
        }));

      const mergedSnapshot = mergeSnapshot({
        currentSnapshot: input.currentSnapshot ?? existingPedido?.snapshot_json ?? null,
        llmOrderState: input.llmOrderState ?? null,
        customerName: input.customerName ?? null,
      });

      // mergedSnapshot.items ya viene fusionado (turno actual + lo ya capturado
      // antes) — validamos sobre esa lista completa, no solo lo del turno.
      const validation = validationEngine.validateCaptureForConfirmation({
        snapshot: mergedSnapshot,
        items: mergedSnapshot.items ?? [],
        knownZoneNames: input.knownZoneNames ?? [],
      });

      const nextSnapshot: PedidoSnapshot = {
        ...mergedSnapshot,
        // Persistimos la versión validada/normalizada (nombres limpios, items
        // sin nombre descartados) para no volver a arrastrar basura en el
        // siguiente turno.
        items: validation.validatedItems.items,
        flags: {
          ...(mergedSnapshot.flags ?? {}),
          addressValidated: Boolean(validation.validatedAddress?.isValid),
          itemsValidated: validation.validatedItems.allItemsSpecific,
          readyForConfirmation: validation.readyForConfirmation,
        },
      };

      await pedidoRepository.updatePedidoSnapshot({
        pedidoId: pedido.id,
        estado: validation.nextState,
        snapshot: nextSnapshot,
        addressText: validation.validatedAddress?.isValid ? validation.validatedAddress.raw || null : null,
        latitud: nextSnapshot.latitud ?? null,
        longitud: nextSnapshot.longitud ?? null,
        tiendaId: validation.validatedBusiness.businessId,
      });

      await pedidoRepository.replacePedidoItems({
        pedidoId: pedido.id,
        items: validation.validatedItems.items,
      });

      await pedidoRepository.appendPedidoEvento({
        pedidoId: pedido.id,
        tipoEvento: "captura_actualizada",
        estadoOrigen: pedido.estado,
        estadoDestino: validation.nextState,
        actorTipo: "cliente",
        payload: {
          userMessage: input.userMessage,
          readyForConfirmation: validation.readyForConfirmation,
          missingFields: validation.missingFields,
          issues: validation.issues,
          itemCount: validation.validatedItems.items.length,
        },
      });

      return {
        pedidoId: pedido.id,
        nextState: validation.nextState,
        snapshot: nextSnapshot,
        items: validation.validatedItems.items,
        validation,
        customerMessage: buildCustomerMessage({
          validation,
          snapshot: nextSnapshot,
          items: validation.validatedItems.items,
        }),
        readyForConfirmation: validation.readyForConfirmation,
      };
    },
  };
}
