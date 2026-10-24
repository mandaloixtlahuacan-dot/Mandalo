import type { SupabaseClient } from "@supabase/supabase-js";

import { phoneIsStaff } from "@/lib/app/auth";
import { categoryForStore } from "@/lib/app/categories";
import { isMissingColumn } from "@/lib/app/dbError";
import { composeStoreItemName, formatSeparateNotes } from "@/lib/app/itemText";
import { decideCoverage } from "@/lib/app/coverage";
import { parseAppPhone, phoneVariants, whatsappTo } from "@/lib/app/phone";
import { scheduleAppPush } from "@/lib/app/notifyHook";
import { describeWhyWaiting, scheduledCustomerMessage } from "@/lib/app/scheduleCopy";
import { formatCatalogAwaitingStore, formatQuoteOrderRegistered, storeKindFromCategoria } from "@/lib/customerUx";
import { calculateOrderTotal } from "@/lib/ordenes";
import type { OrderState } from "@/lib/orderStateMachine";
import type { PedidoFullRecord } from "@/lib/repositories/pedidoRepositoryV2";
import { buildAddressTextFromCoords } from "@/lib/services/geo";
import { checkMandaloSchedule, checkTiendaSchedule, parseDiasCerrado } from "@/lib/services/businessHours";
import { buildEsperandoAperturaMetadata } from "@/lib/services/orderTimeouts";
import type { EnqueueOutboundMessageInput } from "@/lib/services/dispatchWorker";
import type { DispatchCotizacionResult } from "@/lib/services/storeDispatch";
import type { CatalogPriceRow } from "@/lib/catalogQuantities";

const EXTRAS_OK = new Set(["Sin cebolla", "Bien cocido", "Término medio"]);

export type PlaceLineInput = {
  productoId: number;
  cantidad: number;
  extras: string[];
  nota: string;
  salsa?: string;
};

export type PlaceInput = {
  telefono: string;
  nombre: string;
  tiendaId: number;
  lines: PlaceLineInput[];
  latitude: number | null;
  longitude: number | null;
  referencia: string | null;
  now?: Date;
};

export type PlacePorts = {
  supabase: SupabaseClient;
  enqueue(input: EnqueueOutboundMessageInput): Promise<number>;
  dispatch(
    pedido: PedidoFullRecord,
    params: { fromEstado: OrderState; actorTipo: "cliente"; catalogAlreadyConfirmed?: boolean },
  ): Promise<DispatchCotizacionResult>;
  findCouriers(): Promise<unknown[]>;
  cancelNoCourier(pedido: PedidoFullRecord): Promise<void>;
};

export type PlaceResult =
  | { ok: true; pedidoId: number; estado: OrderState; mensaje: string; programado: boolean }
  | { ok: false; status: number; code: string; mensaje: string; pedidoId?: number };

type ProductRow = {
  id: number;
  tienda_id: number;
  nombre_producto: string;
  precio: number;
  disponible: boolean;
};

export async function placeAppOrder(input: PlaceInput, ports: PlacePorts): Promise<PlaceResult> {
  const telefono = parseAppPhone(input.telefono);
  const nombre = String(input.nombre ?? "").replace(/\s+/g, " ").trim();
  if (!telefono || nombre.length < 2) return fail(400, "DATOS", "Falta el nombre o el WhatsApp.");
  if (!input.lines.length) return fail(400, "CARRITO", "El carrito está vacío.");
  if (input.lines.length > 40) return fail(400, "CARRITO", "Son demasiados productos para un solo pedido.");

  const blocked = await phoneIsStaff(ports.supabase, telefono);
  if (blocked === "missing") return fail(503, "BASE", "No pude revisar si ese número es de una tienda.");
  if (blocked) return fail(409, "NUMERO_DE_TRABAJO", "Ese número es de una tienda o un repartidor. Para pedir, usa otro WhatsApp.");

  const open = await ports.supabase
    .from("pedidos")
    .select("id, estado")
    .in("cliente_telefono", phoneVariants(telefono))
    .not("estado", "in", "(entregado,cancelado)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open.error) return fail(500, "PEDIDO", "No pude revisar si ya tienes un pedido abierto.");
  if (open.data?.id) {
    return {
      ok: false,
      status: 409,
      code: "PEDIDO_ABIERTO",
      mensaje: "Ya tienes un pedido abierto. Síguelo o espera a que se cierre antes de armar otro.",
      pedidoId: Number(open.data.id),
    };
  }

  const tiendaResult = await ports.supabase
    .from("tiendas")
    .select("id, nombre, categoria, telefono, direccion, activa, hora_apertura, hora_cierre, dias_cerrado, horario_por_dia, usa_catalogo_fijo")
    .eq("id", input.tiendaId)
    .maybeSingle();
  if (tiendaResult.error) return fail(500, "TIENDA", "No pude leer la tienda.");
  const tienda = tiendaResult.data as Record<string, unknown> | null;
  if (!tienda || tienda.activa !== true || !String(tienda.telefono ?? "").trim()) {
    return fail(404, "TIENDA", "Esa tienda no está activa.");
  }

  const ids = input.lines.map((line) => Number(line.productoId)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length !== input.lines.length) return fail(400, "CARRITO", "Hay un producto que no reconocí.");
  const productsResult = await ports.supabase
    .from("productos_tienda")
    .select("id, tienda_id, nombre_producto, precio, disponible")
    .in("id", ids);
  if (productsResult.error) return fail(500, "CARRITO", "No pude leer los productos.");
  const byId = new Map<number, ProductRow>();
  for (const row of (productsResult.data ?? []) as ProductRow[]) {
    if (Number(row.tienda_id) === Number(tienda.id) && row.disponible !== false) byId.set(Number(row.id), row);
  }

  const cotizar = tienda.usa_catalogo_fijo !== true;
  const catalog: CatalogPriceRow[] | null = cotizar
    ? null
    : [...byId.values()].map((row) => ({ nombreProducto: String(row.nombre_producto), precio: Number(row.precio) }));

  const prepared: Array<{ productoId: number; nombre: string; cantidad: number; extras: string[]; nota: string; precio: number; notasAparte: boolean }> = [];
  for (const line of input.lines) {
    const product = byId.get(Number(line.productoId));
    if (!product) return fail(400, "CARRITO", "Un producto ya no está disponible en esa tienda.");
    const cantidad = Math.round(Number(line.cantidad));
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) return fail(400, "CARRITO", "La cantidad tiene que ser de 1 a 20.");
    const restaurante = categoryForStore({
      nombre: String(tienda.nombre ?? ""),
      categoria: tienda.categoria == null ? null : String(tienda.categoria),
    }) === "restaurantes";
    const extras = restaurante ? cleanExtras(line.extras) : [];
    const nota = joinNote(restaurante ? cleanSalsa(line.salsa ?? "") : "", cleanNote(line.nota));
    const composed = composeStoreItemName(String(product.nombre_producto), extras, nota, catalog);
    prepared.push({
      productoId: Number(product.id),
      nombre: composed.nombre,
      cantidad,
      extras,
      nota,
      precio: Number(product.precio) || 0,
      notasAparte: composed.notasAparte,
    });
  }

  const referencia = cleanAddress(input.referencia ?? "") || null;
  const zones = await loadZones(ports.supabase);
  const coverage = decideCoverage({
    latitude: input.latitude,
    longitude: input.longitude,
    referencia,
    zones,
  });
  if (!coverage.ok) return fail(400, "COBERTURA", coverage.mensaje);

  const now = input.now ?? new Date();
  const horaApertura = tienda.hora_apertura == null ? null : String(tienda.hora_apertura);
  const horaCierre = tienda.hora_cierre == null ? null : String(tienda.hora_cierre);
  const diasCerrado = parseDiasCerrado(tienda.dias_cerrado);
  const tiendaSchedule = checkTiendaSchedule({
    horaApertura,
    horaCierre,
    diasCerrado,
    horarioPorDia: tienda.horario_por_dia,
    now,
  });
  const mandaloSchedule = checkMandaloSchedule(now);
  const direccion = formatAddress(coverage.latitude, referencia || coverage.zona);
  const subtotal = prepared.reduce((sum, line) => sum + line.precio * line.cantidad, 0);
  const total = cotizar ? null : calculateOrderTotal(subtotal).total;
  const storeKind = storeKindFromCategoria(tienda.categoria == null ? null : String(tienda.categoria));
  const metadata = {
    origen: "app",
    app_items: prepared.map((line) => ({
      productoId: line.productoId,
      nombre: line.nombre,
      cantidad: line.cantidad,
      extras: line.extras,
      nota: line.nota,
    })),
    capture_snapshot: {
      customerName: nombre,
      businessId: Number(tienda.id),
      businessName: String(tienda.nombre),
      businessPhone: String(tienda.telefono),
      addressText: direccion,
      addressZone: coverage.zona,
      latitud: coverage.latitude,
      longitud: coverage.longitude,
      storeKind,
      items: prepared.map((line) => ({
        nombre_producto: line.nombre,
        cantidad: line.cantidad,
        notas: [...line.extras, line.nota].filter(Boolean).join(", ") || null,
        producto_id: line.productoId,
      })),
      flags: {
        addressValidated: true,
        itemsValidated: true,
        readyForConfirmation: true,
        productosConfirmados: true,
        agentCart: false,
      },
    },
  };

  await ports.supabase.from("clientes").upsert(
    { telefono, nombre, direccion_entrega: direccion },
    { onConflict: "telefono" },
  );

  const inserted = await ports.supabase
    .from("pedidos")
    .insert({
      cliente_telefono: telefono,
      estado: "confirmacion_cliente",
      servicio_mandalo: calculateOrderTotal(0).servicioMandalo,
      servicio_repartidor: calculateOrderTotal(0).servicioDomicilio,
      direccion_entrega: direccion,
      latitud: coverage.latitude,
      longitud: coverage.longitude,
      total_cliente: total,
      metadata_json: metadata,
    })
    .select("id")
    .maybeSingle();
  if (inserted.error || !inserted.data?.id) return fail(500, "PEDIDO", "No pude crear el pedido.");
  const pedidoId = Number(inserted.data.id);

  const origen = await ports.supabase.from("pedidos").update({ origen: "app" }).eq("id", pedidoId);
  if (origen.error && !isMissingColumn(origen.error)) {
    console.error("[app] no se pudo marcar pedidos.origen", origen.error.message);
  }

  const tiendaLink = await ports.supabase
    .from("pedido_tiendas")
    .insert({ pedido_id: pedidoId, tienda_id: Number(tienda.id), estado_tienda: "pendiente" })
    .select("id")
    .maybeSingle();
  if (tiendaLink.error || !tiendaLink.data?.id) return fail(500, "PEDIDO", "No pude ligar la tienda al pedido.", pedidoId);
  const pedidoTiendaId = Number(tiendaLink.data.id);

  const itemRows = await ports.supabase
    .from("pedido_items")
    .insert(prepared.map((line) => ({ pedido_tienda_id: pedidoTiendaId, nombre_producto: line.nombre, cantidad: line.cantidad })))
    .select("id, nombre_producto, cantidad");
  if (itemRows.error) return fail(500, "PEDIDO", "No pude guardar los productos.", pedidoId);

  await ports.supabase.from("pedido_eventos").insert({
    pedido_id: pedidoId,
    tipo_evento: "pedido_app",
    estado_origen: null,
    estado_destino: "confirmacion_cliente",
    actor_tipo: "cliente",
    payload_json: { origen: "app", tiendaId: Number(tienda.id) },
  });

  const pedido = buildRecord({
    pedidoId,
    telefono,
    direccion,
    latitude: coverage.latitude,
    longitude: coverage.longitude,
    total,
    metadata,
    tienda,
    pedidoTiendaId,
    horaApertura,
    horaCierre,
    diasCerrado,
    cotizar,
    items: ((itemRows.data ?? []) as Array<{ id: unknown; nombre_producto: unknown; cantidad: unknown }>).map((row) => ({
      id: Number(row.id),
      nombreProducto: String(row.nombre_producto ?? ""),
      cantidad: row.cantidad == null ? null : Number(row.cantidad),
      disponible: true,
    })),
  });

  const puedeDespachar = tiendaSchedule.withinSchedule && mandaloSchedule.withinSchedule;
  if (!puedeDespachar) {
    const patch = { ...metadata, ...buildEsperandoAperturaMetadata(now.toISOString()) };
    const waiting = await ports.supabase
      .from("pedidos")
      .update({ estado: "esperando_apertura_tienda", metadata_json: patch, updated_at: now.toISOString() })
      .eq("id", pedidoId);
    if (waiting.error) return fail(500, "PEDIDO", "No pude programar el pedido.", pedidoId);
    await ports.enqueue(customerMessage(pedidoId, telefono, scheduledCustomerMessage(pedidoId, describeWhyWaiting({
      tiendaNombre: String(tienda.nombre),
      tiendaSchedule,
      mandaloSchedule,
    }))));
    await scheduleAppPush({ pedidoId, estado: "esperando_apertura_tienda", previousEstado: "confirmacion_cliente" });
    return {
      ok: true,
      pedidoId,
      estado: "esperando_apertura_tienda",
      programado: true,
      mensaje: "Quedó programado. Te avisamos por WhatsApp en cuanto se pueda mandar.",
    };
  }

  if (!cotizar) {
    const couriers = await ports.findCouriers();
    if (!couriers.length) {
      await ports.cancelNoCourier(pedido);
      return {
        ok: true,
        pedidoId,
        estado: "cancelado",
        programado: false,
        mensaje: "Ahorita no hay repartidor en horario. No se te cobra nada. Te escribimos por WhatsApp.",
      };
    }
  }

  const dispatched = await ports.dispatch(pedido, {
    fromEstado: "confirmacion_cliente",
    actorTipo: "cliente",
    catalogAlreadyConfirmed: !cotizar,
  });
  if (!dispatched.ok) {
    return fail(502, "AVISO_TIENDA", "El pedido quedó armado, pero no pude avisarle a la tienda. Escríbenos por WhatsApp.", pedidoId);
  }

  const body = cotizar
    ? formatQuoteOrderRegistered(pedidoId, String(tienda.nombre ?? "la tienda"))
    : formatCatalogAwaitingStore(pedidoId, String(tienda.nombre ?? "la tienda"));
  await ports.enqueue(customerMessage(pedidoId, telefono, body));

  const notes = prepared.filter((line) => line.notasAparte).map((line) => `- ${line.nombre}: ${[...line.extras, line.nota].filter(Boolean).join(", ")}`);
  if (notes.length && tienda.telefono) {
    await ports.enqueue({
      pedidoId,
      tipoMensaje: "cotizacion_tienda",
      destinatarioTipo: "negocio",
      destinatarioId: Number(tienda.id),
      telefonoDestino: whatsappTo(String(tienda.telefono)),
      payload: { body: formatSeparateNotes(pedidoId, notes) },
      idempotencyKey: `pedido:${pedidoId}:app:notas:v1`,
    });
  }

  return {
    ok: true,
    pedidoId,
    estado: "pendiente_tiendas",
    programado: false,
    mensaje: cotizar
      ? "Ya va para la tienda. El precio final lo confirma ella y te llega por WhatsApp."
      : "Ya va para la tienda. En cuanto confirme, sale el repartidor.",
  };
}

async function loadZones(supabase: SupabaseClient): Promise<string[] | null> {
  const result = await supabase.from("zonas_cobertura").select("nombre").eq("activa", true).limit(500);
  if (result.error) return null;
  return ((result.data ?? []) as Array<{ nombre?: unknown }>).map((row) => String(row.nombre ?? "")).filter(Boolean);
}

function formatAddress(latitude: number | null, referencia: string | null): string {
  if (referencia) return referencia;
  return latitude != null ? buildAddressTextFromCoords() : "";
}

function customerMessage(pedidoId: number, telefono: string, body: string): EnqueueOutboundMessageInput {
  return {
    pedidoId,
    tipoMensaje: "notificacion_cliente",
    destinatarioTipo: "cliente",
    destinatarioId: null,
    telefonoDestino: whatsappTo(telefono),
    payload: { body },
    idempotencyKey: `pedido:${pedidoId}:app:confirmacion:v1`,
  };
}

function cleanExtras(extras: string[]): string[] {
  const unique = new Set<string>();
  for (const extra of extras) {
    const text = String(extra ?? "").replace(/\s+/g, " ").trim();
    if (EXTRAS_OK.has(text)) unique.add(text);
  }
  return [...unique].slice(0, 4);
}

function cleanNote(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function cleanSalsa(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanAddress(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function joinNote(salsa: string, nota: string): string {
  return [salsa, nota].filter(Boolean).join(". ").slice(0, 120);
}

function buildRecord(params: {
  pedidoId: number;
  telefono: string;
  direccion: string;
  latitude: number | null;
  longitude: number | null;
  total: number | null;
  metadata: Record<string, unknown>;
  tienda: Record<string, unknown>;
  pedidoTiendaId: number;
  horaApertura: string | null;
  horaCierre: string | null;
  diasCerrado: number[];
  cotizar: boolean;
  items: PedidoFullRecord["items"];
}): PedidoFullRecord {
  const snapshot = (params.metadata.capture_snapshot ?? {}) as PedidoFullRecord["snapshot"];
  return {
    id: params.pedidoId,
    estado: "confirmacion_cliente",
    clienteTelefono: params.telefono,
    repartidorId: null,
    direccionEntrega: params.direccion,
    latitud: params.latitude,
    longitud: params.longitude,
    servicioMandalo: calculateOrderTotal(0).servicioMandalo,
    servicioRepartidor: calculateOrderTotal(0).servicioDomicilio,
    totalCliente: params.total,
    metadata: params.metadata,
    snapshot,
    tienda: {
      pedidoTiendaId: params.pedidoTiendaId,
      tiendaId: Number(params.tienda.id),
      nombre: String(params.tienda.nombre ?? ""),
      telefono: String(params.tienda.telefono ?? ""),
      direccion: params.tienda.direccion == null ? null : String(params.tienda.direccion),
      horaApertura: params.horaApertura,
      horaCierre: params.horaCierre,
      subtotal: null,
      estadoTienda: "pendiente",
      usaCatalogoFijo: !params.cotizar,
      diasCerrado: params.diasCerrado,
      horarioPorDia: params.tienda.horario_por_dia ?? null,
    },
    items: params.items,
  };
}

function fail(status: number, code: string, mensaje: string, pedidoId?: number): PlaceResult {
  return { ok: false, status, code, mensaje, pedidoId };
}
