"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useCart } from "@/components/app/cart";

export default function CartPage() {
  const cart = useCart();
  const router = useRouter();
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const storeId = cart.lines[0]?.tiendaId;

  async function confirm() {
    if (!storeId || !cart.address) return;
    setBusy(true);
    setError("");
    setMensaje("");
    try {
      const response = await fetch("/api/app/pedidos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tiendaId: storeId,
          lines: cart.lines.map((line) => ({
            productoId: line.productoId,
            cantidad: line.cantidad,
            extras: line.extras,
            nota: line.nota,
            salsa: line.salsa ?? "",
          })),
          latitude: cart.address.latitude,
          longitude: cart.address.longitude,
          referencia: cart.address.texto || cart.address.referencia,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; mensaje?: string; pedidoId?: number; code?: string };
      if (!body.ok) {
        if (body.code === "PEDIDO_ABIERTO" && body.pedidoId) {
          router.push(`/app/pedido/${body.pedidoId}`);
          return;
        }
        setError(body.mensaje || "No pude confirmar.");
        return;
      }
      cart.clear();
      setMensaje(body.mensaje || "Pedido recibido.");
      if (body.pedidoId) router.push(`/app/pedido/${body.pedidoId}`);
    } catch {
      setError("No pude confirmar.");
    } finally {
      setBusy(false);
    }
  }

  if (!cart.ready) return <p className="ayuda">Cargando carrito…</p>;

  return (
    <>
      <h1>Carrito</h1>
      {cart.lines.length === 0 ? <p className="ayuda">Todavía no agregas nada. <Link href="/app">Ver tiendas</Link></p> : null}
      <div className="lista">
        {cart.lines.map((line) => (
          <article key={line.key} className="tarjeta linea">
            <div>
              <strong>{line.nombre}</strong>
              <p className="ayuda">{line.tiendaNombre}</p>
              {line.extras.length ? <p className="ayuda">{line.extras.join(", ")}</p> : null}
              {line.nota ? <p className="ayuda">Nota: {line.nota}</p> : null}
              {line.salsa ? <p className="ayuda">Salsa: {line.salsa}</p> : null}
              <div className="paginas">
                <button type="button" className="boton claro" onClick={() => cart.updateLine(line.key, { cantidad: Math.max(1, line.cantidad - 1) })}>−</button>
                <span>{line.cantidad}</span>
                <button type="button" className="boton claro" onClick={() => cart.updateLine(line.key, { cantidad: Math.min(20, line.cantidad + 1) })}>+</button>
              </div>
            </div>
            <div>
              <div className="precio">{line.cotizar || line.precio == null ? "Por cotizar" : `$${line.precio}`}</div>
              <button type="button" className="boton claro" onClick={() => cart.removeLine(line.key)}>Quitar</button>
            </div>
          </article>
        ))}
      </div>
      {cart.lines.length ? (
        <section className="tarjeta" style={{ marginTop: 16 }}>
          {cart.summary.cotizar ? <p className="aviso">Total estimado. La tienda confirma el precio de los productos.</p> : null}
          <p className="total"><span>Productos</span><span>{cart.summary.subtotalTexto}</span></p>
          <p className="total"><span>Envío</span><span>{cart.summary.envioTexto}</span></p>
          <p className="total"><span>servicio</span><span>{cart.summary.servicioTexto}</span></p>
          <p className="total"><b>Total</b><b>{cart.summary.totalTexto}</b></p>
          <p className="ayuda">Pagas en efectivo al repartidor.</p>
        </section>
      ) : null}
      <section className="tarjeta" style={{ marginTop: 12 }}>
        <h2>Entrega</h2>
        {cart.address ? <p>{cart.address.texto || cart.address.referencia || "Pin guardado"}</p> : <p className="ayuda">Falta el pin de entrega.</p>}
        <Link href="/app/direccion" className="boton claro" style={{ display: "block", textAlign: "center", marginTop: 10 }}>
          {cart.address ? "Cambiar dirección" : "Poner el pin"}
        </Link>
      </section>
      {error ? <p className="aviso error">{error}</p> : null}
      {mensaje ? <p className="aviso">{mensaje}</p> : null}
      <button type="button" className="boton" style={{ marginTop: 14 }} disabled={busy || !cart.lines.length || !cart.address} onClick={() => void confirm()}>
        {busy ? "Enviando…" : "Confirmar pedido"}
      </button>
      {error.includes("Entra") ? <p className="ayuda"><Link href="/app/cuenta">Entra o regístrate</Link></p> : null}
    </>
  );
}
