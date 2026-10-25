"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { RESTAURANT_EXTRAS, SALSA_SUGERENCIAS, useCart } from "@/components/app/cart";
import { MiniaturaCategoria } from "@/components/app/ilustraciones";
import { IconoMas } from "@/components/app/icons";
import { SelectorKilos } from "@/components/app/SelectorKilos";
import { isBebidaAlcoholica } from "@/lib/app/alcohol";
import { butcherLine, formatKilos, parseKilos } from "@/lib/kiloLabel";
import { FILTER_SHELVES, type ShelfId } from "@/lib/app/shelves";

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
type Product = { id: number; nombre: string; precio: number | null; categoria?: string | null; anaquel?: ShelfId };

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
  const [anaquel, setAnaquel] = useState("todos");
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [body, setBody] = useState<SearchBody | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [kilosTexto, setKilosTexto] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<string[]>([]);
  const [nota, setNota] = useState("");
  const [salsa, setSalsa] = useState("");
  const [added, setAdded] = useState("");

  useEffect(() => {
    if (!Number.isInteger(tiendaId)) return;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      const url = `/api/app/tiendas/${tiendaId}/productos?page=${page}&q=${encodeURIComponent(q.trim())}&anaquel=${encodeURIComponent(anaquel)}`;
      setLoading(true);
      void fetch(url, { signal: controller.signal })
        .then((response) => response.json())
        .then((next: SearchBody) => {
          if (controller.signal.aborted) return;
          if (!next.ok) {
            setError(next.mensaje || "No pude cargar la tienda.");
            setBody(null);
            return;
          }
          const incoming = (next.productos ?? []).filter((product) => !isBebidaAlcoholica(product.nombre, product.categoria));
          setError("");
          setBody(next);
          setTotal(next.total ?? incoming.length);
          setProducts((current) => (page === 1 ? incoming : [...current, ...incoming]));
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError("No pude cargar la tienda.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 280);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [tiendaId, q, page, anaquel]);

  const store = body?.tienda;
  const restaurante = store?.categoriaId === "restaurantes";
  const carniceria = store?.categoriaId === "carnicerias";
  const miniatura = store?.usaLista ? null : restaurante ? "restaurantes" : "carnicerias";
  const hayMas = products.length < total;

  function elegirAnaquel(id: string) {
    setProducts([]);
    setPage(1);
    setAnaquel(id);
  }

  function add(product: Product) {
    if (!store) return;
    if (isBebidaAlcoholica(product.nombre, product.categoria)) return;
    const kilos = carniceria ? parseKilos(kilosTexto[product.id] ?? "1") : null;
    if (carniceria && kilos == null) {
      setError("Escribe kilos mayores a 0 y hasta 10.");
      return;
    }
    cart.addLine({
      productoId: product.id,
      tiendaId: store.id,
      tiendaNombre: store.nombre,
      cotizar: store.cotizar,
      nombre: product.nombre,
      precio: product.precio,
      cantidad: carniceria ? kilos ?? 1 : qty,
      unidad: carniceria ? "kg" : "pieza",
      extras: restaurante ? extras : [],
      nota: restaurante || carniceria ? "" : nota,
      salsa: restaurante ? salsa : "",
    });
    setAdded(carniceria && kilos != null ? butcherLine(product.nombre, kilos) : product.nombre);
    setOpenId(null);
    setQty(1);
    setExtras([]);
    setNota("");
    setSalsa("");
  }

  return (
    <>
      <header className="tienda-hero">
        <Link href={store ? `/app/categoria/${store.categoriaId}` : "/app"} className="volver">Tiendas</Link>
        <h1>{store?.nombre ?? "Tienda"}</h1>
        {store ? (
          <div className="tienda-meta">
            <span className={store.abierta ? "pastilla abierta" : "pastilla"}>{store.abierta ? "Abierta" : "Cerrada"}</span>
            <span>{store.abierta ? store.horarioTexto : store.abreTexto || store.horarioTexto}</span>
          </div>
        ) : null}
      </header>
      <div className="buscar-fija">
        <input
          className="campo buscar"
          value={q}
          placeholder={store?.usaLista ? "Busca un producto" : "Busca en el menú"}
          onChange={(event) => {
            setPage(1);
            setQ(event.target.value);
          }}
        />
      </div>
      {store && !store.abierta ? <p className="aviso">Si confirmas ahora, el pedido espera a que se pueda repartir.</p> : null}
      {store?.cotizar ? <p className="aviso">Precio estimado. La tienda confirma el final.</p> : null}
      {error ? <p className="aviso error">{error}</p> : null}
      {added ? <p className="aviso">Agregaste {added}. <Link href="/app/carrito">Ver carrito</Link></p> : null}
      {store?.usaLista ? (
        <>
          <h2 className="fila-titulo">Categorías</h2>
          <div className="carrusel">
            <button type="button" className={anaquel === "todos" ? "chip encendido" : "chip"} onClick={() => elegirAnaquel("todos")}>
              <MiniaturaCategoria id="todos" />
              Todos
            </button>
            {FILTER_SHELVES.map((shelf) => (
              <button key={shelf.id} type="button" className={anaquel === shelf.id ? "chip encendido" : "chip"} onClick={() => elegirAnaquel(shelf.id)}>
                <MiniaturaCategoria id={shelf.id} />
                {shelf.titulo}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {body?.necesitaBusqueda || body?.mensaje ? <p className="ayuda">{body.mensaje}</p> : null}
      {!loading && products.length === 0 && !body?.necesitaBusqueda ? <p className="ayuda">No encontré ese producto.</p> : null}
      <div className="lista">
        {products.map((product) => {
          const ilustracion = miniatura ?? product.anaquel ?? "otros";
          return (
            <article key={product.id} className="tarjeta comida">
              <div className="comida-cuerpo">
                <span className="comida-icono">
                  <MiniaturaCategoria id={ilustracion} />
                </span>
                <div>
                  <strong className="nombre-grande">{product.nombre}</strong>
                  <span className="precio-visible">
                    {store?.cotizar ? "Por cotizar" : carniceria ? `${money(product.precio)} / kg` : money(product.precio)}
                  </span>
                </div>
                {carniceria || openId === product.id ? null : (
                  <button type="button" className="mas" aria-label={`Agregar ${product.nombre}`} onClick={() => { setOpenId(product.id); setQty(1); setExtras([]); setNota(""); setSalsa(""); }}>
                    <IconoMas />
                  </button>
                )}
              </div>
              {carniceria ? (
                <div className="lista">
                  <SelectorKilos
                    value={kilosTexto[product.id] ?? "1"}
                    onChange={(text) => setKilosTexto((current) => ({ ...current, [product.id]: text }))}
                  />
                  {product.precio != null && parseKilos(kilosTexto[product.id] ?? "1") != null ? (
                    <p className="ayuda">
                      {formatKilos(parseKilos(kilosTexto[product.id] ?? "1") ?? 1)} · {money((product.precio ?? 0) * (parseKilos(kilosTexto[product.id] ?? "1") ?? 1))}
                    </p>
                  ) : null}
                  <button type="button" className="boton" onClick={() => add(product)}>Agregar</button>
                </div>
              ) : null}
              {!carniceria && openId === product.id ? (
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
              ) : null}
            </article>
          );
        })}
      </div>
      {hayMas ? (
        <button type="button" className="boton claro" disabled={loading} onClick={() => setPage((current) => current + 1)}>
          {loading ? "Cargando…" : "Cargar más"}
        </button>
      ) : null}
      {loading && products.length === 0 ? <p className="ayuda">Cargando…</p> : null}
    </>
  );
}

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}
