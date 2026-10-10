export { pesosToKg, checkAiOutput } from "@/lib/catalogOrder/accept";
export { buildCatalog } from "@/lib/catalogOrder/catalog";
export { catalogEngineIsLegacy, catalogEngineMode, runCatalogOrderTurn } from "@/lib/catalogOrder/engine";
export { buildOrderPrompt, createOpenAICatalogModel, DEFAULT_ORDER_MODEL, orderJsonSchema, parseModelJson } from "@/lib/catalogOrder/parser";
export { validateModelOutput } from "@/lib/catalogOrder/validate";
export type {
  CartLine,
  CatalogMode,
  CatalogModel,
  CatalogSnapshot,
  CatalogTurnInput,
  AiOutput,
  CatalogEngineMode,
  CatalogTurnResult,
  ModelOutput,
  PendingCatalogAsk,
  RawCatalogRow,
  StoreProfile,
} from "@/lib/catalogOrder/types";
