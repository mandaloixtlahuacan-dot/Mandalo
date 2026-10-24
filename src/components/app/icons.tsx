import type { ReactNode } from "react";

type IconProps = { className?: string };

function Trazo({ className = "icono", children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function IconoCasa(props: IconProps) {
  return (
    <Trazo {...props}>
      <path d="M4 11.2 12 4l8 7.2" />
      <path d="M7 10.2V20h10V10.2" />
    </Trazo>
  );
}

export function IconoCarrito(props: IconProps) {
  return (
    <Trazo {...props}>
      <path d="M6 7h14l-1.4 9H7.2z" />
      <path d="M6 7 4.8 4H2" />
      <path d="M9 20h.01M17 20h.01" />
    </Trazo>
  );
}

export function IconoPedido(props: IconProps) {
  return (
    <Trazo {...props}>
      <circle cx="7.5" cy="17" r="2" />
      <circle cx="17" cy="17" r="2" />
      <path d="M4 17h1.5M9.5 17h5.5" />
      <path d="M14 17V8h4.5L21 12.5V17" />
      <path d="M14 11h5" />
    </Trazo>
  );
}

export function IconoCuenta(props: IconProps) {
  return (
    <Trazo {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.2 19.5c1.3-3.2 3.6-4.7 6.8-4.7s5.5 1.5 6.8 4.7" />
    </Trazo>
  );
}

export function IconoMas(props: IconProps) {
  return (
    <Trazo {...props}>
      <path d="M12 5v14M5 12h14" />
    </Trazo>
  );
}

export function IconoAnaquel({ id }: { id: string }) {
  const trazo = ANAQUEL[id] ?? ANAQUEL.otros;
  return <Trazo>{trazo()}</Trazo>;
}

const ANAQUEL: Record<string, () => ReactNode> = {
  bebidas: () => (
    <>
      <path d="M8 3h8v7a4 4 0 0 1-8 0V3z" />
      <path d="M12 14v3.2M9 20h6" />
    </>
  ),
  botanas: () => (
    <>
      <path d="M8 7.5c0-2.6 8-2.6 8 0l1 12H7l1-12z" />
      <path d="M9 7.5c.6-1.8 5.4-1.8 6 0" />
    </>
  ),
  dulces: () => (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M9 9 5.5 5.5M15 15l3.5 3.5M15 9l3.5-3.5M9 15l-3.5 3.5" />
    </>
  ),
  lacteos: () => <path d="M10 3h4v3l2 2.5V21H8V8.5L10 6V3z" />,
  panaderia: () => (
    <>
      <path d="M4 14c0-4 3.4-7 8-7s8 3 8 7v3H4v-3z" />
      <path d="M8 12c.6 1 1.4 1 2 0M14 12c.6 1 1.4 1 2 0" />
    </>
  ),
  despensa: () => (
    <>
      <path d="M5 8h14l-1.2 11H6.2z" />
      <path d="M9 8V6.5A3 3 0 0 1 12 3.5 3 3 0 0 1 15 6.5V8" />
    </>
  ),
  sazonadores: () => (
    <>
      <path d="M9.5 8h5L13 21h-2z" />
      <path d="M10 4h4v4h-4z" />
    </>
  ),
  enlatados: () => (
    <>
      <ellipse cx="12" cy="6.5" rx="5" ry="2" />
      <path d="M7 6.5v11c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-11" />
    </>
  ),
  limpieza: () => (
    <>
      <path d="M10 11h4v9h-4z" />
      <path d="M11 11V8h2l3-4" />
    </>
  ),
  higiene: () => (
    <>
      <path d="M10 8h4v2l1 2v8H9v-8l1-2V8z" />
      <path d="M11 4h2v4h-2z" />
    </>
  ),
  bebes: () => <path d="M10 2.5h4V6l1.5 2v11a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2V8L10 6V2.5z" />,
  mascotas: () => (
    <>
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="6.2" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="6.6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="15.2" rx="3.3" ry="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  otros: () => (
    <>
      <path d="M4 8.5 12 4.5l8 4v9l-8 4-8-4v-9z" />
      <path d="M4 8.5 12 12.5l8-4M12 12.5V21" />
    </>
  ),
};

export function IconoHamburguesa(props: IconProps) {
  return (
    <Trazo {...props}>
      <path d="M4.5 10.5c.4-3.4 3.2-5.5 7.5-5.5s7.1 2.1 7.5 5.5z" />
      <path d="M4.5 13.2h15M4.5 16.2h15" />
    </Trazo>
  );
}

export function IconoCarne(props: IconProps) {
  return (
    <Trazo {...props}>
      <path d="M7 14c.6-5 5.2-8 11-6 1.6 5.2-1.4 10.2-6.4 10.2-3.6 0-5.2-1.6-4.6-4.2z" />
      <path d="M15 9.5c1.4 1.2 2 2.4 1.6 3.6" />
    </Trazo>
  );
}
