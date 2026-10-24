"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { summarizeCart, type CartSummary } from "@/lib/app/cartMath";

export type CartLine = {
  key: string;
  productoId: number;
  tiendaId: number;
  tiendaNombre: string;
  cotizar: boolean;
  nombre: string;
  precio: number | null;
  cantidad: number;
  extras: string[];
  nota: string;
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

export const EXTRAS = ["Con verdura", "Sin verdura", "Sin cebolla", "Bien cocido", "Término medio"];

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [address, setAddress] = useState<SavedAddress | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CART_KEY);
      const savedAddress = window.localStorage.getItem(ADDRESS_KEY);
      if (stored) setLines(JSON.parse(stored) as CartLine[]);
      if (savedAddress) setAddress(JSON.parse(savedAddress) as SavedAddress);
    } catch {
      setLines([]);
    }
    setReady(true);
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
        setLines((current) => {
          if (current.length && current[0].tiendaId !== line.tiendaId) {
            const replace = window.confirm("El carrito es de otra tienda. ¿Lo vacío y empiezo con esta?");
            if (!replace) return current;
            return [{ ...line, key: crypto.randomUUID() }];
          }
          const key = `${line.productoId}:${line.extras.join("|")}:${line.nota}`;
          const existing = current.find((item) => item.key === key);
          if (existing) {
            return current.map((item) => (item.key === key ? { ...item, cantidad: Math.min(20, item.cantidad + line.cantidad) } : item));
          }
          return [...current, { ...line, key }];
        });
      },
      updateLine(key, patch) {
        setLines((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
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
