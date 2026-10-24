/**
 * App PWA: carrito, cobertura, extras, push y pedido.
 * No llama a OpenAI, no abre Supabase, no manda WhatsApp ni push real.
 *
 *   npx tsx scripts/check-app-pwa.ts
 */
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";

import { registerAppUser } from "../src/lib/app/auth";
import { summarizeCart } from "../src/lib/app/cartMath";
import { decideCoverage } from "../src/lib/app/coverage";
import { MIGRACION_PENDIENTE } from "../src/lib/app/dbError";
import { composeStoreItemName } from "../src/lib/app/itemText";
import { notifyAppPushForOrderState, resetPushSchemaProbeForTests, setPushSenderForTests } from "../src/lib/app/orderPush";
import { placeAppOrder } from "../src/lib/app/placeOrder";
import { pushNoticesForState } from "../src/lib/app/pushCopy";
import { matchCatalogProduct, type CatalogPriceRow } from "../src/lib/catalogQuantities";
import { IXTLAHUACAN_CENTER } from "../src/lib/services/geo";
import { MemoryDatabase } from "./sim/memory-db";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

const cart = summarizeCart([{ precio: 100, cantidad: 1, cotizar: false }]);
check("carrito-100-15-10", cart.subtotal === 100 && cart.envio === 15 && cart.servicio === 10 && cart.total === 125, JSON.stringify(cart));
const estimado = summarizeCart([{ precio: 100, cantidad: 1, cotizar: true }]);
check("carrito-estimado", estimado.cotizar && estimado.totalTexto.includes("estimado"), estimado.totalTexto);

const george = JSON.parse(readFileSync("scripts/fixtures/george-catalogo.json", "utf8")) as Array<{ nombre_producto: string; precio: number }>;
const central = JSON.parse(readFileSync("scripts/fixtures/lacentral-catalogo.json", "utf8")) as Array<{ nombre_producto: string; precio: number }>;
assertSameProduct("george", george, "Hamburguesa de Res Chica");
assertSameProduct("central", central, central[0]?.nombre_producto ?? "");

const center = decideCoverage({
  latitude: IXTLAHUACAN_CENTER.latitude,
  longitude: IXTLAHUACAN_CENTER.longitude,
  referencia: null,
  zones: [],
});
check("centro-dentro", center.ok && center.regla === "radio");
const lejos = decideCoverage({ latitude: 21.5, longitude: -103.24, referencia: "Calle Morelos", zones: ["Calle Morelos"] });
check("pin-fuera-aunque-calle", !lejos.ok && lejos.regla === "radio");
const cero = decideCoverage({ latitude: 0, longitude: 0, referencia: null, zones: [] });
check("cero-no-es-pin", !cero.ok);
const calle = decideCoverage({ latitude: null, longitude: null, referencia: "Calle Morelos 10", zones: ["Calle Morelos"] });
check("calle-sin-pin", calle.ok && calle.regla === "zona");
const pinSinTabla = decideCoverage({
  latitude: IXTLAHUACAN_CENTER.latitude,
  longitude: IXTLAHUACAN_CENTER.longitude,
  referencia: null,
  zones: null,
});
check("pin-sin-tabla", pinSinTabla.ok && pinSinTabla.aviso != null);

const camino = pushNoticesForState("en_camino_cliente", 9);
check("en-camino-dos", camino.length === 2 && camino[1]?.highlight === true && camino[1]?.title === "Tu pedido va en camino");

async function main(): Promise<void> {
resetPushSchemaProbeForTests();
const sent: string[] = [];
const pushDb = new MemoryDatabase();
pushDb.insertRows("pedidos", [{ id: 9, cliente_telefono: "5213311111111", estado: "en_camino_cliente" }]);
pushDb.insertRows("usuarios_app", [{ id: 3, telefono: "5213311111111", nombre: "Ana", password_hash: "x" }]);
pushDb.insertRows("push_subscriptions", [{ id: 1, usuario_id: 3, endpoint: "https://push.example/1", p256dh: "p", auth: "a" }]);
await notifyAppPushForOrderState(
  { pedidoId: 9, estado: "en_camino_cliente", previousEstado: "repartidor_asignado" },
  {
    supabase: pushDb.client() as unknown as SupabaseClient,
    sender: { async send(_subs, notice) { sent.push(notice.title); } },
  },
);
check("push-mock", sent.join("|") === "Pedido recogido|Tu pedido va en camino", sent.join("|"));
check("push-no-webpush", !read("src/lib/app/placeOrder.ts").includes("web-push"));

resetPushSchemaProbeForTests();
let threw = false;
try {
  await notifyAppPushForOrderState(
    { pedidoId: 9, estado: "pendiente_tiendas", previousEstado: "confirmacion_cliente" },
    { supabase: missingAfterPedido() as unknown as SupabaseClient, sender: { async send() { sent.push("no"); } } },
  );
} catch {
  threw = true;
}
check("push-tabla-ausente", !threw && !sent.includes("no"));

const accounts = new MemoryDatabase();
const first = await registerAppUser(accounts.client() as unknown as SupabaseClient, {
  nombre: "Ana López",
  telefono: "3311111111",
  password: "secreto12",
});
check("registro", first.ok === true && first.ok && first.cookie.options.httpOnly === true);
const row = accounts.rows("usuarios_app")[0];
check("hash-no-es-clave", Boolean(row) && String(row?.password_hash) !== "secreto12" && String(row?.password_hash).startsWith("$2"));
const dup = await registerAppUser(accounts.client() as unknown as SupabaseClient, {
  nombre: "Ana López",
  telefono: "3311111111",
  password: "secreto12",
});
check("duplicado-409", !dup.ok && dup.status === 409);

const staff = new MemoryDatabase();
staff.insertRows("tiendas", [{ id: 1, nombre: "Tienda", telefono: "5213322222222", activa: true }]);
const blocked = await registerAppUser(staff.client() as unknown as SupabaseClient, {
  nombre: "Empleado",
  telefono: "3322222222",
  password: "secreto12",
});
check("numero-trabajo", !blocked.ok && blocked.status === 409);

const pending = await registerAppUser(missingDb() as unknown as SupabaseClient, {
  nombre: "Ana",
  telefono: "3333333333",
  password: "secreto12",
});
check("migracion", !pending.ok && pending.code === MIGRACION_PENDIENTE);

await placeCase("abierta-cotiza", "2026-10-25T18:00:00.000Z", false, true);
await placeCase("cerrada", "2026-10-25T10:00:00.000Z", false, true);
await placeCase("catalogo", "2026-10-25T18:00:00.000Z", true, true);
await placeCase("sin-repartidor", "2026-10-25T18:00:00.000Z", true, false);

const placeSrc = read("src/lib/app/placeOrder.ts") + read("src/lib/app/production.ts");
check("sin-waapi", !placeSrc.includes("waapiSendText") && !placeSrc.includes("from \"@/lib/waapi\"") && !placeSrc.includes("from '@/lib/waapi'"));

setPushSenderForTests(null);
resetPushSchemaProbeForTests();

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("check-app-pwa ok");
}

void main();

function assertSameProduct(label: string, rows: Array<{ nombre_producto: string; precio: number }>, nombre: string): void {
  const catalog: CatalogPriceRow[] = rows.map((row) => ({ nombreProducto: row.nombre_producto, precio: row.precio }));
  const line = composeStoreItemName(nombre, ["Sin cebolla"], "sin picante", catalog);
  if (line.notasAparte) {
    check(`${label}-nombre-exacto`, line.nombre === nombre, line.nombre);
    return;
  }
  const matched = matchCatalogProduct(catalog, line.nombre);
  check(`${label}-mismo-producto`, matched?.nombreProducto.trim().toLowerCase() === nombre.trim().toLowerCase(), line.nombre);
}

async function placeCase(label: string, now: string, catalogo: boolean, conRepartidor: boolean): Promise<void> {
  const db = new MemoryDatabase();
  db.insertRows("tiendas", [{
    id: catalogo ? 5 : 7,
    nombre: catalogo ? "George" : "Mini Super Peke's",
    telefono: "5213300000001",
    activa: true,
    categoria: catalogo ? "restaurantes" : "abarrotes",
    hora_apertura: "08:00",
    hora_cierre: "21:00",
    usa_catalogo_fijo: catalogo,
    direccion: "centro",
  }]);
  db.insertRows("productos_tienda", [{
    id: catalogo ? 10 : 1,
    tienda_id: catalogo ? 5 : 7,
    nombre_producto: catalogo ? "Hamburguesa de Res Chica" : "Leche 1L",
    precio: catalogo ? 60 : 28,
    disponible: true,
  }]);
  db.insertRows("zonas_cobertura", [{ id: 1, nombre: "Calle Morelos", activa: true }]);
  const enqueued: Array<{ tipoMensaje: string; payload: { body?: string } }> = [];
  const dispatches: Array<{ fromEstado?: string; catalogAlreadyConfirmed?: boolean }> = [];
  let cancelled = false;
  const result = await placeAppOrder(
    {
      telefono: "3311111111",
      nombre: "Ana López",
      tiendaId: catalogo ? 5 : 7,
      lines: [{ productoId: catalogo ? 10 : 1, cantidad: 2, extras: ["Sin cebolla", "Inventado"], nota: "sin picante" }],
      latitude: IXTLAHUACAN_CENTER.latitude,
      longitude: IXTLAHUACAN_CENTER.longitude,
      referencia: "Calle Morelos 10",
      now: new Date(now),
    },
    {
      supabase: db.client() as unknown as SupabaseClient,
      async enqueue(input) {
        enqueued.push(input);
        return 1;
      },
      async dispatch(_pedido, params) {
        dispatches.push(params);
        return { ok: true };
      },
      async findCouriers() {
        return conRepartidor ? [{ id: 1 }] : [];
      },
      async cancelNoCourier() {
        cancelled = true;
      },
    },
  );

  const pedido = db.rows("pedidos")[0];
  check(`${label}-pedido`, result.ok === true && Boolean(pedido), JSON.stringify(result));
  const meta = (pedido?.metadata_json ?? {}) as { origen?: string };
  check(`${label}-origen`, meta.origen === "app");
  const item = db.rows("pedido_items")[0];
  if (label === "abierta-cotiza") {
    check("cotiza-extras", String(item?.nombre_producto ?? "").includes("Sin cebolla") && !String(item?.nombre_producto).includes("Inventado"));
    check("cotiza-cantidad", Number(item?.cantidad) === 2);
    check("cotiza-despacho", dispatches[0]?.fromEstado === "confirmacion_cliente" && dispatches[0]?.catalogAlreadyConfirmed === false);
    check("cotiza-whatsapp", enqueued.some((row) => row.tipoMensaje === "notificacion_cliente" && String(row.payload.body).includes("Pedido #")));
    check("cotiza-estado", result.ok && result.estado === "pendiente_tiendas");
  }
  if (label === "cerrada") {
    check("cerrada-estado", result.ok && result.estado === "esperando_apertura_tienda" && dispatches.length === 0);
    check("cerrada-aviso", enqueued.some((row) => row.tipoMensaje === "notificacion_cliente"));
  }
  if (label === "catalogo") {
    check("catalogo-confirmado", dispatches[0]?.catalogAlreadyConfirmed === true);
    check("catalogo-no-cancela", cancelled === false);
  }
  if (label === "sin-repartidor") {
    check("sin-repartidor", result.ok && result.estado === "cancelado" && cancelled && dispatches.length === 0);
  }
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function missingAfterPedido(): { from: (table: string) => unknown } {
  const error = { code: "42P01", message: "relation does not exist" };
  const fail = {
    select() { return fail; },
    in() { return fail; },
    eq() { return fail; },
    then(onFulfilled: (value: { data: null; error: typeof error }) => unknown) {
      return Promise.resolve({ data: null, error }).then(onFulfilled);
    },
  };
  return {
    from(table: string) {
      if (table === "pedidos") {
        return {
          select() {
            return { eq: () => ({ maybeSingle: async () => ({ data: { cliente_telefono: "5213311111111" }, error: null }) }) };
          },
        };
      }
      return { select: () => fail };
    },
  };
}

function missingDb(): { from: () => unknown } {
  const error = { code: "PGRST205", message: "Could not find the table public.usuarios_app in the schema cache" };
  const query = {
    select() { return query; },
    eq() { return query; },
    in() { return query; },
    limit() { return query; },
    insert() { return query; },
    maybeSingle: async () => ({ data: null, error }),
    then(onFulfilled: (value: { data: null; error: typeof error }) => unknown) {
      return Promise.resolve({ data: null, error }).then(onFulfilled);
    },
  };
  return { from: () => query };
}
