"use client";

import { GoogleMapPicker } from "@/components/app/GoogleMapPicker";
import { OsmMap } from "@/components/app/OsmMap";
import type { MapPlace, MapProviderId } from "@/lib/app/geocode";

export type { MapPlace };

export function MapPicker({
  provider = "osm",
  apiKey = null,
  onPlace,
}: {
  provider?: MapProviderId;
  apiKey?: string | null;
  onPlace: (place: MapPlace) => void;
}) {
  if (provider === "google" && apiKey) return <GoogleMapPicker apiKey={apiKey} onPlace={onPlace} />;
  return <OsmMap onPlace={onPlace} />;
}
