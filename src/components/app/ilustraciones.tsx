import type { ReactNode } from "react";

/**
 * Miniaturas planas, una por anaquel. Van dibujadas en el SVG:
 * no hay fotos ni archivos generados.
 */
function Marco({ fondo, children }: { fondo: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" className="ilustracion-mini" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill={fondo} />
      {children}
    </svg>
  );
}

function Higiene() {
  return (
    <Marco fondo="#D7E8F7">
      <ellipse cx="30" cy="34" rx="15" ry="15" fill="#FFFFFF" />
      <ellipse cx="30" cy="34" rx="6" ry="6" fill="#F2C4A0" />
      <ellipse cx="30" cy="34" rx="2.5" ry="2.5" fill="#E7B089" />
      <path d="M44 32c7 1 10 6 10 10H40c1-4 2-8 4-10z" fill="#FFFFFF" />
    </Marco>
  );
}

function Bebidas() {
  return (
    <Marco fondo="#D9F3E4">
      <rect x="27" y="8" width="10" height="7" rx="2" fill="#F2C14E" />
      <path d="M28 14h8l2 8c6 2 8 8 8 14v14a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V36c0-6 2-12 8-14l2-8z" fill="#2E9E62" />
      <rect x="23" y="34" width="18" height="10" rx="2" fill="#FFFFFF" />
    </Marco>
  );
}

function Botanas() {
  return (
    <Marco fondo="#FFF1C9">
      <path d="M22 18c2-6 18-6 20 0l4 30c0 4-4 8-14 8s-14-4-14-8l4-30z" fill="#F5C518" />
      <path d="M24 18c2-3 14-3 16 0-2 3-14 3-16 0z" fill="#E09A12" />
      <ellipse cx="32" cy="36" rx="8" ry="9" fill="#E23B3B" />
      <circle cx="29" cy="34" r="1.4" fill="#F6E27A" />
      <circle cx="34" cy="38" r="1.4" fill="#F6E27A" />
    </Marco>
  );
}

function Enlatados() {
  return (
    <Marco fondo="#F8D6D6">
      <rect x="18" y="18" width="28" height="28" fill="#E23B3B" />
      <ellipse cx="32" cy="46" rx="14" ry="6" fill="#C42C2C" />
      <ellipse cx="32" cy="18" rx="14" ry="6" fill="#F4F4F4" />
      <rect x="23" y="28" width="18" height="12" rx="2" fill="#FFFFFF" />
    </Marco>
  );
}

function Lacteos() {
  return (
    <Marco fondo="#FFF3C4">
      <path d="M14 46 32 16l18 30H14z" fill="#F6C445" />
      <circle cx="28" cy="36" r="3" fill="#E0A82E" />
      <circle cx="36" cy="40" r="2.4" fill="#E0A82E" />
      <circle cx="33" cy="28" r="2" fill="#E0A82E" />
    </Marco>
  );
}

function Panaderia() {
  return (
    <Marco fondo="#F8E0C8">
      <path d="M12 40c0-14 8-22 20-22s20 8 20 22v8H12v-8z" fill="#E8A15A" />
      <ellipse cx="24" cy="34" rx="2" ry="6" fill="#C9843A" transform="rotate(-18 24 34)" />
      <ellipse cx="32" cy="32" rx="2" ry="6" fill="#C9843A" />
      <ellipse cx="40" cy="34" rx="2" ry="6" fill="#C9843A" transform="rotate(18 40 34)" />
    </Marco>
  );
}

function Limpieza() {
  return (
    <Marco fondo="#D6ECFB">
      <rect x="26" y="10" width="12" height="8" rx="2" fill="#F2C14E" />
      <path d="M27 16h10l2 6H25l2-6z" fill="#2F80ED" />
      <rect x="22" y="22" width="18" height="28" rx="6" fill="#3D8BF0" />
      <path d="M40 28h6a6 6 0 0 1 0 12h-6v-4h4a2 2 0 0 0 0-4h-4v-4z" fill="#2F80ED" />
      <rect x="26" y="32" width="10" height="8" rx="2" fill="#FFFFFF" />
    </Marco>
  );
}

function Sazonadores() {
  return (
    <Marco fondo="#FDE2D2">
      <path d="M34 20c10 2 16 14 10 26-6 12-18 10-20 2-2-10 0-22 4-26 2-2 4-4 6-2z" fill="#E23B3B" />
      <path d="M30 18c2-8 12-8 14-1-4-1-8 0-10 3-2-1-3-1-4-2z" fill="#3E9B4A" />
      <ellipse cx="40" cy="30" rx="2" ry="3.2" fill="#F7D27A" />
    </Marco>
  );
}

function Bebes() {
  return (
    <Marco fondo="#FDE7F1">
      <path d="M16 26h32c0 16-6 26-16 26S16 42 16 26z" fill="#7EC8E3" />
      <rect x="12" y="22" width="10" height="12" rx="4" fill="#5BB4D6" />
      <rect x="42" y="22" width="10" height="12" rx="4" fill="#5BB4D6" />
      <path d="M22 30h20c0 10-4 16-10 16s-10-6-10-16z" fill="#FFFFFF" />
    </Marco>
  );
}

function Mascotas() {
  return (
    <Marco fondo="#F8E8D4">
      <g transform="rotate(-28 32 32)">
        <rect x="22" y="28" width="20" height="8" rx="3" fill="#F0D2A0" />
        <circle cx="20" cy="28" r="6" fill="#F0D2A0" />
        <circle cx="20" cy="36" r="6" fill="#F0D2A0" />
        <circle cx="44" cy="28" r="6" fill="#F0D2A0" />
        <circle cx="44" cy="36" r="6" fill="#F0D2A0" />
      </g>
    </Marco>
  );
}

function Despensa() {
  return (
    <Marco fondo="#E7F0D8">
      <path d="M20 28c0-12 24-12 24 0h-5c0-7-14-7-14 0h-5z" fill="#A56B32" />
      <path d="M16 30h32l-4 20H20L16 30z" fill="#C68642" />
      <rect x="24" y="34" width="3" height="12" fill="#A56B32" />
      <rect x="31" y="34" width="3" height="12" fill="#A56B32" />
      <rect x="38" y="34" width="3" height="12" fill="#A56B32" />
    </Marco>
  );
}

function Dulces() {
  return (
    <Marco fondo="#FDE3EE">
      <polygon points="8,32 22,24 22,40" fill="#FF8FB8" />
      <polygon points="56,32 42,24 42,40" fill="#FF8FB8" />
      <rect x="18" y="24" width="28" height="16" rx="8" fill="#FF5A8A" />
      <circle cx="32" cy="32" r="4" fill="#FFD23F" />
    </Marco>
  );
}

function Todos() {
  return (
    <Marco fondo="#F3F3F3">
      <rect x="16" y="16" width="14" height="14" rx="4" fill="#E23B3B" />
      <rect x="34" y="16" width="14" height="14" rx="4" fill="#F5C518" />
      <rect x="16" y="34" width="14" height="14" rx="4" fill="#2E9E62" />
      <rect x="34" y="34" width="14" height="14" rx="4" fill="#3D8BF0" />
    </Marco>
  );
}

function Otros() {
  return (
    <Marco fondo="#F4EFE6">
      <path d="M22 22c0-6 20-6 20 0v4H22v-4z" fill="#CDB892" />
      <path d="M18 26h28l-3 26H21L18 26z" fill="#E6D3B3" />
    </Marco>
  );
}

function Restaurantes() {
  return (
    <Marco fondo="#FFF3CC">
      <path d="M14 28c0-8 36-8 36 0H14z" fill="#E8A15A" />
      <rect x="16" y="30" width="32" height="5" fill="#3E9B4A" />
      <rect x="18" y="35" width="28" height="5" fill="#C46A3A" />
      <path d="M14 42c0 6 36 6 36 0H14z" fill="#F2C14E" />
    </Marco>
  );
}

function Carnicerias() {
  return (
    <Marco fondo="#FFE6D4">
      <path d="M16 36c4-14 28-18 36-6 4 8-2 20-16 22S12 48 16 36z" fill="#E86A6A" />
      <ellipse cx="42" cy="28" rx="6" ry="5" fill="#F4E1C1" />
    </Marco>
  );
}

const DIBUJOS: Record<string, () => ReactNode> = {
  higiene: Higiene,
  bebidas: Bebidas,
  botanas: Botanas,
  enlatados: Enlatados,
  lacteos: Lacteos,
  panaderia: Panaderia,
  limpieza: Limpieza,
  sazonadores: Sazonadores,
  bebes: Bebes,
  mascotas: Mascotas,
  despensa: Despensa,
  dulces: Dulces,
  todos: Todos,
  otros: Otros,
  abarrotes: Despensa,
  restaurantes: Restaurantes,
  carnicerias: Carnicerias,
};

export function MiniaturaCategoria({ id }: { id: string }) {
  const Dibujo = DIBUJOS[id] ?? Otros;
  return <Dibujo />;
}
