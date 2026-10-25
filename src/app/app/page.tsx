"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ArtCarniceria, ArtRestaurante, ArtTienda } from "@/components/app/art";
import { APP_CATEGORIES, type AppCategoryId } from "@/lib/app/categories";

type User = { nombre: string };

function ArteCategoria({ id }: { id: AppCategoryId }) {
  if (id === "restaurantes") return <ArtRestaurante />;
  if (id === "carnicerias") return <ArtCarniceria />;
  return <ArtTienda />;
}

export default function AppHomePage() {
  const [usuario, setUsuario] = useState<User | null>(null);
  const [modo, setModo] = useState<"entrar" | "crear" | null>(null);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    void fetch("/api/app/sesion")
      .then((response) => response.json())
      .then((body: { usuario?: User | null }) => {
        if (body.usuario) setUsuario(body.usuario);
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
  const categorias = APP_CATEGORIES.filter((category) => {
    if (!consulta) return true;
    return fold(category.titulo).includes(consulta) || fold(category.detalle).includes(consulta);
  });

  return (
    <>
      <div className="buscar-fija">
        <input className="campo buscar" value={q} placeholder="Busca una categoría" onChange={(event) => setQ(event.target.value)} />
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

      {consulta && categorias.length === 0 ? <p className="ayuda">No encontré esa categoría.</p> : null}
      <div className="tarjetas-grandes">
        {categorias.map((category) => (
          <Link key={category.id} href={`/app/categoria/${category.id}`} className="tarjeta-grande" style={{ background: category.suave }}>
            <span>
              <strong>{category.titulo}</strong>
              <span>{category.detalle}</span>
            </span>
            <ArteCategoria id={category.id} />
          </Link>
        ))}
      </div>
    </>
  );
}

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
