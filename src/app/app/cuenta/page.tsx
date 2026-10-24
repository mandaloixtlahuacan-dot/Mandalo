"use client";

import { useEffect, useState } from "react";

type User = { id: number; nombre: string; telefono: string };

export default function AccountPage() {
  const [usuario, setUsuario] = useState<User | null>(null);
  const [modo, setModo] = useState<"entrar" | "crear">("entrar");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [password, setPassword] = useState("");
  const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState("");
  const [push, setPush] = useState("");

  useEffect(() => {
    void fetch("/api/app/sesion")
      .then((response) => response.json())
      .then((body: { ok?: boolean; usuario?: User | null; mensaje?: string }) => {
        if (body.usuario) setUsuario(body.usuario);
        else if (body.ok === false && body.mensaje) setError(body.mensaje);
      })
      .catch(() => setError("No pude revisar la sesión."));
  }, []);

  async function submit() {
    setError("");
    setMensaje("");
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
    setPassword("");
    setMensaje(modo === "crear" ? "Cuenta lista." : "Listo, ya entraste.");
  }

  async function logout() {
    await fetch("/api/app/sesion", { method: "DELETE" });
    setUsuario(null);
    setMensaje("Saliste de la cuenta.");
  }

  async function enablePush() {
    setPush("");
    const status = await fetch("/api/app/push").then((response) => response.json()) as { listo?: boolean; vapidPublicKey?: string | null };
    if (!status.listo || !status.vapidPublicKey) {
      setPush("Los avisos del teléfono se prenden cuando estén las llaves VAPID en el servidor.");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPush("Este navegador no deja avisos push.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPush("Sin permiso no te puedo avisar cuando cambie el pedido.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey) as BufferSource,
    });
    const json = subscription.toJSON();
    const saved = await fetch("/api/app/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
    const body = (await saved.json()) as { ok?: boolean; mensaje?: string };
    setPush(body.ok ? "Avisos activados en este teléfono." : body.mensaje || "No pude guardar el aviso.");
  }

  return (
    <>
      <h1>Tu cuenta</h1>
      <p className="ayuda">Nombre, WhatsApp y una contraseña. El pedido te llega también por WhatsApp.</p>
      {usuario ? (
        <section className="tarjeta">
          <strong>{usuario.nombre}</strong>
          <p className="ayuda">{usuario.telefono}</p>
          <button type="button" className="boton" onClick={() => void enablePush()}>Activar avisos</button>
          {push ? <p className="ayuda">{push}</p> : null}
          <button type="button" className="boton claro" style={{ marginTop: 10 }} onClick={() => void logout()}>Salir</button>
        </section>
      ) : (
        <section className="lista">
          <div className="chips">
            <button type="button" className={modo === "entrar" ? "chip encendido" : "chip"} onClick={() => setModo("entrar")}>Entrar</button>
            <button type="button" className={modo === "crear" ? "chip encendido" : "chip"} onClick={() => setModo("crear")}>Crear cuenta</button>
          </div>
          {modo === "crear" ? (
            <input className="campo" placeholder="Nombre" value={nombre} onChange={(event) => setNombre(event.target.value)} />
          ) : null}
          <input className="campo" inputMode="tel" placeholder="WhatsApp a 10 dígitos" value={telefono} onChange={(event) => setTelefono(event.target.value)} />
          <input className="campo" type="password" placeholder="Contraseña" value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="button" className="boton" onClick={() => void submit()}>{modo === "crear" ? "Crear cuenta" : "Entrar"}</button>
        </section>
      )}
      {error ? <p className="aviso error">{error}</p> : null}
      {mensaje ? <p className="aviso">{mensaje}</p> : null}
      <p className="ayuda">Para instalarla, usa el botón de arriba o, en iPhone, Compartir → Agregar a inicio.</p>
    </>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
