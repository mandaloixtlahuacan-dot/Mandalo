"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function OpenOrderPage() {
  const router = useRouter();
  const [mensaje, setMensaje] = useState("");

  useEffect(() => {
    void fetch("/api/app/pedidos")
      .then((response) => response.json())
      .then((body: { ok?: boolean; pedidoId?: number | null; mensaje?: string }) => {
        if (body.pedidoId) {
          router.replace(`/app/pedido/${body.pedidoId}`);
          return;
        }
        setMensaje(body.ok ? "No tienes un pedido abierto." : body.mensaje || "Entra para ver tu pedido.");
      })
      .catch(() => setMensaje("No pude buscar tu pedido."));
  }, [router]);

  return (
    <>
      <h1>Pedido</h1>
      <p className="ayuda">{mensaje || "Buscando…"}</p>
      {mensaje ? <Link href="/app" className="boton" style={{ display: "block", textAlign: "center" }}>Ver tiendas</Link> : null}
    </>
  );
}
