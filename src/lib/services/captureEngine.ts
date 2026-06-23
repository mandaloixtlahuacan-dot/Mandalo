import { normalizePhone } from "@/lib/roles";

type JsonObject = Record<string, unknown>;

export type EstadoFlujoPedido =
  | "capturando_pedido"
  | "requiere_especificacion_producto"
  | "requiere_direccion_completa"
  | "requiere_negocio"
  | "listo_para_confirmacion_cliente"
  | "confirmado_para_cotizacion"
  | "dispatch_tienda_pendiente"
  | "enviando_a_tienda"
  | "enviado_a_tienda"
  | "pendiente_respuesta_tienda"
  | "cotizacion_recibida"
  | "pendiente_aprobacion_total"
  | "confirmado_para_repartidor"
  | "dispatch_repartidor_pendiente"
  | "enviando_a_repartidor"
  | "enviado_a_repartidor"
  | "pendiente_confirmacion_repartidor"
  | "repartidor_asignado"
  | "pedido_recogido"
  | "en_camino"
  | "entregado"
  | "reasignacion_pendiente"
  | "incidencia_dispatch"
  | "incidencia_repartidor"
  | "cancelado_operativamente";

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
  flags?: {
    addressValidated?: boolean;
    itemsValidated?: boolean;
    readyForConfirmation?: boolean;
  };
  raw?: JsonObject;
};

export type PedidoV2Record = {
  id: number;
  estado_flujo: EstadoFlujoPedido;
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
  nextState: EstadoFlujoPedido;
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
  currentPedidoId?: number | null;
  currentSnapshot?: PedidoSnapshot | null;
  llmOrderState?: JsonObject | null;
};

export type CaptureOutput = {
  pedidoId: number;
  nextState: EstadoFlujoPedido;
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
    estadoFlujo: EstadoFlujoPedido;
    snapshot: PedidoSnapshot;
    direccionEntregaTexto?: string | null;
    negocioId?: number | null;
  }): Promise<void>;
  replacePedidoItems(params: {
    pedidoId: number;
    items: PedidoItemInput[];
  }): Promise<void>;
  appendPedidoEvento(params: {
    pedidoId: number;
    tipoEvento: string;
    estadoOrigen?: EstadoFlujoPedido | null;
    estadoDestino?: EstadoFlujoPedido | null;
    actorTipo: "cliente" | "sistema" | "negocio" | "repartidor" | "admin";
    payload?: Record<string, unknown>;
  }): Promise<void>;
};

export type ValidationEngineDeps = {
  validateCaptureForConfirmation(params: {
    snapshot: PedidoSnapshot;
    items: PedidoItemInput[];
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

  const addressText = chooseMoreCompleteText(
    cleanText(current.addressText),
    cleanText(llm.address_text ?? llm.addressText),
  );

  const customerName = chooseMoreCompleteText(
    cleanText(current.customerName),
    cleanText(params.customerName),
  );

  return {
    ...current,
    customerName,
    businessId,
    businessName,
    businessPhone,
    addressText,
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
  return snapshot.addressText?.trim() || "Sin dirección completa";
}

function formatItems(items: PedidoItemInput[]): string {
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
        "🏠 Para continuar, necesito una dirección más completa.\n\n" +
        "Incluye calle, número y una referencia o colonia."
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

      const candidateItems = extractCandidateItems(input.llmOrderState ?? null);
      const validation = validationEngine.validateCaptureForConfirmation({
        snapshot: mergedSnapshot,
        items: candidateItems,
      });

      const nextSnapshot: PedidoSnapshot = {
        ...mergedSnapshot,
        flags: {
          ...(mergedSnapshot.flags ?? {}),
          addressValidated: Boolean(validation.validatedAddress?.isValid),
          itemsValidated: validation.validatedItems.allItemsSpecific,
          readyForConfirmation: validation.readyForConfirmation,
        },
      };

      await pedidoRepository.updatePedidoSnapshot({
        pedidoId: pedido.id,
        estadoFlujo: validation.nextState,
        snapshot: nextSnapshot,
        direccionEntregaTexto: validation.validatedAddress?.isValid ? validation.validatedAddress.raw : null,
        negocioId: validation.validatedBusiness.businessId,
      });

      await pedidoRepository.replacePedidoItems({
        pedidoId: pedido.id,
        items: validation.validatedItems.items,
      });

      await pedidoRepository.appendPedidoEvento({
        pedidoId: pedido.id,
        tipoEvento: "captura_actualizada",
        estadoOrigen: pedido.estado_flujo,
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
