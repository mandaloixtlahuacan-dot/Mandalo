"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { APP_CATEGORIES, type AppCategoryId } from "@/lib/app/categories";

type Store = { id: number; nombre: string; abierta: boolean; abreTexto: string; horarioTexto: string; cotizar: boolean };
type Category = { id: string; titulo: string; detalle: string; tiendas: Store[] };

export default function CategoryPage() {
  const params = useParams<{ id: string }>();
  const id = params.id as AppCategoryId;
  const visual = APP_CATEGORIES.find((item) => item.id === id);
  const [stores, setStores] = useState<Store[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/app/categorias")
      .then((response) => response.json())
      .then((body: { ok?: boolean; categorias?: Category[]; mensaje?: string }) => {
        if (!body.ok) {
          setError(body.mensaje || "No pude cargar las tiendas.");
          return;
        }
        const found = (body.categorias ?? []).find((item) => item.id === id);
        setStores(found?.tiendas ?? []);
      })
      .catch(() => setError("No pude cargar las tiendas."));
  }, [id]);

  return (
    <>
      <Link href="/app" className="ayuda">← Inicio</Link>
      <h1>{visual?.titulo ?? "Tiendas"}</h1>
      <p className="ayuda">{visual?.detalle}</p>
      {error ? <p className="aviso error">{error}</p> : null}
      {!stores && !error ? <p className="ayuda">Cargando…</p> : null}
      {stores?.length === 0 ? <p className="aviso">Todavía no hay una tienda activa aquí.</p> : null}
      <div className="lista">
        {(stores ?? []).map((store) => (
          <Link key={store.id} href={`/app/tienda/${store.id}`} className="tarjeta-tienda" style={{ background: visual?.suave }}>
            <div className="producto">
              <strong>{store.nombre}</strong>
              <span className={store.abierta ? "pastilla abierta" : "pastilla"}>{store.abierta ? "Abierta" : "Cerrada"}</span>
            </div>
            <p className="ayuda">{store.abierta ? store.horarioTexto : store.abreTexto || store.horarioTexto}</p>
            {store.cotizar ? <p className="ayuda">El precio lo cotiza la tienda</p> : null}
          </Link>
        ))}
      </div>
    </>
  );
}
