"use client";

import { useEffect, useRef } from "react";

import { COVERAGE_RADIUS_KM, IXTLAHUACAN_CENTER } from "@/lib/services/geo";

type MapsApi = {
  maps: {
    Map: new (element: HTMLElement, options: object) => {
      addListener: (name: string, handler: (event: { latLng?: { lat: () => number; lng: () => number } | null }) => void) => void;
    };
    Marker: new (options: object) => { setPosition: (position: object) => void };
    Circle: new (options: object) => unknown;
  };
};

declare global {
  interface Window {
    google?: MapsApi;
  }
}

export function MapPicker({ apiKey, onPick }: { apiKey: string | null; onPick: (latitude: number, longitude: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!apiKey || !ref.current) return;
    let cancelled = false;
    const draw = () => {
      if (cancelled || !ref.current || !window.google) return;
      const center = { lat: IXTLAHUACAN_CENTER.latitude, lng: IXTLAHUACAN_CENTER.longitude };
      const map = new window.google.maps.Map(ref.current, {
        center,
        zoom: 15,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false,
      });
      const marker = new window.google.maps.Marker({ position: center, map });
      new window.google.maps.Circle({
        map,
        center,
        radius: COVERAGE_RADIUS_KM * 1000,
        strokeColor: "#E00B2D",
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: "#E00B2D",
        fillOpacity: 0.08,
      });
      map.addListener("click", (event) => {
        const latLng = event.latLng;
        if (!latLng) return;
        const latitude = latLng.lat();
        const longitude = latLng.lng();
        marker.setPosition({ lat: latitude, lng: longitude });
        onPickRef.current(latitude, longitude);
      });
    };

    if (window.google?.maps) {
      draw();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    script.async = true;
    script.onload = draw;
    document.head.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  if (!apiKey) return null;
  return <div ref={ref} className="mapa" />;
}
