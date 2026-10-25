"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { isBebidaAlcoholica } from "@/lib/app/alcohol";
import { summarizeCart, type CartSummary } from "@/lib/app/cartMath";
import { MAX_KILOS, parseKilos, roundKilos } from "@/lib/kiloLabel";

export type CartLine = {
  key: string;
  productoId: number;
  tiendaId: number;
  tiendaNombre: string;
  cotizar: boolean;
  nombre: string;
  precio: number | null;
  cantidad: number;
  unidad: "kg" | "pieza";
  extras: string[];
  nota: string;
  salsa: string;
};

export type SavedAddress = {
  latitude: number | null;
  longitude: number | null;
  referencia: string;
  texto: string;
  regla: string;
};

type CartContextValue = {
  ready: boolean;
  lines: CartLine[];
  summary: CartSummary;
  address: SavedAddress | null;
  addLine(line: Omit<CartLine, "key">): void;
  updateLine(key: string, patch: Partial<Pick<CartLine, "cantidad" | "extras" | "nota">>): void;
  removeLine(key: string): void;
  clear(): void;
  saveAddress(address: SavedAddress): void;
};

const CartContext = createContext<CartContextValue | null>(null);
const CART_KEY = "mandalo.carrito.v1";
const ADDRESS_KEY = "mandalo.direccion.v1";

export const RESTAURANT_EXTRAS = ["Sin cebolla", "Bien cocido", "Término medio"];
export const SALSA_SUGERENCIAS = ["BBQ", "Buffalo", "Chipotle", "Ranch", "Mango habanero"];

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [address, setAddress] = useState<SavedAddress | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(CART_KEY);
        const savedAddress = window.localStorage.getItem(ADDRESS_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as CartLine[];
          setLines(parsed.filter((line) => !isBebidaAlcoholica(line.nombre)).map((line) => ({
            ...line,
            unidad: line.unidad === "kg" ? "kg" : "pieza",
          })));
        }
        if (savedAddress) setAddress(JSON.parse(savedAddress) as SavedAddress);
      } catch {
        setLines([]);
      }
      setReady(true);
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(CART_KEY, JSON.stringify(lines));
  }, [lines, ready]);

  const value = useMemo<CartContextValue>(() => {
    const summary = summarizeCart(lines.map((line) => ({ precio: line.precio, cantidad: line.cantidad, cotizar: line.cotizar })));
    return {
      ready,
      lines,
      summary,
      address,
      addLine(line) {
        if (isBebidaAlcoholica(line.nombre)) return;
        setLines((current) => {
          if (current.length && current[0].tiendaId !== line.tiendaId) {
            const replace = window.confirm("El carrito es de otra tienda. ¿Lo vacío y empiezo con esta?");
            if (!replace) return current;
            return [{ ...line, key: crypto.randomUUID() }];
          }
          const key = `${line.productoId}:${line.unidad}:${line.extras.join("|")}:${line.nota}:${line.salsa}`;
          const existing = current.find((item) => item.key === key);
          if (existing) {
            const suma = existing.unidad === "kg" ? roundKilos(existing.cantidad + line.cantidad) : existing.cantidad + line.cantidad;
            const tope = existing.unidad === "kg" ? MAX_KILOS : 20;
            return current.map((item) => (item.key === key ? { ...item, cantidad: Math.min(tope, suma) } : item));
          }
          return [...current, { ...line, unidad: line.unidad === "kg" ? "kg" : "pieza", key }];
        });
      },
      updateLine(key, patch) {
        setLines((current) => current.map((item) => {
          if (item.key !== key) return item;
          if (patch.cantidad == null) return { ...item, ...patch };
          if (item.unidad === "kg") {
            const kilos = parseKilos(patch.cantidad);
            return kilos == null ? item : { ...item, ...patch, cantidad: kilos };
          }
          const piezas = Math.round(patch.cantidad);
          if (!Number.isInteger(piezas) || piezas < 1 || piezas > 20) return item;
          return { ...item, ...patch, cantidad: piezas };
        }));
      },
      removeLine(key) {
        setLines((current) => current.filter((item) => item.key !== key));
      },
      clear() {
        setLines([]);
      },
      saveAddress(next) {
        setAddress(next);
        window.localStorage.setItem(ADDRESS_KEY, JSON.stringify(next));
      },
    };
  }, [address, lines, ready]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) throw new Error("useCart fuera del carrito");
  return value;
}
