"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { RESTAURANT_EXTRAS, SALSA_SUGERENCIAS, useCart } from "@/components/app/cart";
import { PEKES_SHELVES, shelfVisual, type ShelfId } from "@/lib/app/shelves";

type Store = {
  id: number;
  nombre: string;
  abierta: boolean;
  abreTexto: string;
  horarioTexto: string;
  cotizar: boolean;
  usaLista: boolean;
  categoriaId: "abarrotes" | "carnicerias" | "restaurantes";
};
type Product = { id: number; nombre: string; precio: number | null; anaquel?: ShelfId };

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
  const [anaquel, setAnaquel] = useState<ShelfId | "">("");
  const [body, setBody] = useState<SearchBody | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [extras, setExtras] = useState<string[]>([]);
  const [nota, setNota] = useState("");
  const [salsa, setSalsa] = useState("");
  const [added, setAdded] = useState("");

  useEffect(() => {
    if (!Number.isInteger(tiendaId)) return;
    const handle = window.setTimeout(() => {
      const url = `/api/app/tiendas/${tiendaId}/productos?page=${page}&q=${encodeURIComponent(q.trim())}&anaquel=${encodeURIComponent(anaquel)}`;
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
  }, [tiendaId, q, page, anaquel]);

  const store = body?.tienda;
  const products = body?.productos ?? [];
  const pageSize = body?.pageSize ?? 20;
  const total = body?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const restaurante = store?.categoriaId === "restaurantes";

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
      extras: restaurante ? extras : [],
      nota: restaurante ? "" : nota,
      salsa: restaurante ? salsa : "",
    });
    setAdded(product.nombre);
    setOpenId(null);
    setQty(1);
    setExtras([]);
    setNota("");
    setSalsa("");
  }

  return (
    <>
      <Link href={store ? `/app/categoria/${store.categoriaId}` : "/app"} className="ayuda">← Tiendas</Link>
      <h1>{store?.nombre ?? "Tienda"}</h1>
      {store ? <p className="ayuda">{store.abierta ? "Abierta" : store.abreTexto || "Cerrada"}{store.horarioTexto ? ` · ${store.horarioTexto}` : ""}</p> : null}
      {store && !store.abierta ? <p className="aviso">Si confirmas ahora, el pedido espera a que se pueda repartir.</p> : null}
      {store?.cotizar ? <p className="aviso">Precio estimado. La tienda confirma el final.</p> : null}
      {error ? <p className="aviso error">{error}</p> : null}
      {added ? <p className="aviso">Agregaste {added}. <Link href="/app/carrito">Ver carrito</Link></p> : null}
      {store?.usaLista ? (
        <div className="chips chips-scroll">
          {PEKES_SHELVES.map((shelf) => (
            <button
              key={shelf.id}
              type="button"
              className={anaquel === shelf.id ? "chip encendido" : "chip"}
              onClick={() => {
                setPage(1);
                setAnaquel((current) => (current === shelf.id ? "" : shelf.id));
              }}
            >
              {shelf.icono} {shelf.titulo}
            </button>
          ))}
        </div>
      ) : null}
      <input
        className="campo"
        value={q}
        placeholder={store?.usaLista ? "Busca, por ejemplo Takis" : "Busca en el menú"}
        onChange={(event) => {
          setPage(1);
          setQ(event.target.value);
        }}
      />
      {body?.necesitaBusqueda || body?.mensaje ? <p className="ayuda">{body.mensaje}</p> : null}
      <div className="lista">
        {products.map((product) => {
          const shelf = shelfVisual(product.anaquel ?? "otros");
          return (
            <article key={product.id} className="tarjeta producto-tarjeta">
              <div className="producto">
                <span className="producto-icono" aria-hidden="true">{store?.usaLista ? shelf.icono : restaurante ? "🍔" : "🥩"}</span>
                <div>
                  <strong className="nombre-grande">{product.nombre}</strong>
                  {store?.usaLista ? <p className="ayuda">{shelf.titulo}</p> : null}
                </div>
                <span className="precio">{store?.cotizar ? "Por cotizar" : money(product.precio)}</span>
              </div>
              {openId === product.id ? (
                <div className="lista">
                  <input className="campo" type="number" min={1} max={20} value={qty} onChange={(event) => setQty(Number(event.target.value))} />
                  {restaurante ? (
                    <>
                      <div className="chips">
                        {RESTAURANT_EXTRAS.map((extra) => (
                          <button key={extra} type="button" className={extras.includes(extra) ? "chip encendido" : "chip"} onClick={() => setExtras((current) => current.includes(extra) ? current.filter((item) => item !== extra) : [...current, extra])}>
                            {extra}
                          </button>
                        ))}
                      </div>
                      <p className="ayuda">Si deseas alguna salsa o condimento especial (BBQ, Buffalo...), indícalo aquí</p>
                      <div className="chips">
                        {SALSA_SUGERENCIAS.map((item) => (
                          <button key={item} type="button" className={salsa === item ? "chip encendido" : "chip"} onClick={() => setSalsa(item)}>{item}</button>
                        ))}
                      </div>
                      <input className="campo" value={salsa} maxLength={80} placeholder="BBQ, Buffalo u otra" onChange={(event) => setSalsa(event.target.value)} />
                    </>
                  ) : (
                    <input className="campo" value={nota} maxLength={120} placeholder="Nota para la tienda" onChange={(event) => setNota(event.target.value)} />
                  )}
                  <button type="button" className="boton" onClick={() => add(product)}>Agregar</button>
                </div>
              ) : (
                <button type="button" className="boton claro" onClick={() => { setOpenId(product.id); setQty(1); setExtras([]); setNota(""); setSalsa(""); }}>Agregar</button>
              )}
            </article>
          );
        })}
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
  if (value == null || !Number.isFinite(value)) return "";
  return `$${value}`;
}
