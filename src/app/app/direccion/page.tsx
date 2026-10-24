"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useCart } from "@/components/app/cart";
import { MapPicker } from "@/components/app/MapPicker";
import type { MapProviderId } from "@/lib/app/geocode";

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
  const [proveedor, setProveedor] = useState<MapProviderId>("osm");
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
      .then((body: { proveedor?: string; mapsKey?: string | null }) => {
        setProveedor(body.proveedor === "google" ? "google" : "osm");
        setMapsKey(body.mapsKey ?? null);
      })
      .catch(() => {
        setProveedor("osm");
        setMapsKey(null);
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!cart.address) return;
    if (cart.address.latitude != null) setLatitude(String(cart.address.latitude));
    if (cart.address.longitude != null) setLongitude(String(cart.address.longitude));
    setReferencia(cart.address.texto || cart.address.referencia);
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
    const calle = referencia.trim();
    cart.saveAddress({
      latitude: next.latitude ?? null,
      longitude: next.longitude ?? null,
      referencia: calle,
      texto: calle || next.zona || "Pin guardado",
      regla: next.regla || "radio",
    });
  }

  return (
    <>
      <h1>¿Dónde lo dejamos?</h1>
      <p className="ayuda">Solo la cabecera de Ixtlahuacán del Río. Escribe la calle y el número.</p>
      {!ready ? <p className="ayuda">Cargando mapa…</p> : (
        <MapPicker
          provider={proveedor}
          apiKey={mapsKey}
          onPlace={(place) => {
            setLatitude(String(place.latitude));
            setLongitude(String(place.longitude));
            if (place.direccion) setReferencia(place.direccion);
          }}
        />
      )}
      <div className="lista">
        <p className="ayuda">{referencia || "La dirección aparece aquí cuando elijas una calle."}</p>
        <details className="mapa-manual">
          <summary>Si el mapa no abre</summary>
          <input className="campo" placeholder="Calle y número" value={referencia} onChange={(event) => setReferencia(event.target.value)} />
          <input className="campo" inputMode="decimal" placeholder="Latitud" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
          <input className="campo" inputMode="decimal" placeholder="Longitud" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
        </details>
        <button type="button" className="boton" onClick={() => void check()}>Usar esta dirección</button>
      </div>
      {error ? <p className="aviso error">{error}</p> : null}
      {decision?.ok ? <p className="aviso">Sí cubrimos ahí. {decision.aviso || ""}</p> : null}
      {nota ? <p className="ayuda">{nota}</p> : null}
      {decision?.ok ? <Link href="/app/carrito" className="boton" style={{ display: "block", textAlign: "center", marginTop: 12 }}>Volver al carrito</Link> : null}
    </>
  );
}
