"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { EXTRAS, useCart } from "@/components/app/cart";

type Store = { id: number; nombre: string; abierta: boolean; abreTexto: string; horarioTexto: string; cotizar: boolean; usaLista: boolean };
type Product = { id: number; nombre: string; precio: number | null; categoria: string | null };

type SearchBody = {
  ok?: boolean;
  mensaje?: string;
  tienda?: Store;
  productos?: Product[];
  total?: number;
  pageSize?: number;
  necesitaBusqueda?: boolean;
};

export default function StorePage() {
  const params = useParams<{ id: string }>();
  const tiendaId = Number(params.id);
  const cart = useCart();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [body, setBody] = useState<SearchBody | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [extras, setExtras] = useState<string[]>([]);
  const [nota, setNota] = useState("");
  const [added, setAdded] = useState("");

  useEffect(() => {
    if (!Number.isInteger(tiendaId)) return;
    const handle = window.setTimeout(() => {
      const url = `/api/app/tiendas/${tiendaId}/productos?page=${page}&q=${encodeURIComponent(q.trim())}`;
      void fetch(url)
        .then((response) => response.json())
        .then((next: SearchBody) => {
          if (!next.ok) {
            setError(next.mensaje || "No pude cargar la tienda.");
            setBody(null);
            return;
          }
          setError("");
          setBody(next);
        })
        .catch(() => setError("No pude cargar la tienda."));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [tiendaId, q, page]);

  const store = body?.tienda;
  const products = body?.productos ?? [];
  const pageSize = body?.pageSize ?? 20;
  const total = body?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  function toggleExtra(extra: string) {
    setExtras((current) => (current.includes(extra) ? current.filter((item) => item !== extra) : [...current, extra].slice(0, 4)));
  }

  function add(product: Product) {
    if (!store) return;
    cart.addLine({
      productoId: product.id,
      tiendaId: store.id,
      tiendaNombre: store.nombre,
      cotizar: store.cotizar,
      nombre: product.nombre,
      precio: product.precio,
      cantidad: qty,
      extras,
      nota,
    });
    setAdded(product.nombre);
    setOpenId(null);
    setQty(1);
    setExtras([]);
    setNota("");
  }

  return (
    <>
      <Link href="/app" className="ayuda">← Tiendas</Link>
      <h1>{store?.nombre ?? "Tienda"}</h1>
      {store ? (
        <p className="ayuda">
          {store.abierta ? "Abierta ahora" : store.abreTexto || "Cerrada ahora"}
          {store.horarioTexto ? ` · ${store.horarioTexto}` : ""}
        </p>
      ) : null}
      {store && !store.abierta ? (
        <p className="aviso">Si confirmas ahora, el pedido se programa y sale en cuanto se pueda repartir.</p>
      ) : null}
      {store?.cotizar ? <p className="aviso">El precio de anaquel es un estimado. La tienda confirma el final, como en WhatsApp.</p> : null}
      {error ? <p className="aviso error">{error}</p> : null}
      {added ? <p className="aviso">Agregaste {added}. <Link href="/app/carrito">Ver carrito</Link></p> : null}
      <input
        className="campo"
        value={q}
        placeholder={store?.usaLista ? "Busca un producto" : "Filtra el menú"}
        onChange={(event) => {
          setPage(1);
          setQ(event.target.value);
        }}
      />
      {body?.necesitaBusqueda ? <p className="ayuda">{body.mensaje}</p> : null}
      {body?.mensaje && !body.necesitaBusqueda ? <p className="ayuda">{body.mensaje}</p> : null}
      <div className="lista">
        {products.map((product) => (
          <article key={product.id} className="tarjeta">
            <div className="producto">
              <div>
                <strong>{product.nombre}</strong>
                {product.categoria ? <p className="ayuda">{product.categoria}</p> : null}
              </div>
              <span className="precio">{store?.cotizar ? "Por cotizar" : money(product.precio)}</span>
            </div>
            {openId === product.id ? (
              <div className="lista">
                <label className="ayuda">Cantidad
                  <input className="campo" type="number" min={1} max={20} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
                </label>
                <div className="chips">
                  {EXTRAS.map((extra) => (
                    <button key={extra} type="button" className={extras.includes(extra) ? "chip encendido" : "chip"} onClick={() => toggleExtra(extra)}>
                      {extra}
                    </button>
                  ))}
                </div>
                <input className="campo" value={nota} maxLength={120} placeholder="Nota para la tienda" onChange={(event) => setNota(event.target.value)} />
                <button type="button" className="boton" onClick={() => add(product)}>Agregar</button>
              </div>
            ) : (
              <button
                type="button"
                className="boton claro"
                onClick={() => {
                  setOpenId(product.id);
                  setQty(1);
                  setExtras([]);
                  setNota("");
                }}
              >
                Elegir
              </button>
            )}
          </article>
        ))}
      </div>
      {pages > 1 ? (
        <div className="paginas">
          <button type="button" className="boton claro" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Anterior</button>
          <span>{page} / {pages}</span>
          <button type="button" className="boton claro" disabled={page >= pages} onClick={() => setPage((current) => current + 1)}>Siguiente</button>
        </div>
      ) : null}
    </>
  );
}

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Por cotizar";
  return `$${value}`;
}
