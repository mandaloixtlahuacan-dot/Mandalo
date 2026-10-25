import { appJson } from "@/lib/app/routeKit";
import { resolveMapProvider } from "@/lib/app/geocode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** El mapa por defecto es OpenStreetMap. La llave de Google solo sale si el proveedor es google. */
export async function GET() {
  const googleKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null;
  const proveedor = resolveMapProvider({
    provider: process.env.NEXT_PUBLIC_MAP_PROVIDER,
    googleKey,
  });
  return appJson({
    ok: true,
    proveedor,
    mapsKey: proveedor === "google" ? googleKey : null,
    vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null,
  });
}
