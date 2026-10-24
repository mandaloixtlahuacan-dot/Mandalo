/**
 * App PWA: carrito, cobertura, extras, push y pedido.
 * No llama a OpenAI, no abre Supabase, no manda WhatsApp ni push real.
 *
 *   npx tsx scripts/check-app-pwa.ts
 */
import { gunzipSync } from "node:zlib";
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
import { NOMINATIM_DEBOUNCE_MS, NOMINATIM_USER_AGENT, nominatimHeaders, nominatimSearchUrl, parseGeocodeRequest, readNominatimHits, resolveMapProvider } from "../src/lib/app/geocode";
import { isBebidaAlcoholica } from "../src/lib/app/alcohol";
import { classifyShelf, FILTER_SHELVES, parseShelfBrowse, shelfOrFilter } from "../src/lib/app/shelves";
import { matchCatalogProduct, type CatalogPriceRow } from "../src/lib/catalogQuantities";
import { IXTLAHUACAN_CENTER } from "../src/lib/services/geo";
import { MemoryDatabase } from "./sim/memory-db";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

check("takis-botanas", classifyShelf("Takis Fuego 60g", "sabritas") === "botanas");
check("coca-bebidas", classifyShelf("Coca Cola 600 ml", "bebidas") === "bebidas");
check("sh-higiene", classifyShelf("Sh Fructis Biotina 650ml", "shampoo y acondicion") === "higiene");
check("det-limpieza", classifyShelf("Det Ariel Downy 1.5kg", "detergentes") === "limpieza");
check("fabuloso-limpieza", classifyShelf("Fabuloso Pasion De Frutas 2lt", "limpiadores de piso") === "limpieza");
check("leche-lacteos", classifyShelf("Leche Lala 1lt", "lacteos") === "lacteos");
check("anaquel-or", (shelfOrFilter("botanas") ?? "").includes("takis"));
check("sin-otros-visible", FILTER_SHELVES.every((item) => item.id !== "otros") && FILTER_SHELVES.length === 12);
check("todos-por-defecto", parseShelfBrowse("") === "todos" && parseShelfBrowse("otros") === "todos" && parseShelfBrowse("bebidas") === "bebidas");
check("velas-limpieza", classifyShelf("Vela Aromatica", "velas/aromatizantes") === "limpieza");
check("farmacia-higiene", classifyShelf("Pepto Bismol 118ml", "farmacia") === "higiene");
check("desechables-limpieza", classifyShelf("Vaso Reyma", "desechables") === "limpieza");
check("encanto-botanas", classifyShelf("Cheeses Encanto", "encanto") === "botanas");
const pekes = JSON.parse(gunzipSync(readFileSync("scripts/fixtures/pekes-catalogo-completo.json.gz")).toString("utf8")) as Array<{ nombre_producto: string; categoria?: string }>;
const otros = pekes.filter((row) => classifyShelf(row.nombre_producto, row.categoria) === "otros").length;
check("pekes-sin-categoria", otros / pekes.length < 0.03, `${otros}/${pekes.length}`);
const alcohol = pekes.filter((row) => isBebidaAlcoholica(row.nombre_producto, row.categoria));
check("alcohol-bloqueados", alcohol.length === 111, String(alcohol.length));
check("alcohol-sin-vinagre", !alcohol.some((row) => /vinagre/i.test(row.nombre_producto)));
check("alcohol-sin-clamato-solo", !alcohol.some((row) => /^clamato/i.test(row.nombre_producto)));
check("alcohol-sin-chicharron", !alcohol.some((row) => /chicharron/i.test(row.nombre_producto)));
check("alcohol-sin-manzanita", !alcohol.some((row) => /manzanita sol/i.test(row.nombre_producto)));
for (const name of ["Corona Light 355ml", "Tequila Don Julio Reposado 700ml", "Jack Daniels Whiskey 473ml", "Sol Clamato Laton", "Boones Durazno 750ml", "Indio", "Bacardi Coca Cola 355ml"]) {
  const row = pekes.find((item) => item.nombre_producto === name);
  check(`bloquea-${name}`, Boolean(row) && isBebidaAlcoholica(row?.nombre_producto ?? "", row?.categoria));
}
for (const name of ["Manzanita Sol 600ml", "Clamato 946 Ml", "Cerveza De Raiz 500ml", "Chorizo Corona 200g", "Alka Seltzer", "Heineken 0 Alchol 355ml", "Sangrita Viuda De Sanchez", "Fibra Metalica Mega", "Surtido Modelo Alteño 5k", "Cj Vinagre Blanco 1lt", "Chicharron Sabritas 70g", "Paleton Corona 25g", "Bon O Bon Licores 450g", "Veladora Mexico Michelada"]) {
  const row = pekes.find((item) => item.nombre_producto === name);
  check(`permite-${name}`, Boolean(row) && !isBebidaAlcoholica(row?.nombre_producto ?? "", row?.categoria));
}
const tiendaSrc = read("src/app/app/tienda/[id]/page.tsx");
check("tienda-todos", tiendaSrc.includes('useState("todos")') && tiendaSrc.includes("Cargar más") && tiendaSrc.includes("FILTER_SHELVES") && !tiendaSrc.includes(">Otros<"));
check("carrito-flotante", read("src/components/app/Shell.tsx").includes("carrito-flotante"));
check("alcohol-en-catalogo", read("src/lib/app/catalog.ts").includes("isBebidaAlcoholica") && read("src/lib/app/catalog.ts").includes("ALCOHOL_AISLE_OR"));
check("alcohol-en-pedido", read("src/lib/app/placeOrder.ts").includes("isBebidaAlcoholica"));
const ilustracion = read("src/components/app/ilustraciones.tsx");
check("ilustraciones", ilustracion.includes("function Higiene") && ilustracion.includes("function Bebidas") && ilustracion.includes("<svg") && !ilustracion.includes("http"));
console.log(`sin-categoria ${otros}/${pekes.length}`);
console.log(`alcohol-bloqueados ${alcohol.length}`);
console.log(`alcohol-ejemplos ${["Corona Light 355ml", "Tequila Don Julio Reposado 700ml", "Jack Daniels Whiskey 473ml", "Sol Clamato Laton", "Boones Durazno 750ml", "Indio", "Bacardi Coca Cola 355ml", "Dos Equis Caguamon", "Malibu", "Heineken Caguamon"].join(" | ")}`);

check("mapa-default-osm", resolveMapProvider({}) === "osm");
check("mapa-google-sin-llave", resolveMapProvider({ provider: "google", googleKey: "  " }) === "osm");
check("mapa-google-con-llave", resolveMapProvider({ provider: "google", googleKey: "llave" }) === "google");
const nominatim = nominatimSearchUrl("Morelos 10");
check(
  "nominatim-acotado",
  nominatim.includes("bounded=1") && nominatim.includes("viewbox=") && nominatim.includes("countrycodes=mx") && nominatim.includes("Ixtlahuac"),
  nominatim,
);
check("nominatim-debounce", NOMINATIM_DEBOUNCE_MS >= 1000);
check("nominatim-ua", NOMINATIM_USER_AGENT.includes("Mandalo") && nominatimHeaders()["User-Agent"].includes("Mandalo") && Boolean(nominatimHeaders().Referer));
const calleSinPin = parseGeocodeRequest(new URLSearchParams("q=Morelos 10"));
check("geocode-calle-no-es-cero", calleSinPin.latitude == null && calleSinPin.q === "Morelos 10");
const pinExplicito = parseGeocodeRequest(new URLSearchParams("lat=20.86&lng=-103.24"));
check("geocode-pin-explicito", pinExplicito.latitude === 20.86 && pinExplicito.longitude === -103.24);
const hit = readNominatimHits([{ lat: "20.86", lon: "-103.24", display_name: "Morelos 10, Ixtlahuacán del Río" }]);
check("nominatim-lee-hit", hit.length === 1 && hit[0]?.direccion.includes("Morelos"));
const geocodeRoute = readFileSync("src/app/api/app/geocode/route.ts", "utf8");
check("geocode-sin-google", geocodeRoute.includes("nominatimHeaders") && geocodeRoute.includes("waitNominatimSlot") && !geocodeRoute.includes("maps.googleapis"));
const osmMap = readFileSync("src/components/app/OsmMap.tsx", "utf8");
check(
  "osm-tiles",
  osmMap.includes("tile.openstreetmap.org") && osmMap.includes("openstreetmap.org/copyright") && osmMap.includes("NOMINATIM_DEBOUNCE_MS") && !osmMap.includes("maps.googleapis"),
);
const picker = readFileSync("src/components/app/MapPicker.tsx", "utf8");
check("picker-osm-por-defecto", picker.includes('provider = "osm"') && picker.includes('provider === "google"'));
const direccion = readFileSync("src/app/app/direccion/page.tsx", "utf8");
check("direccion-sin-aviso-de-llave", direccion.includes("provider={proveedor}") && !direccion.includes("Sin mapa en este preview"));

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
await alcoholCase();

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
      lines: [{ productoId: catalogo ? 10 : 1, cantidad: 2, extras: ["Sin cebolla", "Con verdura"], nota: "sin picante", salsa: "BBQ" }],
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
    check("cotiza-sin-extras-de-restaurante", !String(item?.nombre_producto ?? "").includes("Sin cebolla") && !String(item?.nombre_producto ?? "").includes("BBQ"));
    check("cotiza-nota", String(item?.nombre_producto ?? "").includes("sin picante"));
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
    const aviso = enqueued.map((row) => String(row.payload.body ?? "")).join("\n");
    const visible = `${String(item?.nombre_producto ?? "")}\n${aviso}`;
    check("catalogo-salsa", visible.includes("BBQ") && visible.includes("Sin cebolla"), visible.slice(0, 180));
    check("catalogo-confirmado", dispatches[0]?.catalogAlreadyConfirmed === true);
    check("catalogo-no-cancela", cancelled === false);
  }
  if (label === "sin-repartidor") {
    check("sin-repartidor", result.ok && result.estado === "cancelado" && cancelled && dispatches.length === 0);
  }
}

async function alcoholCase(): Promise<void> {
  const db = new MemoryDatabase();
  db.insertRows("tiendas", [{
    id: 7,
    nombre: "Mini Super Peke's",
    telefono: "5213300000001",
    activa: true,
    categoria: "abarrotes",
    hora_apertura: "08:00",
    hora_cierre: "21:00",
    usa_catalogo_fijo: true,
    direccion: "centro",
  }]);
  db.insertRows("productos_tienda", [{
    id: 99,
    tienda_id: 7,
    nombre_producto: "Corona Light 355ml",
    categoria: "cerveza",
    precio: 25,
    disponible: true,
  }]);
  db.insertRows("zonas_cobertura", [{ id: 1, nombre: "Calle Morelos", activa: true }]);
  const result = await placeAppOrder(
    {
      telefono: "3311112222",
      nombre: "Ana López",
      tiendaId: 7,
      lines: [{ productoId: 99, cantidad: 1, extras: [], nota: "", salsa: "" }],
      latitude: IXTLAHUACAN_CENTER.latitude,
      longitude: IXTLAHUACAN_CENTER.longitude,
      referencia: "Calle Morelos 10",
      now: new Date("2026-10-25T18:00:00.000Z"),
    },
    {
      supabase: db.client() as unknown as SupabaseClient,
      async enqueue() { return 1; },
      async dispatch() { return { ok: true }; },
      async findCouriers() { return [{ id: 1 }]; },
      async cancelNoCourier() { return undefined; },
    },
  );
  check("pedido-sin-alcohol", result.ok === false && result.code === "ALCOHOL" && db.rows("pedidos").length === 0, JSON.stringify(result));
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
