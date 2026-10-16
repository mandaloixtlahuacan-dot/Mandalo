/**
 * La lista de abarrotes no puede quedarse en las primeras 1000 filas.
 * Una tienda como Mini Super Peke's tiene más de 12 mil productos: el
 * candidato correcto está después de ese tope. Agua Santa, con pocos
 * productos, sigue trayendo la lista completa.
 * Correr: npx tsx scripts/check-store-product-search.ts
 */
import { matchLista, type ListaProducto } from "../src/lib/storeProductList";
import {
  foldListaText,
  listaFetchMode,
  listaQueryText,
  listaSearchTokens,
  listaSqlTokens,
  LISTA_SEARCH_LIMIT,
  rankListaByTokens,
  rankListaCandidates,
} from "../src/lib/storeProductSearch";
import {
  clearListaProductosCache,
  loadListaProductosSiActiva,
  type ListaFilterBuilder,
  type ListaQueryResult,
  type ListaSupabase,
} from "../src/lib/repositories/pedidoRepositoryV2";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

type DbRow = {
  id: number;
  tienda_id: number;
  nombre_producto: string;
  marca: string | null;
  presentacion: string | null;
  categoria: string | null;
  alias: string[];
  precio: null;
  disponible: boolean;
};

function product(partial: {
  id: number;
  tiendaId?: number;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  alias?: string[];
  disponible?: boolean;
}): DbRow {
  return {
    id: partial.id,
    tienda_id: partial.tiendaId ?? 7,
    nombre_producto: partial.nombre,
    marca: partial.marca ?? null,
    presentacion: partial.presentacion ?? null,
    categoria: null,
    alias: partial.alias ?? [],
    precio: null,
    disponible: partial.disponible !== false,
  };
}

function toLista(row: DbRow): ListaProducto {
  return {
    nombre: row.nombre_producto,
    marca: row.marca,
    presentacion: row.presentacion,
    alias: row.alias,
    precio: null,
  };
}

function sameHit(row: ListaProducto | undefined, marca: string, presentacion: string): boolean {
  return row?.marca === marca && row.presentacion === presentacion;
}

function buildPekes(): DbRow[] {
  const rows: DbRow[] = [];
  const push = (row: DbRow) => {
    rows[row.id] = row;
  };
  push(product({ id: 10, nombre: "Atún", marca: "Tuny", presentacion: "140 g", alias: ["atun tuny"] }));
  push(product({ id: 20, nombre: "Atún", marca: "Dolores", presentacion: "400 g", alias: ["atun dolores"] }));
  push(product({ id: 30, nombre: "Leche", marca: "Santa Clara", presentacion: "entera 1 L", alias: ["leche santa clara"] }));
  push(product({ id: 40, nombre: "Papas", marca: "Sabritas", presentacion: "Flamin Hot 62 g", alias: ["sabritas flamin"] }));
  for (let id = 100; id < 400; id += 1) {
    push(product({ id, nombre: "Atún", marca: `Otra${id}`, presentacion: "140 g", alias: [`atun otra${id}`] }));
  }
  for (let id = 0; id < 5500; id += 1) {
    if (rows[id]) continue;
    push(product({ id, nombre: `Relleno ${id}`, marca: `Marca${id % 40}`, presentacion: "1 pza", alias: [`relleno ${id}`] }));
  }
  push(product({ id: 4500, nombre: "Atún", marca: "Dolores", presentacion: "140 g", alias: ["atun dolores", "fila-4500"] }));
  push(product({ id: 4600, nombre: "Atún", marca: "Dolores", presentacion: "140 g en aceite", alias: ["dolores aceite"] }));
  push(product({ id: 4700, nombre: "Leche", marca: "Lala", presentacion: "deslactosada 1 L", alias: ["lala deslactosada"] }));
  push(product({ id: 4800, nombre: "Leche", marca: "Lala", presentacion: "entera 1 L", alias: ["leche lala"] }));
  push(product({ id: 5000, nombre: "Papas", marca: "Sabritas", presentacion: "Original 45 g", alias: ["sabritas original"] }));
  push(product({ id: 5100, nombre: "Suavizante", marca: "Suavitel", presentacion: "900 ml", alias: ["suavitel"] }));
  push(product({ id: 5200, nombre: "Jabón", marca: "Zote", presentacion: "200 g", alias: ["jabon zote"] }));
  push(
    product({
      id: 5400,
      nombre: "Atún",
      marca: "Dolores",
      presentacion: "140 g",
      alias: ["no-disponible"],
      disponible: false,
    }),
  );
  return rows.filter((row): row is DbRow => Boolean(row));
}

function aguaSanta(): DbRow[] {
  const items: Array<[string, string, string, string[]]> = [
    ["Agua", "Santa Clara", "600 ml", ["agua santa"]],
    ["Agua", "Santa Clara", "1.5 L", ["agua santa grande"]],
    ["Leche", "Lala", "entera 1 L", ["leche lala"]],
    ["Leche", "Lala", "deslactosada 1 L", ["lala deslactosada"]],
    ["Pan", "Bimbo", "grande", ["pan bimbo"]],
    ["Huevo", "San Juan", "12 piezas", []],
    ["Jabón", "Zote", "200 g", ["jabon zote"]],
    ["Aceite", "123", "1 L", ["aceite 123"]],
    ["Arroz", "Verde Valle", "1 kg", []],
    ["Papas", "Sabritas", "Original 45 g", ["sabritas"]],
    ["Frijol", "La Costeña", "bayo 560 g", []],
    ["Mayonesa", "McCormick", "190 g", []],
  ];
  const rows = items.map(([nombre, marca, presentacion, alias], index) =>
    product({ id: index + 1, tiendaId: 1, nombre, marca, presentacion, alias }),
  );
  rows.push(
    product({
      id: 99,
      tiendaId: 1,
      nombre: "Leche",
      marca: "Lala",
      presentacion: "entera 1 L",
      alias: ["apagada"],
      disponible: false,
    }),
  );
  return rows;
}

function createClient(rows: DbRow[], flag = true) {
  const calls: string[] = [];
  const cap = 1000;
  const client: ListaSupabase = {
    from(table: string) {
      return {
        select(columns: string, options?: { count?: "exact"; head?: boolean }): ListaFilterBuilder {
          const filters: Record<string, unknown> = {};
          const matching = () =>
            rows.filter((row) => {
              if (filters.tienda_id != null && row.tienda_id !== filters.tienda_id) return false;
              if ("disponible" in filters && row.disponible !== filters.disponible) return false;
              return true;
            });
          const run = async (): Promise<ListaQueryResult> => {
            if (table === "productos_tienda" && options?.head && options.count === "exact") {
              calls.push("count");
              return { data: null, error: null, count: matching().length };
            }
            if (table === "productos_tienda") {
              calls.push(`select:${columns}`);
              const visible = matching()
                .slice(0, cap)
                .map((row) => ({
                  id: row.id,
                  nombre_producto: row.nombre_producto,
                  precio: row.precio,
                  categoria: row.categoria,
                  marca: row.marca,
                  presentacion: row.presentacion,
                  alias: row.alias,
                }));
              return { data: visible, error: null };
            }
            return { data: null, error: { message: `tabla ${table}` } };
          };
          const builder: ListaFilterBuilder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            maybeSingle() {
              calls.push(`flag:${table}`);
              if (table !== "tiendas") return Promise.resolve({ data: null, error: { message: "no" } });
              return Promise.resolve({ data: { usa_lista_productos: flag }, error: null });
            },
            then(onfulfilled, onrejected) {
              return run().then(onfulfilled, onrejected);
            },
          };
          return builder;
        },
      };
    },
    async rpc(fn, args) {
      calls.push(`rpc:${fn}:${args.p_tokens.join(",")}`);
      const mine = rows.filter((row) => row.tienda_id === args.p_tienda_id && row.disponible);
      const ranked = rankListaByTokens(mine.map(toLista), args.p_tokens, args.p_limit);
      const data = ranked.map((row) => {
        const source = mine.find(
          (item) =>
            item.nombre_producto === row.nombre &&
            item.marca === row.marca &&
            item.presentacion === row.presentacion &&
            item.alias.join("|") === (row.alias ?? []).join("|"),
        );
        return {
          id: source?.id ?? -1,
          nombre_producto: row.nombre,
          precio: null,
          categoria: null,
          marca: row.marca,
          presentacion: row.presentacion,
          alias: row.alias ?? [],
          rank: 1,
        };
      });
      return { data, error: null };
    },
  };
  return { client, calls };
}

function hitLine(row: ListaProducto | undefined): string {
  if (!row) return "(nada)";
  return [row.nombre, row.marca, row.presentacion, (row.alias ?? []).join("|")].filter(Boolean).join(" · ");
}

async function main() {
  check("pliega atún a atun", foldListaText("ÁtúN Dolores") === "atun dolores");
  const atunTokens = listaSearchTokens("Quiero 2 litros de Atún Dolores");
  check(
    "quita cantidades y muletillas",
    atunTokens.includes("atun") && atunTokens.includes("dolores") && !atunTokens.some((token) => ["quiero", "litros", "de"].includes(token)),
    atunTokens.join(","),
  );
  check(
    "600ml no es un token",
    JSON.stringify(listaSearchTokens("600ml de leche Lala")) === JSON.stringify(["leche", "lala"]),
  );
  check("hola no busca nada", listaSearchTokens("hola").length === 0);
  check("lista chica se trae completa", listaFetchMode(12, ["leche"]) === "full");
  check("mil productos todavía caben", listaFetchMode(1000, ["leche"]) === "full");
  check("mil uno ya se busca", listaFetchMode(1001, ["leche"]) === "search");
  check("sin tokens no se inventa un recorte", listaFetchMode(12000, []) === "empty");
  const joinedTokens = listaSearchTokens(listaQueryText("de 140 gramos", [{ nombre_producto: "Atún", marca: "Dolores" }]));
  check(
    "el texto del turno junta el mensaje y lo ya anotado",
    joinedTokens.includes("atun") && joinedTokens.includes("dolores") && !joinedTokens.includes("gramos"),
    joinedTokens.join(","),
  );

  const pekes = buildPekes();
  check("el fixture pasa de 5000", pekes.length >= 5000, String(pekes.length));
  const target = pekes.find((row) => row.alias.includes("fila-4500"));
  check("el Dolores 140 está después de la fila 1000", (target?.id ?? 0) > 1000, String(target?.id));

  const atunMessage = "Quiero un atún Dolores de 140 gramos";
  const listas = pekes.filter((row) => row.disponible).map(toLista);
  const capped = listas.slice(0, 1000);
  const cappedHits = matchLista(atunMessage, capped);
  check(
    "el tope de 1000 elige el Dolores de 400 g",
    sameHit(cappedHits[0], "Dolores", "400 g"),
    hitLine(cappedHits[0]),
  );
  check(
    "el tope de 1000 no ve la fila 4500",
    !cappedHits.some((row) => row.alias?.includes("fila-4500")),
  );

  const ranked = rankListaCandidates(listas, atunMessage);
  check("la búsqueda devuelve a lo más 80", ranked.length > 0 && ranked.length <= LISTA_SEARCH_LIMIT, String(ranked.length));
  check(
    "la búsqueda sí trae la fila 4500",
    ranked.some((row) => row.alias?.includes("fila-4500")),
    ranked.slice(0, 5).map(hitLine).join(" || "),
  );
  const rankedHits = matchLista(atunMessage, ranked);
  check(
    "matchLista sobre esos candidatos elige el de 140 g",
    rankedHits[0]?.alias?.includes("fila-4500") === true,
    rankedHits.map(hitLine).join(" || "),
  );
  check(
    "no se cuela el atún apagado",
    !ranked.some((row) => row.alias?.includes("no-disponible")),
  );

  const lecheMessage = "Quiero leche Lala de 1 litro";
  const lecheCap = matchLista(lecheMessage, capped);
  check(
    "en las primeras 1000 la leche que se ve es Santa Clara",
    sameHit(lecheCap[0], "Santa Clara", "entera 1 L"),
    hitLine(lecheCap[0]),
  );
  const lecheHits = matchLista(lecheMessage, rankListaCandidates(listas, lecheMessage));
  check(
    "pasada la fila 1000 se encuentra la Lala entera",
    lecheHits.some((row) => row.marca === "Lala" && row.presentacion === "entera 1 L"),
    lecheHits.map(hitLine).join(" || "),
  );
  check("Lala queda arriba de Santa Clara", lecheHits[0]?.marca === "Lala", hitLine(lecheHits[0]));

  const jabonHits = matchLista("quiero jabon zote", rankListaCandidates(listas, "quiero jabon zote"));
  check("jabón sin acento encuentra Zote después de la fila 1000", sameHit(jabonHits[0], "Zote", "200 g"), hitLine(jabonHits[0]));
  check("el tope de 1000 no tiene ese jabón", !matchLista("quiero jabon zote", capped).some((row) => row.marca === "Zote"));

  const typoHits = matchLista("quiero suavitelz", rankListaCandidates(listas, "quiero suavitelz"));
  check(
    "un typo largo encuentra Suavitel después de la fila 1000",
    typoHits.some((row) => row.marca === "Suavitel"),
    typoHits.map(hitLine).join(" || "),
  );

  const sabritasMessage = "quiero papas sabritsa original";
  const sabritasCap = matchLista(sabritasMessage, capped);
  check(
    "el tope se queda con Sabritas Flamin Hot",
    sabritasCap[0]?.presentacion === "Flamin Hot 62 g",
    hitLine(sabritasCap[0]),
  );
  const sabritasHits = matchLista(sabritasMessage, rankListaCandidates(listas, sabritasMessage));
  check(
    "el typo sabritsa encuentra la Original de después",
    sabritasHits.some((row) => row.presentacion === "Original 45 g"),
    sabritasHits.map(hitLine).join(" || "),
  );

  clearListaProductosCache();
  const big = createClient(pekes, true);
  const loaded = await loadListaProductosSiActiva(big.client, 7, atunMessage);
  const loadedHits = matchLista(atunMessage, loaded ?? []);
  check("la tienda activa busca en el servidor", big.calls.some((call) => call.startsWith("rpc:buscar_lista_productos_tienda")));
  check("no baja el select cortado en 1000", !big.calls.some((call) => call.startsWith("select:")));
  check(
    "el repositorio devuelve la fila 4500",
    loadedHits[0]?.alias?.includes("fila-4500") === true,
    loadedHits.map(hitLine).join(" || "),
  );
  check(
    "tampoco devuelve el producto apagado",
    !(loaded ?? []).some((row) => row.alias?.includes("no-disponible")),
  );
  const callsAfterFirst = big.calls.length;
  const again = await loadListaProductosSiActiva(big.client, 7, atunMessage);
  check("el mismo turno no vuelve a consultar", big.calls.length === callsAfterFirst && (again?.length ?? 0) === (loaded?.length ?? 0));

  clearListaProductosCache();
  const quiet = createClient(pekes, true);
  const empty = await loadListaProductosSiActiva(quiet.client, 7, "hola");
  check("sin tokens no recorta las primeras 1000", empty?.length === 0 && !quiet.calls.some((call) => call.startsWith("rpc")));

  clearListaProductosCache();
  const off = createClient(pekes, false);
  const disabled = await loadListaProductosSiActiva(off.client, 7, atunMessage);
  check("con la lista apagada no consulta productos", disabled === null && !off.calls.some((call) => call === "count" || call.startsWith("rpc")));

  clearListaProductosCache();
  const santaRows = aguaSanta();
  const santa = createClient(santaRows, true);
  const santaMessage = "quiero agua santa clara de 600ml";
  const santaLoaded = await loadListaProductosSiActiva(santa.client, 1, santaMessage);
  const santaFull = santaRows.filter((row) => row.disponible).map(toLista);
  check("Agua Santa no usa el RPC", !santa.calls.some((call) => call.startsWith("rpc")));
  check("Agua Santa sí trae el select completo", santa.calls.some((call) => call.startsWith("select:")));
  check("Agua Santa devuelve las 12 filas disponibles", santaLoaded?.length === 12, String(santaLoaded?.length));
  check(
    "Agua Santa no incluye la fila apagada",
    !(santaLoaded ?? []).some((row) => row.alias?.includes("apagada")),
  );
  const messages = [
    santaMessage,
    "2 litros de leche lala",
    "pan bimbo",
    "quiero unas sabritsa",
    "jabon zote",
  ];
  for (const message of messages) {
    const fromFull = matchLista(message, santaFull).map(hitLine).join(" || ");
    const fromLoaded = matchLista(message, santaLoaded ?? []).map(hitLine).join(" || ");
    check(`Agua Santa «${message}» se comporta igual`, fromFull === fromLoaded, `${fromFull} <> ${fromLoaded}`);
  }
  const santaCalls = santa.calls.length;
  await loadListaProductosSiActiva(santa.client, 1, "pan bimbo");
  check("Agua Santa también se consulta una vez por turno", santa.calls.length === santaCalls);

  const night: ListaProducto[] = [
    { nombre: "Queso", marca: "Chelita", presentacion: "1 kg", alias: ["queso chelita"] },
    { nombre: "Queso", marca: "Chelita", presentacion: "250 g", alias: ["queso chelita"] },
    { nombre: "Amper", marca: "Amper", presentacion: "Mora Azul 600 ml", alias: [] },
    { nombre: "Fuzetea", marca: "Fuze Tea", presentacion: "Frutos Rojos 600 ml", alias: ["fuse tea", "fuze tea"] },
    { nombre: "Fuzetea", marca: "Fuze Tea", presentacion: "Limón 600 ml", alias: ["fuse tea"] },
    { nombre: "Fabuloso", marca: "Fabuloso", presentacion: "lavanda 1 L", alias: [] },
    { nombre: "Chicles", marca: "Clorets", presentacion: "caja", alias: ["chicle"] },
    { nombre: "Maíz", marca: "La Costeña", presentacion: "lata 220 g", alias: ["elote", "maiz enlatado"] },
    { nombre: "Maíz", marca: "Morado", presentacion: "bolsa 500 g", alias: ["maiz morado"] },
    { nombre: "Pan", marca: "Bimbo", presentacion: "Blanco 620 g", alias: ["pan bimbo"] },
    { nombre: "Pan", marca: "Bimbo", presentacion: "Blanco Ch 300 g", alias: ["pan bimbo chico"] },
    { nombre: "Pan", marca: "Wonder", presentacion: "integral", alias: [] },
  ];
  const bimbo = rankListaCandidates(night, "pan bimbo").slice(0, 4).map(hitLine);
  check("pan bimbo trae el Blanco 620 g", bimbo.some((line) => line.includes("620")), bimbo.join(" || "));
  check("pan bimbo trae el Blanco chico", bimbo.some((line) => line.includes("300")), bimbo.join(" || "));
  const fuse = rankListaCandidates(night, "fuse ti frutos rojos");
  check("fuse ti frutos rojos es el Fuzetea", fuse[0]?.marca === "Fuze Tea" && /frutos rojos/i.test(fuse[0]?.presentacion ?? ""), hitLine(fuse[0]));
  const lata = rankListaCandidates(night, "lata de maíz la costeña");
  check("la lata de maíz es La Costeña", lata[0]?.marca === "La Costeña", hitLine(lata[0]));
  check("el sql de fuse incluye fuzetea", listaSqlTokens("fuse ti frutos rojos").includes("fuzetea"), listaSqlTokens("fuse ti frutos rojos").join(","));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
