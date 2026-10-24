"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PwaRegister } from "@/components/app/PwaRegister";

const LINKS = [
  { href: "/app", label: "Inicio", icono: "🏠" },
  { href: "/app/carrito", label: "Carrito", icono: "🛒" },
  { href: "/app/pedidos", label: "Pedido", icono: "🛵" },
  { href: "/app/cuenta", label: "Cuenta", icono: "👤" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="marco">
      <header className="cabecera">
        <img className="wordmark" src="/brand/logo-crema.svg" alt="Mándalo" />
      </header>
      <PwaRegister />
      <main className="cuerpo">{children}</main>
      <nav className="nav">
        {LINKS.map((link) => {
          const active = link.href === "/app"
            ? pathname === "/app" || pathname.startsWith("/app/categoria") || pathname.startsWith("/app/tienda")
            : pathname.startsWith(link.href);
          return (
            <Link key={link.href} href={link.href} className={active ? "activo" : undefined}>
              <span className="nav-icono">{link.icono}</span>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
