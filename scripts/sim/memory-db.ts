/**
 * Cliente con la forma que usa el bot (from/select/eq/rpc), datos en memoria.
 * No abre red. Los catálogos salen de scripts/fixtures.
 */
import { readFileSync } from "node:fs";

import { rankListaByTokens } from "../../src/lib/storeProductSearch";

export type MemoryRow = Record<string, unknown>;

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "in"; column: string; value: unknown[] }
  | { kind: "not-in"; column: string; value: unknown[] }
  | { kind: "ilike"; column: string; value: string }
  | { kind: "lte"; column: string; value: unknown }
  | { kind: "gt"; column: string; value: unknown }
  | { kind: "is-null"; column: string };

type SelectField = { name: string; children: SelectField[] | null };

type QueryResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
  status?: number;
};

const RELATIONS: Record<string, { table: string; foreign: string; local: string; many: boolean }> = {
  "pedidos.pedido_tiendas": { table: "pedido_tiendas", foreign: "pedido_id", local: "id", many: true },
  "pedido_tiendas.tiendas": { table: "tiendas", foreign: "id", local: "tienda_id", many: false },
  "pedido_tiendas.pedido_items": { table: "pedido_items", foreign: "pedido_tienda_id", local: "id", many: true },
  "pedido_tiendas.pedidos": { table: "pedidos", foreign: "id", local: "pedido_id", many: false },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fold(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function same(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (typeof left === "boolean" || typeof right === "boolean") return Boolean(left) === Boolean(right);
  return String(left) === String(right);
}

function splitTop(spec: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of spec) {
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSelect(spec: string): SelectField[] {
  if (!spec.trim() || spec.trim() === "*") return [];
  return splitTop(spec).map((part) => {
    const open = part.indexOf("(");
    if (open === -1) return { name: part.trim(), children: null };
    const name = part.slice(0, open).trim().replace(/!inner$|!left$/i, "");
    const inner = part.slice(open + 1, part.lastIndexOf(")"));
    return { name, children: parseSelect(inner) };
  });
}

function project(row: MemoryRow, fields: SelectField[]): MemoryRow {
  if (!fields.length) return clone(row);
  const next: MemoryRow = {};
  for (const field of fields) {
    if (field.children) continue;
    if (field.name in row) next[field.name] = clone(row[field.name]);
  }
  return next;
}

function parseList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const text = String(value ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
  if (!text) return [];
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function cellOf(row: MemoryRow, column: string): unknown {
  const arrow = column.match(/^([A-Za-z0-9_]+)->>([A-Za-z0-9_]+)$/);
  if (!arrow) return row[column];
  const parent = row[arrow[1]];
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return null;
  const value = (parent as MemoryRow)[arrow[2]];
  return value === undefined ? null : value;
}

function ilikeMatch(cell: unknown, pattern: string): boolean {
  const haystack = fold(cell);
  const needle = fold(pattern).replace(/%/g, "");
  if (!needle) return true;
  return haystack.includes(needle);
}

export class MemoryDatabase {
  readonly tables = new Map<string, MemoryRow[]>();
  private sequences = new Map<string, number>();

  constructor() {
    for (const name of [
      "tiendas",
      "repartidores",
      "clientes",
      "productos_tienda",
      "pedidos",
      "pedido_tiendas",
      "pedido_items",
      "pedido_eventos",
      "admin_notificaciones",
      "configuracion",
      "zonas_cobertura",
      "conversaciones_archivo",
      "whatsapp_mensajes_procesados",
      "metricas",
    ]) {
      this.tables.set(name, []);
    }
  }

  seed(table: string, rows: MemoryRow[]): void {
    const copy = rows.map((row) => clone(row));
    this.tables.set(table, copy);
    const max = copy.reduce((acc, row) => Math.max(acc, Number(row.id ?? 0) || 0), 0);
    this.sequences.set(table, max);
  }

  rows(table: string): MemoryRow[] {
    return this.tables.get(table) ?? [];
  }

  /** Borra pedidos y chat. Deja tiendas, catálogo y repartidores. */
  resetOperational(): void {
    for (const name of [
      "clientes",
      "pedidos",
      "pedido_tiendas",
      "pedido_items",
      "pedido_eventos",
      "admin_notificaciones",
      "conversaciones_archivo",
      "whatsapp_mensajes_procesados",
    ]) {
      this.tables.set(name, []);
    }
  }

  client(): MemorySupabase {
    return new MemorySupabase(this);
  }

  private nextId(table: string): number {
    const current = this.sequences.get(table) ?? 0;
    const next = current + 1;
    this.sequences.set(table, next);
    return next;
  }

  private ensure(table: string): MemoryRow[] {
    const found = this.tables.get(table);
    if (found) return found;
    const created: MemoryRow[] = [];
    this.tables.set(table, created);
    return created;
  }

  insertRows(table: string, payload: MemoryRow | MemoryRow[]): MemoryRow[] {
    const rows = Array.isArray(payload) ? payload : [payload];
    const stored: MemoryRow[] = [];
    for (const row of rows) {
      const next = clone(row);
      if (next.id == null) next.id = this.nextId(table);
      if (next.created_at == null) next.created_at = new Date().toISOString();
      if (next.updated_at == null && (table === "pedidos" || table === "clientes")) next.updated_at = next.created_at;
      this.ensure(table).push(next);
      stored.push(clone(next));
    }
    return stored;
  }
}

class MemoryQuery implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private columns = "*";
  private head = false;
  private countExact = false;
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private mode: "many" | "maybe" | "one" = "many";
  private returning = false;

  constructor(
    private readonly db: MemoryDatabase,
    private readonly table: string,
    private op: "select" | "insert" | "update" | "upsert" | "delete",
    private payload: unknown = null,
    private onConflict: string | null = null,
  ) {
    this.returning = op === "select";
  }

  select(columns = "*", options?: { count?: "exact"; head?: boolean }): this {
    this.columns = String(columns ?? "*");
    this.returning = true;
    if (options?.count === "exact") this.countExact = true;
    if (options?.head) this.head = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ kind: "in", column, value: Array.isArray(value) ? value : [value] });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === "in") this.filters.push({ kind: "not-in", column, value: parseList(value) });
    else if (operator === "eq") this.filters.push({ kind: "neq", column, value });
    else throw new Error(`supabase simulado: not ${operator} no está soportado`);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ kind: "lte", column, value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push({ kind: "gt", column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    if (value !== null) throw new Error("supabase simulado: is solo acepta null");
    this.filters.push({ kind: "is-null", column });
    return this;
  }

  ilike(column: string, value: string): this {
    this.filters.push({ kind: "ilike", column, value: String(value ?? "") });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(count: number): this {
    this.limitN = count;
    return this;
  }

  maybeSingle(): Promise<QueryResult> {
    this.mode = "maybe";
    return this.execute();
  }

  single(): Promise<QueryResult> {
    this.mode = "one";
    return this.execute();
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matches(row: MemoryRow): boolean {
    return this.filters.every((filter) => {
      const cell = cellOf(row, filter.column);
      if (filter.kind === "eq") return same(cell, filter.value);
      if (filter.kind === "neq") return !same(cell, filter.value);
      if (filter.kind === "in") return filter.value.some((item) => same(cell, item));
      if (filter.kind === "not-in") return !filter.value.some((item) => same(cell, item));
      if (filter.kind === "is-null") return cell == null;
      if (filter.kind === "lte") return cell != null && String(cell) <= String(filter.value ?? "");
      if (filter.kind === "gt") return cell != null && String(cell) > String(filter.value ?? "");
      return ilikeMatch(cell, filter.value);
    });
  }

  private matched(): MemoryRow[] {
    let rows = this.db.rows(this.table).filter((row) => this.matches(row));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = rows.slice().sort((left, right) => {
        const a = left[column];
        const b = right[column];
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        const cmp = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        return ascending ? cmp : -cmp;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private shape(row: MemoryRow): MemoryRow {
    const fields = parseSelect(this.columns);
    const projected = project(row, fields);
    for (const field of fields) {
      if (!field.children) continue;
      const relation = RELATIONS[`${this.table}.${field.name}`];
      if (!relation) {
        projected[field.name] = null;
        continue;
      }
      const related = this.db.rows(relation.table).filter((item) => same(item[relation.foreign], row[relation.local]));
      const nested = related.map((item) => {
        const child = project(item, field.children ?? []);
        for (const grand of field.children ?? []) {
          if (!grand.children) continue;
          const inner = RELATIONS[`${relation.table}.${grand.name}`];
          if (!inner) {
            child[grand.name] = null;
            continue;
          }
          const kids = this.db
            .rows(inner.table)
            .filter((entry) => same(entry[inner.foreign], item[inner.local]))
            .map((entry) => project(entry, grand.children ?? []));
          child[grand.name] = inner.many ? kids : kids[0] ?? null;
        }
        return child;
      });
      projected[field.name] = relation.many ? nested : nested[0] ?? null;
    }
    return projected;
  }

  private execute(): Promise<QueryResult> {
    try {
      return Promise.resolve(this.run());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve({ data: null, error: { message }, count: null });
    }
  }

  private run(): QueryResult {
    if (this.op === "insert") {
      const stored = this.db.insertRows(this.table, (this.payload ?? {}) as MemoryRow | MemoryRow[]);
      if (!this.returning) return { data: null, error: null };
      return this.finish(stored);
    }

    if (this.op === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      const conflict = (this.onConflict ?? "id").split(",").map((item) => item.trim()).filter(Boolean);
      const stored: MemoryRow[] = [];
      for (const row of incoming as MemoryRow[]) {
        const tableRows = this.db.rows(this.table);
        const found = tableRows.find((current) => conflict.every((column) => same(current[column], row[column])));
        if (found) {
          Object.assign(found, clone(row));
          stored.push(clone(found));
        } else {
          stored.push(...this.db.insertRows(this.table, row));
        }
      }
      if (!this.returning) return { data: null, error: null };
      return this.finish(stored);
    }

    if (this.op === "update") {
      const updated = this.matched().map((row) => {
        Object.assign(row, clone((this.payload ?? {}) as MemoryRow));
        row.updated_at = new Date().toISOString();
        return clone(row);
      });
      if (!this.returning) return { data: null, error: null };
      return this.finish(updated);
    }

    if (this.op === "delete") {
      const tableRows = this.db.rows(this.table);
      const removed: MemoryRow[] = [];
      for (let index = tableRows.length - 1; index >= 0; index -= 1) {
        if (!this.matches(tableRows[index])) continue;
        removed.push(clone(tableRows[index]));
        tableRows.splice(index, 1);
      }
      if (this.table === "pedidos") {
        const ids = new Set(removed.map((row) => row.id));
        const tiendas = this.db.rows("pedido_tiendas");
        const tiendaIds = new Set(tiendas.filter((row) => ids.has(row.pedido_id)).map((row) => row.id));
        this.db.tables.set(
          "pedido_tiendas",
          tiendas.filter((row) => !ids.has(row.pedido_id)),
        );
        this.db.tables.set(
          "pedido_items",
          this.db.rows("pedido_items").filter((row) => !tiendaIds.has(row.pedido_tienda_id)),
        );
        this.db.tables.set(
          "pedido_eventos",
          this.db.rows("pedido_eventos").filter((row) => !ids.has(row.pedido_id)),
        );
        for (const notice of this.db.rows("admin_notificaciones")) {
          if (ids.has(notice.pedido_id)) notice.pedido_id = null;
        }
      }
      if (!this.returning) return { data: null, error: null };
      return this.finish(removed);
    }

    const found = this.matched();
    if (this.head) {
      return { data: null, error: null, count: found.length };
    }
    return this.finish(found.map((row) => clone(row)));
  }

  private finish(rows: MemoryRow[]): QueryResult {
    const shaped = this.returning ? rows.map((row) => this.shape(row)) : rows;
    if (this.mode === "many") return { data: shaped, error: null, count: this.countExact ? shaped.length : null };
    if (shaped.length > 1 && this.limitN == null) {
      return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count: shaped.length };
    }
    return { data: shaped[0] ?? null, error: null, count: this.countExact ? shaped.length : null };
  }
}

export class MemorySupabase {
  constructor(private readonly db: MemoryDatabase) {}

  from(table: string): {
    select: (columns?: string, options?: { count?: "exact"; head?: boolean }) => MemoryQuery;
    insert: (payload: MemoryRow | MemoryRow[]) => MemoryQuery;
    update: (payload: MemoryRow) => MemoryQuery;
    upsert: (payload: MemoryRow | MemoryRow[], options?: { onConflict?: string }) => MemoryQuery;
    delete: () => MemoryQuery;
  } {
    return {
      select: (columns?: string, options?: { count?: "exact"; head?: boolean }) =>
        new MemoryQuery(this.db, table, "select").select(columns, options),
      insert: (payload: MemoryRow | MemoryRow[]) => new MemoryQuery(this.db, table, "insert", payload),
      update: (payload: MemoryRow) => new MemoryQuery(this.db, table, "update", payload),
      upsert: (payload: MemoryRow | MemoryRow[], options?: { onConflict?: string }) =>
        new MemoryQuery(this.db, table, "upsert", payload, options?.onConflict ?? null),
      delete: () => new MemoryQuery(this.db, table, "delete"),
    };
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<QueryResult> {
    if (fn === "increment_metrica" || fn === "read_and_reset_metricas") {
      return { data: fn === "read_and_reset_metricas" ? [] : null, error: null };
    }
    if (fn === "buscar_lista_productos_tienda_amplia" || fn === "buscar_lista_productos_tienda") {
      const tiendaId = Number(args.p_tienda_id);
      const tokens = Array.isArray(args.p_tokens) ? args.p_tokens.map((item) => String(item)) : [];
      const limit = Number(args.p_limit ?? 80);
      const rows = this.db
        .rows("productos_tienda")
        .filter((row) => same(row.tienda_id, tiendaId) && row.disponible !== false);
      const ranked = rankListaByTokens(
        rows.map((row) => ({
          id: Number(row.id),
          nombre: String(row.nombre_producto ?? ""),
          marca: row.marca == null ? null : String(row.marca),
          presentacion: row.presentacion == null ? null : String(row.presentacion),
          categoria: row.categoria == null ? null : String(row.categoria),
          alias: Array.isArray(row.alias) ? row.alias.map((item) => String(item)) : [],
          precio: row.precio == null ? null : Number(row.precio),
        })),
        tokens,
        Number.isFinite(limit) ? limit : 80,
      );
      return {
        data: ranked.map((item) => {
          const id = (item as { id?: number }).id;
          const source = rows.find((row) => Number(row.id) === id);
          return {
            id,
            nombre_producto: source?.nombre_producto ?? item.nombre,
            precio: source?.precio ?? item.precio ?? null,
            categoria: source?.categoria ?? item.categoria ?? null,
            marca: source?.marca ?? item.marca ?? null,
            presentacion: source?.presentacion ?? item.presentacion ?? null,
            alias: source?.alias ?? item.alias ?? [],
            rank: 1,
          };
        }),
        error: null,
      };
    }
    return { data: null, error: { message: `rpc ${fn} no está en el simulador` } };
  }
}

type FixtureProduct = {
  id: number;
  tienda_id: number;
  nombre_producto: string;
  precio: number | null;
  disponible: boolean;
  categoria?: string | null;
  marca?: string | null;
  presentacion?: string | null;
  alias?: string[];
};

function readProducts(path: string): FixtureProduct[] {
  return JSON.parse(readFileSync(path, "utf8")) as FixtureProduct[];
}

export type CatalogPriceReport = {
  pekesRows: number;
  pekesNullPrice: number;
  pekesWithPrice: number;
  georgeRows: number;
  centralRows: number;
};

export function seedFixtures(db: MemoryDatabase): CatalogPriceReport {
  const pekes = readProducts("scripts/fixtures/pekes-real.json");
  const george = readProducts("scripts/fixtures/george-catalogo.json");
  const central = readProducts("scripts/fixtures/lacentral-catalogo.json");
  const products = [...pekes, ...george, ...central].map((row) => ({
    id: row.id,
    tienda_id: row.tienda_id,
    nombre_producto: row.nombre_producto,
    precio: row.precio,
    disponible: row.disponible !== false,
    categoria: row.categoria ?? null,
    marca: row.marca ?? null,
    presentacion: row.presentacion ?? null,
    alias: Array.isArray(row.alias) ? row.alias : [],
  }));
  db.seed("productos_tienda", products);
  db.seed("tiendas", [
    {
      id: 7,
      nombre: "Mini Super Peke's",
      telefono: "5213300000007",
      direccion: "Ixtlahuacán del Río",
      categoria: "Abarrotes",
      activa: true,
      hora_apertura: "08:00",
      hora_cierre: "21:00",
      dias_cerrado: [],
      horario_por_dia: null,
      usa_catalogo_fijo: false,
      usa_lista_productos: true,
    },
    {
      id: 5,
      nombre: "Hamburguesas Hotdogs George",
      telefono: "5213300000005",
      direccion: "Ixtlahuacán del Río",
      categoria: "Restaurantes",
      activa: true,
      hora_apertura: "08:00",
      hora_cierre: "21:00",
      dias_cerrado: [],
      horario_por_dia: null,
      usa_catalogo_fijo: true,
      usa_lista_productos: false,
    },
    {
      id: 6,
      nombre: "Carnicería La Central",
      telefono: "5213300000006",
      direccion: "Ixtlahuacán del Río",
      categoria: "Carnicerías",
      activa: true,
      hora_apertura: "08:00",
      hora_cierre: "21:00",
      dias_cerrado: [],
      horario_por_dia: null,
      usa_catalogo_fijo: true,
      usa_lista_productos: false,
    },
  ]);
  db.seed("repartidores", [
    {
      id: 1,
      nombre: "Roberto",
      telefono: "5213300000011",
      activo: true,
      disponible: true,
      vehiculo: "moto",
      horario_json: { "0": { abre: "08:00", cierra: "21:00" }, "1": { abre: "08:00", cierra: "21:00" }, "2": { abre: "08:00", cierra: "21:00" }, "3": { abre: "08:00", cierra: "21:00" }, "4": { abre: "08:00", cierra: "21:00" }, "5": { abre: "08:00", cierra: "21:00" } },
    },
    {
      id: 2,
      nombre: "Mateo",
      telefono: "5213300000012",
      activo: true,
      disponible: true,
      vehiculo: "moto",
      horario_json: { "0": { abre: "15:00", cierra: "21:00" }, "1": { abre: "15:00", cierra: "21:00" }, "2": { abre: "15:00", cierra: "21:00" }, "3": { abre: "15:00", cierra: "21:00" }, "4": { abre: "15:00", cierra: "21:00" }, "5": { abre: "15:00", cierra: "21:00" }, "6": { abre: "08:00", cierra: "21:00" } },
    },
  ]);
  db.seed("configuracion", [{ clave: "admin_telefono", valor: "5213399990000" }]);
  db.seed("zonas_cobertura", [{ id: 1, nombre: "Ixtlahuacán del Río", activa: true }]);
  const pekesNullPrice = pekes.filter((row) => row.precio == null).length;
  return {
    pekesRows: pekes.length,
    pekesNullPrice,
    pekesWithPrice: pekes.length - pekesNullPrice,
    georgeRows: george.length,
    centralRows: central.length,
  };
}
