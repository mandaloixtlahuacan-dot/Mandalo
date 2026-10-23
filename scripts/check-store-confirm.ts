/**
 * Confirmación de George/La Central y faltantes de las tres tiendas.
 * No llama a OpenAI, Supabase ni WhatsApp.
 *
 *   npx tsx scripts/check-store-confirm.ts
 */
import {
  MANDALO_HORA_CIERRE,
  checkMandaloSchedule,
  checkTiendaSchedule,
} from "../src/lib/services/businessHours";
import { MOY_HORARIO_JSON, MOY_PHONE_INTL, isCourierOnSchedule } from "../src/lib/services/courierAvailability";
import { isBotInstructionPaste } from "../src/lib/reliability";
import { buildOrderTimeoutMetadata } from "../src/lib/services/orderTimeouts";
import { calculateFinalPrice, extraerComandoNoDisponible, extraerPrecio } from "../src/lib/ordenes";
import {
  comandoConfirmoTienda,
  comandoNoHay,
  decidirConfirmacionRestante,
  extraerComandoConfirmoTienda,
  formatAbarrotesQuoteRequest,
  formatCatalogStoreConfirmRequest,
  formatProductAdjustmentReminder,
  formatStorePendingReminder,
  formatStoreQuoteTimeoutCancel,
  mensajeClienteConfirmarSinProductos,
  mensajeClientePedidoVacioPorFaltante,
  partirProductosNoDisponibles,
} from "../src/lib/storeOrderCommands";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

check("moy-es-el-numero", MOY_PHONE_INTL === "5213314705434");
check("moy-no-sabado", isCourierOnSchedule(MOY_HORARIO_JSON, new Date("2026-10-17T16:00:00.000Z")) === false);
check("moy-viernes-noche", isCourierOnSchedule(MOY_HORARIO_JSON, new Date("2026-10-17T04:30:00.000Z")) === true);
check("mandalo-2330", MANDALO_HORA_CIERRE === "23:30");
check("mandalo-abierto-21", checkMandaloSchedule(new Date("2026-10-16T03:00:00.000Z")).withinSchedule === true);
check(
  "tienda-cerrada-21",
  checkTiendaSchedule({
    horaApertura: "08:00",
    horaCierre: "21:00",
    now: new Date("2026-10-16T03:00:00.000Z"),
  }).withinSchedule === false,
);

check("confirmo-orden", extraerComandoConfirmoTienda("ORDEN #12 CONFIRMO") === 12);
check("confirmo-minusculas", extraerComandoConfirmoTienda("orden 6 confirmo.") === 6);
check("confirmo-hash", extraerComandoConfirmoTienda("#CONFIRMO 5") === 5);
check("confirmo-no-es-precio", extraerComandoConfirmoTienda("ORDEN #12 PRECIO 80") === null);
check("confirmo-no-es-faltante", extraerComandoConfirmoTienda("ORDEN #12 NO HAY coca") === null);
check("precio-sigue", extraerPrecio("ORDEN #12 PRECIO 80") === 80);

const varios = extraerComandoNoDisponible("ORDEN #12 NO HAY Coca 600, Sabritas");
check("no-hay-orden", varios?.ordenId === 12);
check("no-hay-partes", partirProductosNoDisponibles(varios?.productoTexto ?? "").join("|") === "Coca 600|Sabritas");
check("no-hay-uno", partirProductosNoDisponibles("mayonesa").join("|") === "mayonesa");
check("token-viejo", extraerComandoNoDisponible("ORDEN #12 NO_DISPONIBLE mayonesa")?.productoTexto === "mayonesa");

const catalogo = formatCatalogStoreConfirmRequest({
  pedidoId: 15,
  direccion: "Calle Hidalgo 12",
  pedidoTexto: "✅ 🍔 *1 Hamburguesa — $55*",
  subtotal: 55,
  total: calculateFinalPrice(55),
});
check("george-pide-confirmo", catalogo.includes(comandoConfirmoTienda(15)) && catalogo.includes("Confírmalo para mandarlo al repartidor"));
check("george-no-pide-precio", !/PRECIO\s+150/.test(catalogo));
check("george-documenta-no-hay", catalogo.includes(comandoNoHay(15)) && catalogo.includes("sepáralos con coma"));
check("george-fees", catalogo.includes("🛵 *Envío: $15*") && catalogo.includes("servicio $10") && catalogo.includes("*Total a pagar: $80*"));
check("george-es-eco", isBotInstructionPaste(catalogo));
check("george-eco-no-confirma", extraerComandoConfirmoTienda(catalogo) === null);

const abarrotes = formatAbarrotesQuoteRequest({ pedidoId: 7, pedidoTexto: "✅ 🥤 *Coca x1*" });
check("pekes-pide-precio", abarrotes.includes("ORDEN #7 PRECIO 150") && abarrotes.includes(comandoNoHay(7)));
check("pekes-es-eco", isBotInstructionPaste(abarrotes));
const pekesRecordatorio = formatStorePendingReminder({ pedidoId: 7, pedidoTexto: "Coca", catalogo: false });
check("pekes-recordatorio", pekesRecordatorio.includes("tu precio"));
check("pekes-recordatorio-7", pekesRecordatorio.includes("*7 minutos*"));
const menuRecordatorio = formatStorePendingReminder({ pedidoId: 15, pedidoTexto: "Hamburguesa", catalogo: true });
check(
  "menu-recordatorio",
  menuRecordatorio.includes(comandoConfirmoTienda(15)) && !menuRecordatorio.includes("PRECIO 150"),
);
check("menu-recordatorio-7", menuRecordatorio.includes("*7 minutos*"));
const desde = "2026-10-22T12:00:00.000Z";
const tiendaTimeout = buildOrderTimeoutMetadata("store_quote", desde);
check("tienda-15", tiendaTimeout.store_quote_deadline_at === "2026-10-22T12:15:00.000Z");
check("tienda-aviso-8", tiendaTimeout.store_quote_reminder_at === "2026-10-22T12:08:00.000Z");
check("tienda-aviso-una-vez", tiendaTimeout.store_quote_reminded_at === null);
const repartidorTimeout = buildOrderTimeoutMetadata("courier_confirmation", desde);
check("repartidor-10", repartidorTimeout.courier_confirmation_deadline_at === "2026-10-22T12:10:00.000Z");
check("repartidor-aviso-5", repartidorTimeout.courier_confirmation_reminder_at === "2026-10-22T12:05:00.000Z");
check("cancel-menu", formatStoreQuoteTimeoutCancel(15, true).includes("confirmarlo"));
check("cancel-abarrotes", formatStoreQuoteTimeoutCancel(7, false).includes("cotizarlo"));

const alCliente = mensajeClienteConfirmarSinProductos({
  tiendaNombre: "Hamburguesas Hotdogs George",
  faltantes: ["Pepsi", "Manzanita"],
  pedidoTexto: "- 3 dogos — $90",
  subtotal: 90,
  catalogo: true,
});
check("cliente-nombra-faltantes", alCliente.includes("*Pepsi*") && alCliente.includes("*Manzanita*"));
check("cliente-deja-el-resto", alCliente.includes("3 dogos"));
check("cliente-total", alCliente.includes("🛵 *Envío: $15*") && alCliente.includes("servicio $10") && alCliente.includes("*Total a pagar: $115*"));
check("cliente-si-no", /Responde \*SÍ\*/.test(alCliente) && / \*NO\* /.test(alCliente));
check("cliente-no-pide-cambio", !/sin él/i.test(alCliente));

const pekesCliente = mensajeClienteConfirmarSinProductos({
  tiendaNombre: "Mini Super Peke's",
  faltantes: ["Coca"],
  pedidoTexto: "✅ 🥛 *Leche x1*",
  subtotal: null,
  catalogo: false,
});
check("pekes-cliente-fees", pekesCliente.includes("🛵 *Envío: $15*") && pekesCliente.includes("servicio $10"));
check("pekes-cliente-sin-total-inventado", !pekesCliente.includes("Total a pagar"));
check("pekes-cliente-pide-precio", /confirme el precio/.test(pekesCliente));

const vacio = mensajeClientePedidoVacioPorFaltante({
  tiendaNombre: "Carnicería La Central",
  pedidoId: 6,
  faltantes: ["Diezmillo"],
});
check("vacio-cancela", vacio.includes("Diezmillo") && vacio.includes("pedido #6") && /cancel/i.test(vacio));

check("si", decidirConfirmacionRestante("sí") === "si");
check("no", decidirConfirmacionRestante("no") === "no");
check("ruido", decidirConfirmacionRestante("mejor una coca") === "repetir");
check(
  "recordatorio-si-no",
  formatProductAdjustmentReminder({ pedidoId: 9, itemNombre: "Pepsi", mode: "confirmar_restante" }).includes("*SÍ*"),
);
check(
  "recordatorio-viejo",
  formatProductAdjustmentReminder({ pedidoId: 9, itemNombre: "Pepsi", mode: null }).includes("sin él"),
);

if (failures.length) {
  console.error(`Confirmación de tienda: ${failures.length} fallo(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Confirmación de tienda: ok");
