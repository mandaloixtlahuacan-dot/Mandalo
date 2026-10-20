/**
 * Chequeo offline de los arreglos de confiabilidad del 15 de octubre de 2026.
 * No llama a OpenAI, Supabase ni WhatsApp.
 *
 *   npx tsx scripts/check-reliability.ts
 */
import { readFileSync } from "node:fs";
import { buildCatalog } from "../src/lib/catalogOrder/catalog";
import { buildCatalogReply } from "../src/lib/catalogOrder/reply";
import {
  formatCatalogFinalTicket,
  formatCatalogReceiptNotice,
  formatNoCourierAdmin,
  formatNoCourierCustomer,
  formatNoCourierStore,
  formatScheduledSentNotice,
  formatStoreCommandHelp,
  formatStoreOkAck,
  storesInNiche,
  type UxStore,
} from "../src/lib/customerUx";
import { canTransition } from "../src/lib/orderStateMachine";
import { extraerAcuseOk, extraerPrecioSuelto } from "../src/lib/ordenes";
import { claimAdminNotificacionesBatchArgs } from "../src/lib/repositories/outboxRepository";
import {
  catalogStepAfterList,
  GREETING_RESET_AFTER_MS,
  INACTIVE_AFTER_MS,
  INACTIVE_CANCEL_REASON,
  mayPrepareStore,
  planOutboxRetry,
  planStoreFreeText,
  priceConfirmTimeoutApplies,
  scheduledCustomerMessageOrder,
  shouldCancelBuildingForInactivity,
  shouldRestartOnGreeting,
} from "../src/lib/reliability";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

const hour = 60 * 60 * 1000;
const building = ["seleccion_productos", "confirmacion_cliente"] as const;

for (const estado of building) {
  check(`cancelar-${estado}`, canTransition(estado, "cancelado"));
  check(`inactivo-${estado}`, shouldCancelBuildingForInactivity(estado, INACTIVE_AFTER_MS + 1));
  check(`aun-activo-${estado}`, !shouldCancelBuildingForInactivity(estado, INACTIVE_AFTER_MS));
}
check("no-cancela-esperando", !shouldCancelBuildingForInactivity("esperando_apertura_tienda", INACTIVE_AFTER_MS * 2));
check("no-cancela-cotizado", !shouldCancelBuildingForInactivity("confirmado_tiendas", INACTIVE_AFTER_MS * 2));
check("sin-marca-de-tiempo", !shouldCancelBuildingForInactivity("seleccion_productos", null));
check("razon-inactivo", INACTIVE_CANCEL_REASON === "inactivo");

check(
  "saludo-viejo",
  shouldRestartOnGreeting("seleccion_productos", "Hola", GREETING_RESET_AFTER_MS + 1) &&
    shouldRestartOnGreeting("confirmacion_cliente", "Buenos días", GREETING_RESET_AFTER_MS + hour) &&
    shouldRestartOnGreeting("seleccion_productos", "buenas", GREETING_RESET_AFTER_MS + 1),
);
check("saludo-reciente", !shouldRestartOnGreeting("seleccion_productos", "hola", GREETING_RESET_AFTER_MS));
check(
  "saludo-con-pedido",
  !shouldRestartOnGreeting("seleccion_productos", "hola quiero una coca", GREETING_RESET_AFTER_MS + hour),
);
check(
  "saludo-ya-en-tienda",
  !shouldRestartOnGreeting("pendiente_tiendas", "hola", GREETING_RESET_AFTER_MS * 3),
);

check("timeout-precio-normal", priceConfirmTimeoutApplies({}));
check("timeout-precio-no-aplica", !priceConfirmTimeoutApplies({ sin_repartidor: true }));
check("sin-repartidor-se-puede-cancelar", canTransition("confirmado_tiendas", "cancelado"));

const customer = formatNoCourierCustomer(122);
const store = formatNoCourierStore(122);
const admin = formatNoCourierAdmin(122);
check("aviso-cliente", customer.startsWith("🛵 *Pedido #122*") && /no hay repartidor disponible/i.test(customer));
check("aviso-cliente-no-culpa", !/no confirmaste/i.test(customer));
check("aviso-tienda", store.startsWith("🏪 *Pedido #122*") && /no hay repartidor disponible/i.test(store));
check("aviso-tienda-no-culpa", !/no confirmó/i.test(store));
check("aviso-admin", /Pedido: 122/.test(admin) && /no hay repartidor/i.test(admin) && /Envío \$15/.test(admin) && /servicio \$10/.test(admin));

const one = planStoreFreeText({ text: "150", openOrderIds: [48] });
const money = planStoreFreeText({ text: "$150.50", openOrderIds: [48] });
const named = planStoreFreeText({ text: "ORDEN #48 PRECIO 150", openOrderIds: [48, 49] });
const ambiguous = planStoreFreeText({ text: "150", openOrderIds: [48, 49] });
const prose = planStoreFreeText({ text: "no tengo coca", openOrderIds: [48] });
const yes = planStoreFreeText({ text: "sí", openOrderIds: [48] });
const none = planStoreFreeText({ text: "150", openOrderIds: [] });
check("precio-suelto", one.action === "price" && one.action === "price" && one.pedidoId === 48 && one.amount === 150);
check("precio-con-signo", money.action === "price" && money.amount === 150.5);
check("precio-con-orden", named.action === "price" && named.pedidoId === 48 && named.amount === 150);
check("precio-ambiguo", ambiguous.action === "guide" && ambiguous.body.includes("*#48*") && ambiguous.body.includes("*#49*"));
check("texto-libre", prose.action === "guide" && /ORDEN #48 PRECIO 150/.test(prose.body));
check("si-no-es-precio", yes.action === "guide");
check("sin-pedidos", none.action === "guide" && /no tengo uno abierto/i.test(none.body));
check("ejemplo-corto", formatStoreCommandHelp([18]).includes("ORDEN #18 PRECIO 150"));
check("precio-suelto-parser", extraerPrecioSuelto("150") === 150 && extraerPrecioSuelto("no tengo") == null);
check("acuse", extraerAcuseOk("OK #18") === 18 && extraerAcuseOk("ok 49") === 49 && extraerAcuseOk("ok") == null);
check("acuse-copy", formatStoreOkAck(18).includes("*#18*") && /Anoté el OK/.test(formatStoreOkAck(18)));

const base = Date.parse("2026-10-15T12:00:00.000Z");
const first = planOutboxRetry({ attempt: 1, maxAttempts: 5, baseSeconds: 60, nowMs: base });
const second = planOutboxRetry({ attempt: 2, maxAttempts: 5, baseSeconds: 60, nowMs: base });
const fourth = planOutboxRetry({ attempt: 4, maxAttempts: 5, baseSeconds: 60, nowMs: base });
const fifth = planOutboxRetry({ attempt: 5, maxAttempts: 5, baseSeconds: 60, nowMs: base });
check("reintento-1", !first.permanent && first.estado === "fallida" && Date.parse(first.nextAttemptAt) - base === 60_000);
check("reintento-2", !second.permanent && Date.parse(second.nextAttemptAt) - base === 120_000);
check("reintento-4", !fourth.permanent && Date.parse(fourth.nextAttemptAt) - base === 480_000);
check("reintento-fin", fifth.permanent && fifth.estado === "cancelada");

const claimOpen = claimAdminNotificacionesBatchArgs({
  limit: 10,
  maxAttempts: 5,
  reclaimStaleAfterSeconds: 900,
});
const claimFiltered = claimAdminNotificacionesBatchArgs({
  limit: 3,
  maxAttempts: 5,
  pedidoId: 42,
  tipo: "alerta_admin",
});
const claimBlank = claimAdminNotificacionesBatchArgs({
  limit: 3,
  maxAttempts: 5,
  pedidoId: undefined,
  tipo: undefined,
});
check(
  "claim-sin-filtro",
  claimOpen.p_pedido_id === null &&
    claimOpen.p_tipo === null &&
    Object.prototype.hasOwnProperty.call(claimOpen, "p_pedido_id") &&
    Object.prototype.hasOwnProperty.call(claimOpen, "p_tipo"),
);
check("claim-con-filtro", claimFiltered.p_pedido_id === 42 && claimFiltered.p_tipo === "alerta_admin");
check("claim-undefined-es-null", claimBlank.p_pedido_id === null && claimBlank.p_tipo === null);

function rpcUsesClaimArgs(source: string): boolean {
  const matches = source.match(
    /rpc\(\s*"claim_admin_notificaciones_batch"\s*,\s*claimAdminNotificacionesBatchArgs\(/g,
  );
  return matches?.length === 1;
}
const adminOutboxSource = readFileSync(new URL("../src/lib/adminOutboxWorker.ts", import.meta.url), "utf8");
const outboxRepoSource = readFileSync(new URL("../src/lib/repositories/outboxRepository.ts", import.meta.url), "utf8");
check("worker-claim-pasa-args", rpcUsesClaimArgs(adminOutboxSource));
check("repo-claim-pasa-args", rpcUsesClaimArgs(outboxRepoSource));

const catalog = buildCatalog(
  [
    { id: 1, nombreProducto: "Hamburguesa de pollo", precio: 55 },
    { id: 2, nombreProducto: "Dogo clásico", precio: 40 },
  ],
  "restaurante",
);
const ticket = buildCatalogReply({
  catalog,
  cart: [{ productId: 1, qty: 1, unit: "pz", variant: null, notes: null }],
  unmatched: [],
  pending: null,
  confirmedList: false,
});
check(
  "ticket-antes-del-si",
  /Hamburguesa de pollo/.test(ticket.reply) &&
    ticket.reply.includes("$55") &&
    ticket.reply.includes("🛵 *Envío: $15*") &&
    ticket.reply.includes("servicio $10") &&
    ticket.reply.includes("*Total: $80*") &&
    /responde sí/i.test(ticket.reply) &&
    !/te mando el total|confirme el precio/i.test(ticket.reply),
  ticket.reply,
);
const afterYes = buildCatalogReply({
  catalog,
  cart: [{ productId: 1, qty: 1, unit: "pz", variant: null, notes: null }],
  unmatched: [],
  pending: null,
  confirmedList: true,
});
check("un-solo-si", afterYes.reply === "" && afterYes.pending == null);
check("falta-ubicacion", catalogStepAfterList({ confirmed: true, hasAddress: false }) === "ask_address");
check("con-ubicacion-despacha", catalogStepAfterList({ confirmed: true, hasAddress: true }) === "dispatch");
check("sin-si-se-queda", catalogStepAfterList({ confirmed: false, hasAddress: true }) === "stay");
check("no-prepara-antes", mayPrepareStore(false) === false);
check("prepara-despues", mayPrepareStore(true) === true);

const direct = formatCatalogFinalTicket({
  itemLines: ["1 Hamburguesa de pollo — $55"],
  subtotal: 55,
  kind: "restaurante",
});
check("ticket-directo", direct.includes("Envío: $15") && direct.includes("servicio $10") && /responde sí/i.test(direct) && direct.indexOf("Envío: $15") < direct.toLowerCase().indexOf("responde sí"));

const receipt = formatCatalogReceiptNotice({
  tiendaNombre: "Hamburguesas Hotdogs George",
  pedidoId: 9,
  subtotal: 55,
  total: 80,
  itemLines: ["1 Hamburguesa de pollo — $55"],
});
check(
  "recibo-sin-segundo-si",
  receipt.includes("*Pedido #9*") &&
    receipt.includes("🛵 *Envío: $15*") &&
    receipt.includes("servicio $10") &&
    receipt.includes("*Total a pagar: $80*") &&
    !/responde \*sí\*/i.test(receipt),
);

const order = scheduledCustomerMessageOrder(true);
check("orden-programado", order[0] === "ya_se_envio" && order[1] === "total");
const sent = formatScheduledSentNotice(9, "Hamburguesas Hotdogs George", true);
check("aviso-ya-se-envio", /Ya se envió/.test(sent) && !/\$\d/.test(sent) && !/total/i.test(sent));

const stores: UxStore[] = [
  { id: 1, nombre: "Abarrotes Agua Santa", categoria: "Abarrotes", telefono: "1", abierta: true, abreTexto: "", usaCatalogoFijo: false },
  { id: 2, nombre: "Abarrotes Agua Santa (PRUEBA)", categoria: "Abarrotes", telefono: "2", abierta: true, abreTexto: "", usaCatalogoFijo: false },
];
const listed = storesInNiche(stores, "abarrotes").map((store) => store.nombre);
check(
  "prueba-sigue-visible",
  listed.includes("Abarrotes Agua Santa") && listed.includes("Abarrotes Agua Santa (PRUEBA)"),
);

const dispatchSource = readFileSync(new URL("../src/lib/services/storeDispatch.ts", import.meta.url), "utf8");
const noticeAt = dispatchSource.indexOf("formatScheduledSentNotice");
const confirmAt = dispatchSource.indexOf("formatCatalogStoreConfirmRequest");
check("aviso-antes-de-pedir-confirmo", noticeAt > 0 && confirmAt > noticeAt);
check("menu-no-se-prepara-solo", !dispatchSource.includes("Prepáralo en cuanto puedas") && !dispatchSource.includes("await finalizeStoreQuote"));

const workerSource = readFileSync(new URL("../src/lib/services/orderTimeoutWorker.ts", import.meta.url), "utf8");
check(
  "worker-cubre-inactivo-y-outbox",
  workerSource.includes("processInactiveBuilding") &&
    workerSource.includes("priceConfirmTimeoutApplies") &&
    workerSource.includes("retryOutbox") &&
    workerSource.includes("await retryOutbox(summary)"),
);
const repoSource = readFileSync(new URL("../src/lib/repositories/pedidoRepositoryV2.ts", import.meta.url), "utf8");
const inactiveStart = repoSource.indexOf("export async function cancelPedidoInactivo");
const inactiveFn = repoSource.slice(inactiveStart, repoSource.indexOf("export async function", inactiveStart + 10));
check("inactivo-no-borra", inactiveFn.includes('cancelled_reason: "inactivo"') && !inactiveFn.includes("deletePedido"));
const flowSource = readFileSync(new URL("../src/lib/mandaloFlow.ts", import.meta.url), "utf8");
check(
  "despacho-de-menu-ya-confirmado",
  flowSource.includes("catalogAlreadyConfirmed: true") &&
    flowSource.includes("cancelBecauseNoCourier") &&
    flowSource.includes("extraerComandoConfirmoTienda") &&
    flowSource.includes("formatCatalogAwaitingStore"),
);
check("sin-filtro-prueba", !flowSource.includes("isHiddenTestStoreName") && !dispatchSource.includes("(PRUEBA)"));

if (failures.length) {
  console.error(`Confiabilidad: ${failures.length} fallo(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Confiabilidad: ok");
