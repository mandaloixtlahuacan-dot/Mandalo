"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type Step = { id: string; titulo: string; detalle: string; hecho: boolean; actual: boolean; destacado: boolean };
type OrderView = {
  id: number;
  estado: string;
  titulo: string;
  tienda: string;
  direccion: string | null;
  totalTexto: string | null;
  cotizar: boolean;
  pasos: Step[];
  items: Array<{ id: number; nombre: string; cantidad: number | null; extras: string[]; nota: string }>;
  puedeConfirmarTotal: boolean;
};

export default function TrackingPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [pedido, setPedido] = useState<OrderView | null>(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  useEffect(() => {
    if (!id) return;
    const key = `mandalo.pedido.${id}`;
    let stop = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/app/pedidos/${id}`);
        const body = (await response.json()) as { ok?: boolean; pedido?: OrderView; mensaje?: string; code?: string };
        if (stop) return;
        if (!body.ok || !body.pedido) {
          if (body.code === "CERRADO") {
            const cached = window.sessionStorage.getItem(key);
            if (cached) setPedido(JSON.parse(cached) as OrderView);
            setAviso(body.mensaje || "Este pedido ya se cerró.");
          } else {
            setError(body.mensaje || "No pude ver el pedido.");
          }
          return;
        }
        setError("");
        setPedido(body.pedido);
        window.sessionStorage.setItem(key, JSON.stringify(body.pedido));
      } catch {
        if (!stop) setError("No pude ver el pedido.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [id]);

  async function confirmTotal() {
    const response = await fetch(`/api/app/pedidos/${id}/confirmar`, { method: "POST" });
    const body = (await response.json()) as { ok?: boolean; mensaje?: string };
    setAviso(body.mensaje || (body.ok ? "Listo." : "No pude confirmar el total."));
  }

  const enCamino = pedido?.estado === "en_camino_cliente" || pedido?.estado === "recogiendo";

  return (
    <>
      <h1>{pedido?.titulo ?? "Tu pedido"}</h1>
      {pedido ? <p className="ayuda">{pedido.tienda}{pedido.direccion ? ` · ${pedido.direccion}` : ""}</p> : null}
      {enCamino ? <p className="aviso paso destacado">Tu pedido va en camino</p> : null}
      {error ? <p className="aviso error">{error}</p> : null}
      {aviso ? <p className="aviso">{aviso}</p> : null}
      {!pedido && !error ? <p className="ayuda">Buscando el pedido…</p> : null}
      <div className="pasos">
        {(pedido?.pasos ?? []).map((step) => (
          <article key={step.id} className={`paso${step.actual ? " actual" : ""}${step.destacado ? " destacado" : ""}`}>
            <strong>{step.hecho ? "✓ " : ""}{step.titulo}</strong>
            <p>{step.detalle}</p>
          </article>
        ))}
      </div>
      {pedido?.items.length ? (
        <section className="lista">
          {pedido.items.map((item) => (
            <article key={item.id} className="tarjeta">
              <strong>{item.cantidad ?? 1} × {item.nombre}</strong>
              {item.extras.length ? <p className="ayuda">{item.extras.join(", ")}</p> : null}
              {item.nota ? <p className="ayuda">Nota: {item.nota}</p> : null}
            </article>
          ))}
        </section>
      ) : null}
      {pedido ? <p className="total"><span>Total</span><b>{pedido.totalTexto ?? (pedido.cotizar ? "Por cotizar" : "—")}</b></p> : null}
      {pedido?.puedeConfirmarTotal ? (
        <button type="button" className="boton" onClick={() => void confirmTotal()}>Sí, confirmo el total</button>
      ) : null}
      <p className="ayuda"><Link href="/app">Armar otro cuando este se cierre</Link></p>
    </>
  );
}
