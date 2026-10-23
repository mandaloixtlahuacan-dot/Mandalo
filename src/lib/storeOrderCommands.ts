/**
 * Comandos de la tienda y los textos que salen de ellos.
 * Puro: no toca Supabase ni WhatsApp.
 *
 * Abarrotes cotiza con `ORDEN #N PRECIO 150`.
 * George y La Central (menú con precio) confirman con `ORDEN #N CONFIRMO`.
 * Las tres marcan un faltante con `ORDEN #N NO HAY producto`
 * (varios productos, separados por coma).
 */

import { formatCustomerFeeLine } from "@/lib/customerUx";
import { STORE_QUOTE_REMINDER_AT_MINUTES, STORE_QUOTE_TIMEOUT_MINUTES } from "@/lib/services/orderTimeouts";
import { isNoConfirmation, isYesConfirmation } from "@/lib/messages";
import {
  calculateFinalPrice,
  extraerComandoNoDisponible,
  extraerPrecio,
  formatMoney,
} from "@/lib/ordenes";

export function comandoNoHay(ordenId: number, producto = "nombre del producto"): string {
  return `ORDEN #${ordenId} NO HAY ${producto}`;
}

export function comandoConfirmoTienda(ordenId: number): string {
  return `ORDEN #${ordenId} CONFIRMO`;
}

export function comandoPrecio(ordenId: number): string {
  return `ORDEN #${ordenId} PRECIO 150`;
}

function entregaBlock(direccion: string | null | undefined): string {
  const text = String(direccion ?? "").trim();
  return text ? `📍 *Entrega:*\n${text}\n\n` : "";
}

function faltanteBlock(ordenId: number): string {
  return `¿Te falta algún producto?\n\n*Responde:*\n${comandoNoHay(ordenId)}\n\nSi son varios, sepáralos con coma.`;
}

/** Aviso a abarrotes: cotiza precio. George y La Central confirman en los mismos 15 min. */
export function formatAbarrotesQuoteRequest(params: {
  pedidoId: number;
  direccion?: string | null;
  pedidoTexto: string;
}): string {
  return (
    `🏪 *Cotizar. ORDEN #${params.pedidoId}*\n\n` +
    `${entregaBlock(params.direccion)}` +
    `🛒 *Pedido*\n\n${params.pedidoTexto}\n\n` +
    `*Responde así:*\n${comandoPrecio(params.pedidoId)}\n\n` +
    faltanteBlock(params.pedidoId)
  );
}

/**
 * Aviso a George / La Central. El precio ya viene del menú.
 * No piden PRECIO: confirman el pedido antes de que pase al repartidor.
 */
export function formatCatalogStoreConfirmRequest(params: {
  pedidoId: number;
  direccion?: string | null;
  pedidoTexto: string;
  subtotal: number;
  total: number;
}): string {
  return (
    `🏪 *Confirmar. ORDEN #${params.pedidoId}*\n\n` +
    `Ya trae precio del menú. Confírmalo para mandarlo al repartidor.\n\n` +
    `${entregaBlock(params.direccion)}` +
    `🛒 *Pedido*\n\n${params.pedidoTexto}\n\n` +
    `*Subtotal: ${formatMoney(params.subtotal)}*\n\n` +
    `${formatCustomerFeeLine()}\n\n` +
    `💵 *Total a pagar: ${formatMoney(params.total)}*\n\n` +
    `*Responde así:*\n${comandoConfirmoTienda(params.pedidoId)}\n\n` +
    faltanteBlock(params.pedidoId)
  );
}

export function formatStorePendingReminder(params: {
  pedidoId: number;
  pedidoTexto: string;
  catalogo: boolean;
}): string {
  const espera = params.catalogo
    ? `El pedido #${params.pedidoId} sigue esperando tu confirmación.`
    : `El pedido #${params.pedidoId} sigue esperando tu precio.`;
  const comando = params.catalogo ? comandoConfirmoTienda(params.pedidoId) : comandoPrecio(params.pedidoId);
  const restantes = STORE_QUOTE_TIMEOUT_MINUTES - STORE_QUOTE_REMINDER_AT_MINUTES;
  return (
    `⏰ *Recordatorio*\n\n` +
    `${espera}\n\n` +
    `🛒 *Pedido*\n\n${params.pedidoTexto}\n\n` +
    `Tienes *${restantes} minutos* antes de que se cancele.\n\n` +
    `*Responde así:*\n${comando}\n\n` +
    faltanteBlock(params.pedidoId)
  );
}

export function formatStoreQuoteTimeoutCancel(pedidoId: number, catalogo: boolean): string {
  const verbo = catalogo ? "confirmarlo" : "cotizarlo";
  return `🏪 *Pedido #${pedidoId}*\n\nSe canceló por falta de respuesta a tiempo. Ya no es necesario ${verbo}.`;
}

export function formatProductAdjustmentReminder(params: {
  pedidoId: number;
  itemNombre: string;
  mode: unknown;
}): string {
  if (params.mode === "confirmar_restante") {
    return (
      `⏰ *Pedido #${params.pedidoId}*\n\n` +
      `Sigue esperando tu decisión. Quitamos: *${params.itemNombre}*.\n\n` +
      `Responde *SÍ* o *NO* en los próximos *5 minutos*. Si no, se cancelará.`
    );
  }
  return (
    `⏰ *Pedido #${params.pedidoId}*\n\n` +
    `Sigue esperando tu decisión sobre *"${params.itemNombre}"*.\n\n` +
    `Responde en los próximos *5 minutos*: escribe *sin él* para continuar sin ese producto, o dime por cuál lo cambio. Si no, se cancelará.`
  );
}

/** El mensaje completo es la confirmación de una tienda de menú fijo. */
export function extraerComandoConfirmoTienda(texto: string): number | null {
  const raw = String(texto ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/g, "");
  if (!raw) return null;
  if (extraerComandoNoDisponible(raw) || extraerPrecio(raw) != null) return null;
  const patterns = [
    /^orden\s*#?\s*(\d+)\s+confirmo$/i,
    /^confirmo\s+orden\s*#?\s*(\d+)$/i,
    /^#confirmo\s+(\d+)$/i,
    /^confirmo\s+#?\s*(\d+)$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

/** Un producto, o varios separados por coma o punto y coma. */
export function partirProductosNoDisponibles(productoTexto: string): string[] {
  return String(productoTexto ?? "")
    .split(/\s*[,;]\s*/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

export function mensajeClienteConfirmarSinProductos(params: {
  tiendaNombre: string | null | undefined;
  faltantes: string[];
  pedidoTexto: string;
  subtotal: number | null;
  catalogo: boolean;
}): string {
  const tienda = params.tiendaNombre?.trim() || "La tienda";
  const quitados = params.faltantes.map((name) => `- *${name}*`).join("\n");
  const fees = formatCustomerFeeLine();
  const precio =
    params.catalogo && params.subtotal != null
      ? `*Subtotal: ${formatMoney(params.subtotal)}*\n\n${fees}\n\n💵 *Total a pagar: ${formatMoney(calculateFinalPrice(params.subtotal))}*`
      : `${fees}\n\nLa tienda confirma el precio de lo que sí hay. El envío y el servicio siguen igual.`;
  const siguiente = params.catalogo
    ? "Responde *SÍ* para que la tienda lo confirme, o *NO* para cancelar."
    : "Responde *SÍ* para que la tienda confirme el precio, o *NO* para cancelar.";
  return (
    `🏪 *${tienda}* no tiene:\n\n${quitados}\n\n` +
    `Tu pedido quedaría así:\n\n` +
    `🛒 *Tu pedido*\n\n${params.pedidoTexto}\n\n` +
    `${precio}\n\n` +
    `¿Lo dejamos así?\n\n${siguiente}`
  );
}

export function mensajeClientePedidoVacioPorFaltante(params: {
  tiendaNombre: string | null | undefined;
  pedidoId: number;
  faltantes: string[];
}): string {
  const tienda = params.tiendaNombre?.trim() || "La tienda";
  const quitados = params.faltantes.map((name) => `- *${name}*`).join("\n");
  return (
    `🏪 *${tienda}* no tiene:\n\n${quitados}\n\n` +
    `Era todo el pedido #${params.pedidoId}, así que lo cancelé.\n\n` +
    `Cuando quieras, hacemos uno nuevo.`
  );
}

export function decidirConfirmacionRestante(texto: string): "si" | "no" | "repetir" {
  if (isYesConfirmation(texto)) return "si";
  if (isNoConfirmation(texto)) return "no";
  return "repetir";
}
