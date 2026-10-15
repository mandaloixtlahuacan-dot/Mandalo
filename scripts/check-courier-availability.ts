/**
 * Horario de reparto, horario semanal de Mateo y Roberto, y el claim
 * del primer #CONFIRMO. No llama a OpenAI, Supabase ni WhatsApp.
 *
 *   npx tsx scripts/check-courier-availability.ts
 */
import { readFileSync } from "node:fs";
import {
  MANDALO_HORA_APERTURA,
  MANDALO_HORA_CIERRE,
  checkMandaloSchedule,
  formatHour12,
} from "../src/lib/services/businessHours";
import {
  COURIER_ORDER_TAKEN_MESSAGE,
  MATEO_HORARIO_JSON,
  MATEO_PHONE_INTL,
  ROBERTO_HORARIO_JSON,
  ROBERTO_PHONE_INTL,
  applyCourierConfirmClaim,
  buildCourierOfferMessage,
  buildCustomerCourierCoordinatingMessage,
  courierMayConfirmOffer,
  isCourierOnSchedule,
  mandaloHoursCustomerText,
  readOfferedCouriers,
  selectAvailableCouriers,
  type CourierScheduleRow,
} from "../src/lib/services/courierAvailability";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

const mateo: CourierScheduleRow = {
  id: 1,
  nombre: "Mateo",
  telefono: MATEO_PHONE_INTL,
  activo: true,
  disponible: true,
  horarioJson: MATEO_HORARIO_JSON,
};
const roberto: CourierScheduleRow = {
  id: 2,
  nombre: "Roberto",
  telefono: ROBERTO_PHONE_INTL,
  activo: true,
  disponible: true,
  horarioJson: ROBERTO_HORARIO_JSON,
};
const paul: CourierScheduleRow = {
  id: 3,
  nombre: "Paul",
  telefono: "5213311111111",
  activo: false,
  disponible: true,
  horarioJson: ROBERTO_HORARIO_JSON,
};
const roster = [mateo, roberto, paul];

function namesAt(iso: string): string[] {
  return selectAvailableCouriers(roster, new Date(iso)).map((courier) => String(courier.nombre));
}

// México está en UTC-6. 2026-10-17 es sábado. 2026-10-15 es jueves.
const saturdayMorning = "2026-10-17T15:00:00.000Z"; // 09:00
const thursdayMorning = "2026-10-15T15:00:00.000Z"; // 09:00
const thursdayAfternoon = "2026-10-15T22:00:00.000Z"; // 16:00
const sundayMorning = "2026-10-18T15:00:00.000Z"; // 09:00
const saturdayAfternoon = "2026-10-17T22:00:00.000Z"; // 16:00

check("sabado-manana-solo-mateo", namesAt(saturdayMorning).join(",") === "Mateo", namesAt(saturdayMorning).join(","));
check("entre-semana-manana-solo-roberto", namesAt(thursdayMorning).join(",") === "Roberto", namesAt(thursdayMorning).join(","));
check(
  "entre-semana-tarde-los-dos",
  namesAt(thursdayAfternoon).join(",") === "Mateo,Roberto",
  namesAt(thursdayAfternoon).join(","),
);
check("domingo-manana-solo-roberto", namesAt(sundayMorning).join(",") === "Roberto");
check("sabado-tarde-solo-mateo", namesAt(saturdayAfternoon).join(",") === "Mateo");
check("paul-sigue-fuera", !namesAt(thursdayAfternoon).includes("Paul"));
check("sin-horario-no-entra", !isCourierOnSchedule(null, new Date(thursdayAfternoon)));
check(
  "no-disponible-no-entra",
  selectAvailableCouriers([{ ...roberto, disponible: false }], new Date(thursdayMorning)).length === 0,
);

const beforeOpen = checkMandaloSchedule(new Date("2026-10-15T13:59:00.000Z")); // 07:59
const atOpen = checkMandaloSchedule(new Date("2026-10-15T14:00:00.000Z")); // 08:00
const beforeClose = checkMandaloSchedule(new Date("2026-10-16T02:59:00.000Z")); // 20:59
const atClose = checkMandaloSchedule(new Date("2026-10-16T03:00:00.000Z")); // 21:00
check("antes-de-8-cerrado", beforeOpen.withinSchedule === false);
check("a-las-8-abierto", atOpen.withinSchedule === true);
check("antes-de-9pm-abierto", beforeClose.withinSchedule === true);
check("a-las-9pm-cerrado", atClose.withinSchedule === false);
check("abre-8am", MANDALO_HORA_APERTURA === "08:00" && formatHour12(MANDALO_HORA_APERTURA) === "8am");
check("cierra-9pm", MANDALO_HORA_CIERRE === "21:00" && formatHour12(MANDALO_HORA_CIERRE) === "9pm");
check(
  "texto-al-cliente",
  mandaloHoursCustomerText(MANDALO_HORA_APERTURA, MANDALO_HORA_CIERRE) === "de 8am a 9pm",
);

let slot = { estado: "dispatch_repartidor_pendiente", repartidorId: null as number | null };
const first = applyCourierConfirmClaim(slot, roberto.id ?? 2);
slot = first.row;
const second = applyCourierConfirmClaim(slot, mateo.id ?? 1);
check("primero-gana", first.claimed && first.row.repartidorId === roberto.id && first.message == null);
check("segundo-pierde", !second.claimed && second.row.repartidorId === roberto.id);
check(
  "aviso-ya-lo-tomo",
  second.message === COURIER_ORDER_TAKEN_MESSAGE && COURIER_ORDER_TAKEN_MESSAGE === "⚠️ Ya lo tomó otro repartidor.",
);

const offered = [
  { id: mateo.id ?? null, telefono: mateo.telefono ?? "" },
  { id: roberto.id ?? null, telefono: roberto.telefono ?? "" },
];
check(
  "los-dos-pueden-confirmar",
  courierMayConfirmOffer({
    offered,
    repartidorId: null,
    currentCourierId: null,
    currentCourierPhone: "",
    courierId: mateo.id ?? null,
    courierPhone: mateo.telefono ?? "",
  }) &&
    courierMayConfirmOffer({
      offered,
      repartidorId: null,
      currentCourierId: null,
      currentCourierPhone: "",
      courierId: roberto.id ?? null,
      courierPhone: roberto.telefono ?? "",
    }),
);
check(
  "un-tercero-no",
  !courierMayConfirmOffer({
    offered,
    repartidorId: null,
    currentCourierId: null,
    currentCourierPhone: "",
    courierId: 9,
    courierPhone: "5213300000000",
  }),
);
check(
  "despues-del-claim-solo-el-ganador",
  courierMayConfirmOffer({
    offered,
    repartidorId: roberto.id ?? null,
    currentCourierId: roberto.id ?? null,
    currentCourierPhone: roberto.telefono ?? "",
    courierId: roberto.id ?? null,
    courierPhone: roberto.telefono ?? "",
  }) &&
    !courierMayConfirmOffer({
      offered,
      repartidorId: roberto.id ?? null,
      currentCourierId: roberto.id ?? null,
      currentCourierPhone: roberto.telefono ?? "",
      courierId: mateo.id ?? null,
      courierPhone: mateo.telefono ?? "",
    }),
);

const offer = buildCourierOfferMessage({
  courierName: "Roberto",
  pedidoId: 44,
  storeName: "Abarrotes",
  pickupAddress: "Centro",
  dropoffAddress: "Calle Hidalgo",
  mapsLink: null,
  itemsText: "1 Coca",
  chargeLine: "💵 *Cobrar: $50*",
  customerPhone: "5213312345678",
});
check("oferta-conserva-confirmo", offer.includes("🛵 *Hola Roberto, tienes un nuevo pedido*") && offer.includes("#CONFIRMO 44"));
check("oferta-sigue-con-recogi", offer.includes("#RECOGI 44") && offer.includes("#ENTREGADO 44"));

const oneCustomer = buildCustomerCourierCoordinatingMessage({ pedidoId: 44, etaText: "4:20 p.m.", courierNames: ["Mateo"] });
const twoCustomer = buildCustomerCourierCoordinatingMessage({
  pedidoId: 44,
  etaText: "4:20 p.m.",
  courierNames: ["Mateo", "Roberto"],
});
check("cliente-un-repartidor", oneCustomer.includes("con *Mateo*") && oneCustomer.includes("Te aviso en cuanto confirme."));
check(
  "cliente-dos-repartidores",
  !twoCustomer.includes("con *Mateo*") && twoCustomer.includes("Te aviso en cuanto un repartidor confirme."),
);

const notified = readOfferedCouriers({
  offered_couriers: [
    { id: 1, nombre: "Mateo", telefono: MATEO_PHONE_INTL },
    { id: 2, nombre: "Roberto", telefono: ROBERTO_PHONE_INTL },
  ],
});
check("recordatorio-a-los-dos", notified.map((courier) => courier.nombre).join(",") === "Mateo,Roberto");

const transition = readFileSync(new URL("../src/lib/services/stateTransitionService.ts", import.meta.url), "utf8");
const claimStart = transition.indexOf("async handleCourierConfirm");
const claimFn = transition.slice(claimStart, transition.indexOf("async handleCourierPickedUp"));
check("claim-estado", claimFn.includes('.eq("estado", "dispatch_repartidor_pendiente")'));
check("claim-repartidor-nulo", claimFn.includes('.is("repartidor_id", null)'));

const parser = readFileSync(new URL("../src/lib/services/courierCommandParser.ts", import.meta.url), "utf8");
check("parser-usa-el-aviso", parser.includes("COURIER_ORDER_TAKEN_MESSAGE"));

const handoff = readFileSync(new URL("../src/lib/services/courierHandoff.ts", import.meta.url), "utf8");
check("ofrece-a-todos", handoff.includes("findAvailableCouriers") && handoff.includes("offerOrderToCouriers"));
check("ya-no-toma-solo-uno", !handoff.includes(".limit(1)"));

const sql = readFileSync(new URL("../supabase/data-fixes/20261015_repartidores_mateo_roberto.sql", import.meta.url), "utf8");
check("sql-mateo", sql.includes(MATEO_PHONE_INTL) && sql.includes('"6": {"abre": "08:00", "cierra": "21:00"}'));
check("sql-roberto", sql.includes(ROBERTO_PHONE_INTL) && sql.includes("Roberto"));
check("sql-sin-borrar", !/\b(drop|delete)\b/i.test(sql));
const migration = readFileSync(new URL("../supabase/migrations/20261015_repartidores_horario_json.sql", import.meta.url), "utf8");
check("migracion-aditiva", /add column if not exists horario_json/i.test(migration) && !/\b(drop|delete)\b/i.test(migration));

if (failures.length) {
  console.error(`Repartidores: ${failures.length} fallo(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Repartidores: ok");
