import { applyCatalogSpeech } from "@/lib/catalogOrderSpeech";
import type { CatalogPriceRow } from "@/lib/catalogQuantities";
import { formatPreConfirmFeeNote } from "@/lib/customerUx";
import { isBareOrderRejection, isCancelIntent, isNewOrderIntent, isYesConfirmation } from "@/lib/messages";
import { dropItemsNamedInRemoval } from "@/lib/quoteProductClarity";
import { formatItems, type PedidoItemInput, type PedidoSnapshot } from "@/lib/services/captureEngine";
import { resolveMapsLink } from "@/lib/services/geo";
import { validateCaptureForConfirmation } from "@/lib/services/validationEngine";

export type ConfirmationAmendmentPlan =
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "keep" }
  | {
      kind: "amend";
      pedidoId: number;
      items: PedidoItemInput[];
      nextState: "confirmacion_cliente" | "seleccion_productos";
      readyForConfirmation: boolean;
      question: string | null;
    };

function itemSignature(items: PedidoItemInput[]): string {
  return JSON.stringify(
    items.map((item) => ({
      n: item.nombre_producto ?? "",
      m: item.marca ?? "",
      p: item.presentacion ?? "",
      c: item.cantidad ?? null,
      u: item.unidad ?? "",
      o: item.notas ?? "",
    })),
  );
}

function addressAlreadyCaptured(snapshot: PedidoSnapshot): boolean {
  const hasCoords =
    typeof snapshot.latitud === "number" &&
    Number.isFinite(snapshot.latitud) &&
    typeof snapshot.longitud === "number" &&
    Number.isFinite(snapshot.longitud);
  return hasCoords || String(snapshot.addressText ?? "").trim().length > 0;
}

export function renderPedidoSummary(params: {
  pedidoId: number;
  snapshot: PedidoSnapshot;
  items?: PedidoItemInput[] | null;
  feeNote?: string | null;
  pricedLines?: string | null;
}): string {
  const snapshot = params.snapshot;
  const tienda = String(snapshot.businessName ?? "").trim() || "(sin tienda)";
  const direccionBase = String(snapshot.addressText ?? "").trim() || "(sin dirección)";
  const mapsLink = resolveMapsLink({ latitud: snapshot.latitud ?? null, longitud: snapshot.longitud ?? null });
  const direccion = mapsLink ? `${direccionBase}\n${mapsLink}` : direccionBase;
  const items = params.pricedLines?.trim() || formatItems(params.items ?? snapshot.items ?? []);
  const fee = params.feeNote?.trim() || formatPreConfirmFeeNote("cotiza_tienda");
  return `🧾 Pedido #${params.pedidoId}\n\nTienda: ${tienda}\n\n🛒 Productos:\n${items}\n\n${fee}\n\n🏠 Entrega:\n${direccion}`;
}

/**
 * Durante confirmacion_cliente, un sí confirma. Un mensaje que agrega o
 * cambia productos se queda en el mismo pedido: une las líneas nuevas con
 * las que ya estaban. Cancelar, "pedido nuevo" y un pin sin texto no entran
 * aquí — el flujo de siempre los atiende antes o los deja como están.
 */
export function planConfirmationAmendment(params: {
  pedidoId: number;
  message: string;
  snapshot: PedidoSnapshot;
  quoteStore: boolean;
  knownZoneNames?: string[];
  catalog?: CatalogPriceRow[] | null;
}): ConfirmationAmendmentPlan {
  const message = String(params.message ?? "");
  if (isYesConfirmation(message)) return { kind: "confirm" };
  if (isBareOrderRejection(message)) return { kind: "cancel" };
  if (!message.trim() || isCancelIntent(message) || isNewOrderIntent(message)) return { kind: "keep" };

  const current = params.snapshot.items ?? [];
  const placeReady = addressAlreadyCaptured(params.snapshot) && params.snapshot.businessId != null;

  if (!params.quoteStore) {
    let items = current.map((item) => ({ ...item }));
    let missing = false;
    let question: string | null = null;
    if (params.catalog?.length) {
      const spoken = applyCatalogSpeech({ base: items, userMessage: message, catalog: params.catalog });
      if (spoken.applied) {
        items = spoken.items;
        missing = spoken.missing;
        question = spoken.question;
      }
    }
    items = dropItemsNamedInRemoval(items, message);
    if (itemSignature(items) === itemSignature(current)) return { kind: "keep" };
    const readyForConfirmation = !missing && items.length > 0 && placeReady;
    return {
      kind: "amend",
      pedidoId: params.pedidoId,
      items,
      nextState: readyForConfirmation ? "confirmacion_cliente" : "seleccion_productos",
      readyForConfirmation,
      question: readyForConfirmation ? null : question,
    };
  }

  const validation = validateCaptureForConfirmation({
    snapshot: params.snapshot,
    items: current,
    knownZoneNames: params.knownZoneNames ?? [],
    quoteStore: true,
    userMessage: message,
  });
  const items = validation.validatedItems.items;
  if (itemSignature(items) === itemSignature(current)) return { kind: "keep" };

  const itemsReady = validation.validatedItems.hasItems && validation.validatedItems.allItemsSpecific;
  const addressReady = Boolean(validation.validatedAddress?.isValid) || addressAlreadyCaptured(params.snapshot);
  const readyForConfirmation = itemsReady && validation.validatedBusiness.isValid && addressReady;
  const question = validation.issues.find((issue) => issue.customerQuestion)?.customerQuestion ?? null;

  return {
    kind: "amend",
    pedidoId: params.pedidoId,
    items,
    nextState: readyForConfirmation ? "confirmacion_cliente" : "seleccion_productos",
    readyForConfirmation,
    question: readyForConfirmation ? null : question,
  };
}

export function confirmationCustomerMessage(params: {
  pedidoId: number;
  snapshot: PedidoSnapshot;
  items: PedidoItemInput[];
  readyForConfirmation: boolean;
  question?: string | null;
  feeNote?: string | null;
  pricedLines?: string | null;
  scheduleNote?: string | null;
}): string {
  const body = renderPedidoSummary({
    pedidoId: params.pedidoId,
    snapshot: params.snapshot,
    items: params.items,
    feeNote: params.feeNote,
    pricedLines: params.pricedLines,
  });
  const schedule = params.scheduleNote?.trim() ? `\n\n${params.scheduleNote.trim()}` : "";
  if (params.readyForConfirmation) {
    return `${body}${schedule}\n\n¿Es correcto? Responde *SÍ* para confirmar. ✅`;
  }
  const question = params.question?.trim();
  return question ? `${body}${schedule}\n\n${question}` : `${body}${schedule}`;
}
