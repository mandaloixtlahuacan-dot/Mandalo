"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCart } from "@/components/app/cart";
import { formatKilos } from "@/lib/kiloLabel";
import { IconoCarrito, IconoCasa, IconoCuenta, IconoPedido } from "@/components/app/icons";
import { PwaRegister } from "@/components/app/PwaRegister";

const LINKS = [
  { href: "/app", label: "Inicio", icono: IconoCasa },
  { href: "/app/carrito", label: "Carrito", icono: IconoCarrito },
  { href: "/app/pedidos", label: "Pedido", icono: IconoPedido },
  { href: "/app/cuenta", label: "Cuenta", icono: IconoCuenta },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="marco">
      <header className="cabecera">
        <div className="marca">
          <img className="monograma" src="/brand/monograma.svg" alt="" />
          <span className="marca-nombre">Mándalo</span>
        </div>
      </header>
      <PwaRegister />
      <main className="cuerpo">{children}</main>
      <CarritoFlotante />
      <nav className="nav">
        {LINKS.map((link) => {
          const active = link.href === "/app"
            ? pathname === "/app" || pathname.startsWith("/app/categoria") || pathname.startsWith("/app/tienda")
            : pathname.startsWith(link.href);
          const Icono = link.icono;
          return (
            <Link key={link.href} href={link.href} className={active ? "activo" : undefined}>
              <span className="nav-icono"><Icono /></span>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function CarritoFlotante() {
  const cart = useCart();
  const pathname = usePathname();
  if (!cart.ready || cart.lines.length === 0 || pathname.startsWith("/app/carrito")) return null;
  const enKilos = cart.lines.every((line) => line.unidad === "kg");
  const piezas = enKilos
    ? cart.lines.length === 1
      ? formatKilos(cart.lines[0]?.cantidad ?? 0)
      : String(cart.lines.length)
    : String(cart.lines.reduce((sum, line) => sum + line.cantidad, 0));
  return (
    <Link href="/app/carrito" className="carrito-flotante">
      <span>Ver carrito · {piezas}</span>
      <strong>{cart.summary.totalTexto}</strong>
    </Link>
  );
}
