import { DELIVERY_FEE, MANDALO_SERVICE_FEE, calculateOrderTotal, formatMoney } from "@/lib/ordenes";

export const APP_ENVIO = DELIVERY_FEE;
export const APP_SERVICIO = MANDALO_SERVICE_FEE;

export type CartMoneyLine = {
  precio: number | null;
  cantidad: number;
  cotizar: boolean;
};

export type CartSummary = {
  subtotal: number;
  envio: number;
  servicio: number;
  total: number;
  cotizar: boolean;
  subtotalTexto: string;
  envioTexto: string;
  servicioTexto: string;
  totalTexto: string;
};

/** El cargo fijo siempre entra. Si algo se cotiza, el subtotal es estimado. */
export function summarizeCart(lines: CartMoneyLine[]): CartSummary {
  const subtotal = lines.reduce((sum, line) => {
    const price = line.precio;
    if (price == null || !Number.isFinite(price) || price < 0) return sum;
    return sum + price * line.cantidad;
  }, 0);
  const rounded = Math.round(subtotal * 100) / 100;
  const total = calculateOrderTotal(rounded).total;
  const cotizar = lines.length === 0 || lines.some((line) => line.cotizar || line.precio == null);
  return {
    subtotal: rounded,
    envio: APP_ENVIO,
    servicio: APP_SERVICIO,
    total,
    cotizar,
    subtotalTexto: cotizar ? `${formatMoney(rounded)} estimado` : formatMoney(rounded),
    envioTexto: formatMoney(APP_ENVIO),
    servicioTexto: formatMoney(APP_SERVICIO),
    totalTexto: cotizar ? `${formatMoney(total)} estimado` : formatMoney(total),
  };
}
