"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useCart } from "@/components/app/cart";
import { MapPicker } from "@/components/app/MapPicker";

type Decision = {
  ok: boolean;
  mensaje?: string;
  latitude?: number | null;
  longitude?: number | null;
  zona?: string | null;
  regla?: string;
  aviso?: string | null;
};

export default function AddressPage() {
  const cart = useCart();
  const [mapsKey, setMapsKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [referencia, setReferencia] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/app/publico")
      .then((response) => response.json())
      .then((body: { mapsKey?: string | null }) => setMapsKey(body.mapsKey ?? null))
      .catch(() => setMapsKey(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!cart.address) return;
    if (cart.address.latitude != null) setLatitude(String(cart.address.latitude));
    if (cart.address.longitude != null) setLongitude(String(cart.address.longitude));
    setReferencia(cart.address.referencia);
  }, [cart.address]);

  async function check() {
    setError("");
    const response = await fetch("/api/app/cobertura", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        latitude: latitude.trim() ? Number(latitude) : null,
        longitude: longitude.trim() ? Number(longitude) : null,
        referencia,
      }),
    });
    const body = (await response.json()) as { ok?: boolean; decision?: Decision; mensaje?: string; nota?: string };
    const next = body.decision ?? { ok: false, mensaje: body.mensaje || "No pude revisar la cobertura." };
    setDecision(next);
    setNota(body.nota || "");
    if (!next.ok) {
      setError(next.mensaje || "Ese punto queda fuera.");
      return;
    }
    const texto = [next.zona, referencia.trim(), next.latitude != null ? "pin en el mapa" : ""].filter(Boolean).join(" · ");
    cart.saveAddress({
      latitude: next.latitude ?? null,
      longitude: next.longitude ?? null,
      referencia: referencia.trim(),
      texto,
      regla: next.regla || "radio",
    });
  }

  return (
    <>
      <h1>¿Dónde lo dejamos?</h1>
      <p className="ayuda">Solo la cabecera de Ixtlahuacán del Río. Toca el mapa para clavar el pin.</p>
      {!ready ? <p className="ayuda">Cargando mapa…</p> : null}
      {ready && !mapsKey ? (
        <p className="aviso">El mapa no está disponible en este preview. Pega latitud y longitud, o escribe la calle.</p>
      ) : null}
      <MapPicker
        apiKey={mapsKey}
        onPick={(lat, lng) => {
          setLatitude(String(lat));
          setLongitude(String(lng));
        }}
      />
      <div className="lista">
        <input className="campo" inputMode="decimal" placeholder="Latitud" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
        <input className="campo" inputMode="decimal" placeholder="Longitud" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
        <input className="campo" placeholder="Calle, número o referencia" value={referencia} onChange={(event) => setReferencia(event.target.value)} />
        <button type="button" className="boton" onClick={() => void check()}>Revisar cobertura</button>
      </div>
      {error ? <p className="aviso error">{error}</p> : null}
      {decision?.ok ? <p className="aviso">Sí cubrimos ahí. {decision.aviso || ""}</p> : null}
      {nota ? <p className="ayuda">{nota}</p> : null}
      {decision?.ok ? <Link href="/app/carrito" className="boton" style={{ display: "block", textAlign: "center", marginTop: 12 }}>Volver al carrito</Link> : null}
    </>
  );
}
