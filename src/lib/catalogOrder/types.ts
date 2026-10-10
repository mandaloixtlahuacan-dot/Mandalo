/** Pedido contra menú cerrado (George y La Central). Abarrotes no usa estos tipos. */

export type SellUnit = "pz" | "kg" | "pesos";

export type CatalogMode = "priced" | "names_only";

export type StoreProfile = "restaurante" | "carniceria";

export type RawCatalogRow = {
  id: number;
  nombreProducto: string;
  precio: number;
  categoria?: string | null;
  alias?: string[] | null;
  disponible?: boolean;
};

export type CatalogRow = {
  id: number;
  name: string;
  precio: number;
  categoria: string | null;
  alias: string[];
  disponible: boolean;
  unit: "pz" | "kg";
  family: string;
  size: string | null;
  variants: string[];
  /** Nombre sin el paréntesis de sabores, para buscar. */
  searchName: string;
};

export type CatalogSnapshot = {
  profile: StoreProfile;
  mode: CatalogMode;
  rows: CatalogRow[];
  byId: Map<number, CatalogRow>;
};

export type CartLine = {
  productId: number;
  qty: number;
  unit: SellUnit;
  variant: string | null;
  notes: string | null;
};

export type PendingCatalogAsk = {
  sourceText: string;
  candidateIds: number[];
  qty: number;
  unit: SellUnit;
  variant: string | null;
  family: string | null;
  question: string;
  count: number;
  /** Otras líneas sin resolver, además de esta pregunta. */
  queue?: Array<{
    sourceText: string;
    candidateIds: number[];
    qty: number;
    unit: SellUnit;
    question: string;
  }>;
};

export type Unmatched = {
  source_text: string;
  reason: "ambiguous" | "not_on_menu" | "unclear";
  candidate_ids: number[];
  /** Cantidad de la línea que se rechazó, para que la respuesta no la pierda. */
  qty?: number;
  unit?: SellUnit;
};

export type ChangeOp = "add" | "set_qty" | "remove" | "replace" | "set_variant";

export type ModelChange = {
  op: ChangeOp;
  product_id: number | null;
  from_product_id: number | null;
  source_text: string;
  qty?: number | null;
  unit?: SellUnit | null;
  variant?: string | null;
};

export type ModelCartLine = {
  product_id: number;
  qty: number;
  unit: SellUnit;
  variant: string | null;
  notes: string | null;
};

export type ModelOutput = {
  intent: "order" | "edit" | "confirm" | "answer" | "question" | "other";
  cart: ModelCartLine[];
  changes: ModelChange[];
  unmatched: Unmatched[];
  confidence: "high" | "medium" | "low";
};

export type HistoryTurn = { role: "user" | "assistant"; text: string };

export type AiCartLine = {
  product_id: number;
  qty: number;
  unit: string;
  variant: string | null;
};

export type AiPendingLine = {
  text: string;
  candidate_ids: number[];
  /** Cantidad de lo que se está preguntando. Null si el modelo no la mandó. */
  qty?: number | null;
  unit?: string | null;
  /** Palabras del cliente para esa línea, no el texto de la pregunta. */
  source_text?: string | null;
};

/** @deprecated El modelo nuevo manda `pending`. Se acepta para grabaciones y pruebas viejas. */
export type AiQuestion = AiPendingLine;

/** El modelo devuelve el carrito completo. No es un delta. */
export type AiOutput = {
  cart: AiCartLine[];
  /** Líneas que todavía no se pueden anotar. Vacío cuando el pedido se puede confirmar. */
  pending?: AiPendingLine[];
  question?: AiQuestion | null;
  not_on_menu: string[];
  confirmed: boolean;
};

export type InterpretRequest = {
  catalog: CatalogSnapshot;
  cart: CartLine[];
  pending: PendingCatalogAsk | null;
  /** El motor nuevo no lo manda al modelo. Queda por compatibilidad del turno. */
  history: HistoryTurn[];
  message: string;
  /** La lista ya se mostró y un sí limpio pasa a la ubicación. */
  awaitingList?: boolean;
  /** Errores del chequeo anterior, para el único reintento. */
  repairErrors?: string[];
};

export type CatalogModel = {
  name: string;
  interpret(request: InterpretRequest): Promise<AiOutput | null>;
};

export type CatalogTurnInput = {
  message: string;
  cart: CartLine[];
  pending: PendingCatalogAsk | null;
  history: HistoryTurn[];
  catalog: CatalogSnapshot;
  /** El mensaje anterior ya mostró «¿Están bien estos productos?». */
  awaitingList?: boolean;
  model?: CatalogModel | null;
};

export type CatalogEngineMode = "legacy" | "v1" | "v2";

export type CatalogTurnResult = {
  cart: CartLine[];
  pending: PendingCatalogAsk | null;
  reply: string;
  intent: ModelOutput["intent"];
  fallback: boolean;
  model: string;
  ms: number;
  unmatched: Unmatched[];
  /** names_only: texto libre que sí se anota. priced no lo usa. */
  freeText: string[];
  /** confirm limpio de la lista: el flujo pide GPS, no otra pregunta de productos. */
  confirmedList: boolean;
};
