/**
 * Horario por día. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-business-hours.ts
 */
import {
  checkMandaloSchedule,
  checkTiendaSchedule,
  describeHorarioTienda,
  weekdayInMandalo,
} from "../src/lib/services/businessHours";

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

const DOMINGO_08_15 = { "0": { abre: "08:00", cierra: "15:00" } };

const laCentral = {
  horaApertura: "08:00",
  horaCierre: "17:00",
  diasCerrado: [4],
  horarioPorDia: DOMINGO_08_15,
};

// 2026-10-11 es domingo. México (America/Mexico_City) está en UTC-6.
const domingo1400 = new Date("2026-10-11T20:00:00Z");
const domingo1530 = new Date("2026-10-11T21:30:00Z");
// 2026-10-08 es jueves. 10:00 hora de México.
const jueves1000 = new Date("2026-10-08T16:00:00Z");

assert(weekdayInMandalo(domingo1400) === 0, "14:00 del 11 oct 2026 es domingo en México");
assert(weekdayInMandalo(domingo1530) === 0, "15:30 del 11 oct 2026 es domingo en México");
assert(weekdayInMandalo(jueves1000) === 4, "10:00 del 8 oct 2026 es jueves en México");

const domingoAbierto = checkTiendaSchedule({ ...laCentral, now: domingo1400 });
assert(domingoAbierto.withinSchedule, "La Central el domingo a las 14:00 está abierta");

const domingoCerrado = checkTiendaSchedule({ ...laCentral, now: domingo1530 });
assert(!domingoCerrado.withinSchedule, "La Central el domingo a las 15:30 está cerrada");
assert(domingoCerrado.withinSchedule === false && domingoCerrado.closedReason === "hora", "el domingo a las 15:30 cerró por hora, no por día");
assert(
  domingoCerrado.withinSchedule === false && domingoCerrado.abreTexto === "abre mañana a las 8am",
  "después del domingo abre el lunes a las 8am",
);

const sinExcepcion = checkTiendaSchedule({
  horaApertura: "08:00",
  horaCierre: "17:00",
  diasCerrado: [4],
  now: domingo1530,
});
assert(sinExcepcion.withinSchedule, "sin horario_por_dia el domingo a las 15:30 sigue abierto hasta las 17:00");

const jueves = checkTiendaSchedule({ ...laCentral, now: jueves1000 });
assert(!jueves.withinSchedule, "La Central el jueves está cerrada");
assert(jueves.withinSchedule === false && jueves.closedReason === "dia", "el jueves cierra por día");
assert(weekdayInMandalo(new Date(jueves1000.getTime() + 24 * 60 * 60 * 1000)) === 5, "el día siguiente al jueves de prueba es viernes");
assert(
  jueves.withinSchedule === false && jueves.abreTexto === "abre mañana a las 8am",
  "el jueves cerrado abre el viernes a las 8:00",
);

const otraTiendaJueves = checkTiendaSchedule({
  horaApertura: "08:00",
  horaCierre: "17:00",
  diasCerrado: [4],
  now: jueves1000,
});
assert(
  !otraTiendaJueves.withinSchedule &&
    otraTiendaJueves.withinSchedule === false &&
    otraTiendaJueves.abreTexto === "abre mañana a las 8am",
  "otra tienda cerrada el jueves sigue diciendo abre mañana a las 8am",
);

const horarioBase = describeHorarioTienda({ horaApertura: "08:00", horaCierre: "17:00", diasCerrado: [4] });
assert(horarioBase === "todos los días menos el jueves, de 8am a 5pm", "sin excepción el texto de horario no cambia");
const horarioCentral = describeHorarioTienda(laCentral);
assert(horarioCentral.startsWith(horarioBase), "La Central conserva el horario base");
assert(horarioCentral.includes("domingo de 8am a 3pm"), "el texto de La Central dice que el domingo cierra a las 3pm");

const sabadoNoche = new Date("2026-10-10T23:30:00Z"); // sábado 17:30 México
assert(weekdayInMandalo(sabadoNoche) === 6, "17:30 del 10 oct 2026 es sábado en México");
const sabadoConDomingoDistinto = checkTiendaSchedule({
  horaApertura: "08:00",
  horaCierre: "17:00",
  horarioPorDia: { "0": { abre: "09:00", cierra: "15:00" } },
  now: sabadoNoche,
});
assert(
  !sabadoConDomingoDistinto.withinSchedule &&
    sabadoConDomingoDistinto.withinSchedule === false &&
    sabadoConDomingoDistinto.abreTexto === "abre mañana a las 9am",
  "la próxima apertura usa la hora del día que sigue, no la del horario base",
);

const pekes = {
  horaApertura: "07:30",
  horaCierre: "21:00",
  horarioPorDia: {
    "0": { abre: "09:00", cierra: "15:00" },
    "1": { abre: "07:30", cierra: "21:00" },
    "2": { abre: "07:30", cierra: "21:00" },
    "3": { abre: "07:30", cierra: "21:00" },
    "4": { abre: "07:30", cierra: "21:00" },
    "5": { abre: "07:30", cierra: "21:00" },
    "6": { abre: "08:00", cierra: "21:00" },
  },
};
const lunesTemprano = new Date("2026-10-12T13:00:00Z");
const lunesAbre = new Date("2026-10-12T13:30:00Z");
const lunesNoche = new Date("2026-10-13T02:59:00Z");
const lunesCierra = new Date("2026-10-13T03:00:00Z");
assert(weekdayInMandalo(lunesTemprano) === 1, "07:00 del lunes 12 oct 2026 es lunes");
assert(!checkTiendaSchedule({ ...pekes, now: lunesTemprano }).withinSchedule, "Peke's lunes a las 7:00 está cerrado");
assert(checkTiendaSchedule({ ...pekes, now: lunesAbre }).withinSchedule, "Peke's lunes a las 7:30 está abierto");
assert(checkTiendaSchedule({ ...pekes, now: lunesNoche }).withinSchedule, "Peke's lunes a las 20:59 sigue abierto");
assert(!checkTiendaSchedule({ ...pekes, now: lunesCierra }).withinSchedule, "Peke's lunes a las 21:00 ya cerró");
const sabadoAntes = new Date("2026-10-10T13:59:00Z");
const sabadoAbre = new Date("2026-10-10T14:00:00Z");
assert(!checkTiendaSchedule({ ...pekes, now: sabadoAntes }).withinSchedule, "Peke's sábado a las 7:59 está cerrado");
assert(checkTiendaSchedule({ ...pekes, now: sabadoAbre }).withinSchedule, "Peke's sábado a las 8:00 está abierto");
const domingoAntes = new Date("2026-10-11T14:59:00Z");
const domingoAbre = new Date("2026-10-11T15:00:00Z");
const domingoPekeCierra = new Date("2026-10-11T21:00:00Z");
assert(!checkTiendaSchedule({ ...pekes, now: domingoAntes }).withinSchedule, "Peke's domingo a las 8:59 está cerrado");
assert(checkTiendaSchedule({ ...pekes, now: domingoAbre }).withinSchedule, "Peke's domingo a las 9:00 está abierto");
assert(!checkTiendaSchedule({ ...pekes, now: domingoPekeCierra }).withinSchedule, "Peke's domingo a las 15:00 ya cerró");

assert(!checkMandaloSchedule(lunesTemprano).withinSchedule, "Mándalo a las 7:00 todavía no reparte");
assert(!checkMandaloSchedule(lunesAbre).withinSchedule, "Mándalo a las 7:30 todavía no reparte; abre a las 8:00");
assert(checkMandaloSchedule(new Date("2026-10-12T14:00:00Z")).withinSchedule, "Mándalo a las 8:00 reparte");
assert(checkMandaloSchedule(lunesNoche).withinSchedule, "Mándalo a las 20:59 todavía reparte");
assert(!checkMandaloSchedule(lunesCierra).withinSchedule, "Mándalo a las 21:00 ya no reparte");

console.log("check-business-hours: ok");
