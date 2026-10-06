/**
 * Horario por día. No toca Supabase ni WhatsApp.
 * Correr: npx tsx scripts/check-business-hours.ts
 */
import {
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

console.log("check-business-hours: ok");
