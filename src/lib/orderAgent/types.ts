/** Agente de pedido con herramientas. Abarrotes, restaurante y carnicería. */

export type OrderCategory = "abarrotes" | "restaurante" | "carniceria";

export type AgentUnit = "pz" | "kg" | "pesos" | "g" | "l";

export type AgentLine = {
  lineId: string;
  productId: number | null;
  freeText: string | null;
  name: string;
  qty: number;
  unit: AgentUnit;
  variant: string | null;
  note: string | null;
  unitPrice: number | null;
  brand: string | null;
  presentation: string | null;
};

export type AgentProduct = {
  id: number;
  name: string;
  price: number | null;
  available: boolean;
  unit: "pz" | "kg";
  variants: string[];
  brand: string | null;
  presentation: string | null;
  alias: string[];
  category: string | null;
};

export type AgentStore = {
  id: number;
  name: string;
  category: OrderCategory;
  /** list = abarrotes que cotiza. fixed = menú con precio. */
  catalogMode: "list" | "fixed";
  /** true cuando la tienda tiene usa_lista_productos (Mini Super Peke's). */
  hasProductList?: boolean;
};

export type PendingAxis = "number" | "size" | "flavor" | "marinade" | "brand" | null;

/** Una duda: un producto y sus opciones reales. */
export type AgentClarification = {
  question: string;
  candidateIds: number[];
  qty: number | null;
  unit: AgentUnit | null;
  axis: PendingAxis;
  /** Búsqueda que produjo estas opciones, para recargarlas sin volver al modelo. */
  query?: string | null;
};

export type AgentPending = AgentClarification & {
  /** Las siguientes dudas. Se preguntan de una en una, cuando esta se resuelve. */
  queue?: AgentClarification[];
};

export type HistoryTurn = { role: "user" | "assistant"; text: string };

export type ToolName = "search_products" | "set_cart_line" | "remove_line" | "ask_customer" | "finish_cart";

export type ToolCall = {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
};

export type ToolTrace = {
  call: ToolCall;
  ok: boolean;
  result: unknown;
};

export type AgentModelRequest = {
  system: string;
  history: HistoryTurn[];
  cart: AgentLine[];
  store: AgentStore;
  message: string;
  toolTrace: ToolTrace[];
  repairErrors: string[];
  /** Pregunta abierta y las opciones que el cliente está viendo. */
  pending?: AgentPending | null;
};

export type AgentModelStep = {
  toolCalls: ToolCall[];
  text: string | null;
};

export type AgentModel = {
  name: string;
  complete(request: AgentModelRequest): Promise<AgentModelStep>;
};

export type OrderAgentTurnInput = {
  message: string;
  cart: AgentLine[];
  pending: AgentPending | null;
  history: HistoryTurn[];
  store: AgentStore;
  /** Menú fijo, o los candidatos ya conocidos. Abarrotes puede ir vacío y buscar. */
  products: AgentProduct[];
  search?: (query: string) => AgentProduct[] | Promise<AgentProduct[]>;
  model?: AgentModel | null;
  escalationModel?: AgentModel | null;
  pedidoId?: number | null;
  awaitingList?: boolean;
  logEvent?: (event: AgentTurnLog) => void | Promise<void>;
};

export type AgentTurnLog = {
  pedidoId: number | null;
  tipo: "agent_turn";
  input: string;
  toolCalls: ToolTrace[];
  cart: AgentLine[];
  model: string;
  validationFailures: number;
};

export type OrderAgentTurnResult = {
  cart: AgentLine[];
  pending: AgentPending | null;
  reply: string;
  confirmedList: boolean;
  storeId: number;
  model: string;
  validationFailures: number;
  toolCalls: ToolTrace[];
};
