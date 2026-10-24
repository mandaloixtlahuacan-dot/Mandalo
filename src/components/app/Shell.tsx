"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PwaRegister } from "@/components/app/PwaRegister";

const LINKS = [
  { href: "/app", label: "Inicio" },
  { href: "/app/carrito", label: "Carrito" },
  { href: "/app/pedidos", label: "Pedido" },
  { href: "/app/cuenta", label: "Cuenta" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="marco">
      <header className="cabecera">
        <img className="wordmark" src="/brand/logo-crema.svg" alt="Mándalo" />
        <p className="slogan">Tu mandado a domicilio</p>
      </header>
      <PwaRegister />
      <main className="cuerpo">{children}</main>
      <nav className="nav">
        {LINKS.map((link) => {
          const active = link.href === "/app" ? pathname === "/app" : pathname.startsWith(link.href);
          return (
            <Link key={link.href} href={link.href} className={active ? "activo" : undefined}>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
