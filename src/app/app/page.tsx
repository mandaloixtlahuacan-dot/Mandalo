"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Store = { id: number; nombre: string; abierta: boolean; abreTexto: string; horarioTexto: string; cotizar: boolean };
type Category = { id: string; titulo: string; detalle: string; tiendas: Store[] };

export default function AppHomePage() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/app/categorias")
      .then((response) => response.json())
      .then((body: { ok?: boolean; categorias?: Category[]; mensaje?: string }) => {
        if (!body.ok) {
          setError(body.mensaje || "No pude cargar las tiendas.");
          return;
        }
        setCategories(body.categorias ?? []);
      })
      .catch(() => setError("No pude cargar las tiendas."));
  }, []);

  return (
    <>
      <h1>¿Qué se te antoja?</h1>
      <p className="ayuda">Pides aquí. Pagas en efectivo cuando llega.</p>
      {error ? <p className="aviso error">{error}</p> : null}
      {!categories && !error ? <p className="ayuda">Cargando tiendas…</p> : null}
      <div className="rejilla" style={{ marginTop: 16 }}>
        {(categories ?? []).map((category) => (
          <section key={category.id} className="tarjeta">
            <h2>{category.titulo}</h2>
            <p className="ayuda">{category.detalle}</p>
            {category.tiendas.length === 0 ? <p className="ayuda">Todavía no hay una tienda activa en esta categoría.</p> : null}
            <div className="lista">
              {category.tiendas.map((store) => (
                <Link key={store.id} href={`/app/tienda/${store.id}`} className="categoria">
                  <strong>{store.nombre}</strong>
                  <span>{store.abierta ? "Abierta ahora" : store.abreTexto || "Cerrada ahora"}</span>
                  {store.horarioTexto ? <span> · {store.horarioTexto}</span> : null}
                  {store.cotizar ? <span> · El precio lo cotiza la tienda</span> : null}
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
