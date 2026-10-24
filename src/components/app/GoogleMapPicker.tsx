"use client";

import { useEffect, useRef } from "react";

import type { MapPlace } from "@/lib/app/geocode";
import { COVERAGE_RADIUS_KM, IXTLAHUACAN_CENTER } from "@/lib/services/geo";

type LatLng = { lat: () => number; lng: () => number };
type MapsApi = {
  maps: {
    Map: new (element: HTMLElement, options: object) => {
      panTo: (position: object) => void;
      setZoom: (zoom: number) => void;
    };
    Marker: new (options: object) => {
      setPosition: (position: object) => void;
      getPosition: () => LatLng | null;
      addListener: (name: string, handler: () => void) => void;
    };
    Circle: new (options: object) => unknown;
    Geocoder: new () => {
      geocode: (request: object, callback: (results: Array<{ formatted_address?: string }> | null, status: string) => void) => void;
    };
    places: {
      Autocomplete: new (input: HTMLInputElement, options: object) => {
        addListener: (name: string, handler: () => void) => void;
        getPlace: () => { formatted_address?: string; name?: string; geometry?: { location?: LatLng } };
      };
    };
  };
};

declare global {
  interface Window {
    google?: MapsApi;
  }
}

/** Camino opcional. Solo entra si NEXT_PUBLIC_MAP_PROVIDER=google y hay llave. */
export function GoogleMapPicker({ apiKey, onPlace }: { apiKey: string; onPlace: (place: MapPlace) => void }) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;

  useEffect(() => {
    if (!mapRef.current || !inputRef.current) return;
    let cancelled = false;
    const draw = () => {
      if (cancelled || !mapRef.current || !inputRef.current || !window.google?.maps?.places) return;
      const center = { lat: IXTLAHUACAN_CENTER.latitude, lng: IXTLAHUACAN_CENTER.longitude };
      const map = new window.google.maps.Map(mapRef.current, {
        center,
        zoom: 16,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
      });
      const marker = new window.google.maps.Marker({ position: center, map, draggable: true });
      new window.google.maps.Circle({
        map,
        center,
        radius: COVERAGE_RADIUS_KM * 1000,
        strokeColor: "#E00B2D",
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: "#E00B2D",
        fillOpacity: 0.08,
      });
      const geocoder = new window.google.maps.Geocoder();
      const publish = (latitude: number, longitude: number, direccion: string) => {
        marker.setPosition({ lat: latitude, lng: longitude });
        map.panTo({ lat: latitude, lng: longitude });
        onPlaceRef.current({ latitude, longitude, direccion });
      };
      marker.addListener("dragend", () => {
        const position = marker.getPosition();
        if (!position) return;
        geocoder.geocode({ location: { lat: position.lat(), lng: position.lng() } }, (results, status) => {
          const formatted = status === "OK" ? results?.[0]?.formatted_address ?? "" : "";
          onPlaceRef.current({ latitude: position.lat(), longitude: position.lng(), direccion: formatted });
        });
      });
      const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
        componentRestrictions: { country: "mx" },
        fields: ["formatted_address", "geometry", "name"],
      });
      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        const location = place.geometry?.location;
        if (!location) return;
        const direccion = place.formatted_address || place.name || "";
        if (inputRef.current && direccion) inputRef.current.value = direccion;
        publish(location.lat(), location.lng(), direccion);
        map.setZoom(17);
      });
    };

    if (window.google?.maps?.places) {
      draw();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    script.async = true;
    script.onload = draw;
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  return (
    <div className="lista">
      <input ref={inputRef} className="campo" placeholder="Calle y número" autoComplete="off" />
      <div ref={mapRef} className="mapa" />
      <p className="ayuda">Escribe la calle. El pin se acomoda solo y lo puedes arrastrar.</p>
    </div>
  );
}
