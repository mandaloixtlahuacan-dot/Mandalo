"use client";

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";

import { NOMINATIM_DEBOUNCE_MS, type MapPlace } from "@/lib/app/geocode";
import { COVERAGE_RADIUS_KM, IXTLAHUACAN_CENTER } from "@/lib/services/geo";

type Hit = MapPlace;

export function OsmMap({ onPlace }: { onPlace: (place: MapPlace) => void }) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const markerRef = useRef<{ setLatLng: (latlng: [number, number]) => void } | null>(null);
  const mapRef = useRef<{ panTo: (latlng: [number, number]) => void; setZoom: (zoom: number) => void } | null>(null);
  const skipSearch = useRef(false);
  const queryRef = useRef("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [aviso, setAviso] = useState("");
  queryRef.current = query;

  useEffect(() => {
    const node = mapNode.current;
    if (!node) return;
    let removed = false;
    let map: { remove: () => void } | null = null;
    void import("leaflet").then((mod) => {
      if (removed || !mapNode.current) return;
      const L = mod.default;
      const center: [number, number] = [IXTLAHUACAN_CENTER.latitude, IXTLAHUACAN_CENTER.longitude];
      const created = L.map(mapNode.current, { zoomControl: true }).setView(center, 16);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(created);
      L.circle(center, {
        radius: COVERAGE_RADIUS_KM * 1000,
        color: "#E00B2D",
        weight: 2,
        fillColor: "#E00B2D",
        fillOpacity: 0.08,
      }).addTo(created);
      const icon = L.divIcon({
        className: "pin-mandalo",
        html: "<span></span>",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker(center, { draggable: true, icon }).addTo(created);
      let dragTimer = 0;
      marker.on("dragend", () => {
        const point = marker.getLatLng();
        window.clearTimeout(dragTimer);
        dragTimer = window.setTimeout(() => {
          void fetch(`/api/app/geocode?lat=${point.lat}&lng=${point.lng}`)
            .then((response) => response.json())
            .then((body: { resultados?: Hit[] }) => {
              const hit = body.resultados?.[0];
              const direccion = hit?.direccion || queryRef.current.trim();
              if (direccion) {
                skipSearch.current = true;
                setQuery(direccion);
              }
              onPlaceRef.current({ latitude: point.lat, longitude: point.lng, direccion });
            })
            .catch(() => onPlaceRef.current({ latitude: point.lat, longitude: point.lng, direccion: "" }));
        }, NOMINATIM_DEBOUNCE_MS);
      });
      markerRef.current = marker;
      mapRef.current = created;
      map = created;
    }).catch(() => setAviso("No pude abrir el mapa."));
    return () => {
      removed = true;
      map?.remove();
      markerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (skipSearch.current) {
      skipSearch.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/app/geocode?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((response) => response.json())
        .then((body: { ok?: boolean; resultados?: Hit[]; mensaje?: string }) => {
          setHits(body.resultados ?? []);
          setAviso(body.ok === false ? body.mensaje || "No encontré esa calle." : "");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setAviso("No pude buscar la calle.");
        });
    }, NOMINATIM_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  function choose(hit: Hit) {
    skipSearch.current = true;
    setQuery(hit.direccion);
    setHits([]);
    markerRef.current?.setLatLng([hit.latitude, hit.longitude]);
    mapRef.current?.panTo([hit.latitude, hit.longitude]);
    mapRef.current?.setZoom(17);
    onPlace(hit);
  }

  return (
    <div className="lista">
      <input
        className="campo"
        value={query}
        placeholder="Calle y número"
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />
      {hits.length ? (
        <div className="sugerencias">
          {hits.map((hit) => (
            <button key={`${hit.latitude},${hit.longitude},${hit.direccion}`} type="button" onClick={() => choose(hit)}>
              {hit.direccion}
            </button>
          ))}
        </div>
      ) : null}
      <div ref={mapNode} className="mapa" />
      <p className="ayuda">Escribe la calle. El pin se acomoda solo y lo puedes arrastrar. Mapa © OpenStreetMap.</p>
      {aviso ? <p className="ayuda">{aviso}</p> : null}
    </div>
  );
}
