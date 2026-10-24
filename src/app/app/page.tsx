"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { MiniaturaCategoria } from "@/components/app/ilustraciones";
import { APP_CATEGORIES, type AppCategoryId } from "@/lib/app/categories";

type User = { nombre: string };
type Store = { id: number; nombre: string; abierta: boolean; abreTexto: string; horarioTexto: string; cotizar: boolean };
type Block = { id: AppCategoryId; titulo: string; detalle: string; tiendas: Store[] };

export default function AppHomePage() {
  const [usuario, setUsuario] = useState<User | null>(null);
  const [modo, setModo] = useState<"entrar" | "crear" | null>(null);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [bloques, setBloques] = useState<Block[]>([]);

  useEffect(() => {
    void fetch("/api/app/sesion")
      .then((response) => response.json())
      .then((body: { usuario?: User | null }) => {
        if (body.usuario) setUsuario(body.usuario);
      })
      .catch(() => undefined);
    void fetch("/api/app/categorias")
      .then((response) => response.json())
      .then((body: { ok?: boolean; categorias?: Block[] }) => {
        if (body.ok) setBloques(body.categorias ?? []);
      })
      .catch(() => undefined);
  }, []);

  async function submit() {
    setError("");
    const url = modo === "crear" ? "/api/app/registro" : "/api/app/sesion";
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nombre, telefono, password }),
    });
    const body = (await response.json()) as { ok?: boolean; usuario?: User; mensaje?: string };
    if (!body.ok || !body.usuario) {
      setError(body.mensaje || "No pude entrar.");
      return;
    }
    setUsuario(body.usuario);
    setModo(null);
    setPassword("");
  }

  const consulta = fold(q);
  const visibles = useMemo(() => {
    return bloques
      .map((block) => ({
        ...block,
        tiendas: block.tiendas.filter((store) => !consulta || fold(store.nombre).includes(consulta) || fold(block.titulo).includes(consulta)),
      }))
      .filter((block) => !consulta || block.tiendas.length > 0 || fold(block.titulo).includes(consulta));
  }, [bloques, consulta]);

  return (
    <>
      <div className="buscar-fija">
        <input className="campo buscar" value={q} placeholder="Busca una tienda" onChange={(event) => setQ(event.target.value)} />
      </div>
      <section className="bienvenida">
        <p className="eyebrow">Tu mandado a domicilio</p>
        <h1>{usuario ? `Hola, ${usuario.nombre.split(" ")[0]}` : "¿Qué se te antoja?"}</h1>
        {!usuario && !modo ? (
          <div className="fila-botones">
            <button type="button" className="boton" onClick={() => setModo("entrar")}>Entrar</button>
            <button type="button" className="boton claro" onClick={() => setModo("crear")}>Crear cuenta</button>
          </div>
        ) : null}
        {modo ? (
          <div className="lista">
            {modo === "crear" ? <input className="campo" placeholder="Nombre" value={nombre} onChange={(event) => setNombre(event.target.value)} /> : null}
            <input className="campo" inputMode="tel" placeholder="WhatsApp" value={telefono} onChange={(event) => setTelefono(event.target.value)} />
            <input className="campo" type="password" placeholder="Contraseña" value={password} onChange={(event) => setPassword(event.target.value)} />
            <button type="button" className="boton" onClick={() => void submit()}>{modo === "crear" ? "Crear cuenta" : "Entrar"}</button>
          </div>
        ) : null}
        {error ? <p className="aviso error">{error}</p> : null}
      </section>

      <h2 className="fila-titulo">Categorías</h2>
      <div className="carrusel">
        {APP_CATEGORIES.map((category) => (
          <Link key={category.id} href={`/app/categoria/${category.id}`} className="circulo">
            <MiniaturaCategoria id={category.id} />
            <span>{category.titulo}</span>
          </Link>
        ))}
      </div>

      {consulta && visibles.length === 0 ? <p className="ayuda">No encontré esa tienda.</p> : null}
      {visibles.map((block) => (
        <section key={block.id}>
          <h2 className="fila-titulo">{block.titulo}</h2>
          {block.tiendas.length === 0 ? <p className="ayuda">Todavía no hay una tienda activa aquí.</p> : null}
          <div className="carrusel">
            {block.tiendas.map((store) => (
              <Link key={store.id} href={`/app/tienda/${store.id}`} className="tarjeta-mini">
                <strong>{store.nombre}</strong>
                <span className={store.abierta ? "pastilla abierta" : "pastilla"}>{store.abierta ? "Abierta" : "Cerrada"}</span>
                <p className="ayuda">{store.abierta ? store.horarioTexto : store.abreTexto || store.horarioTexto}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
