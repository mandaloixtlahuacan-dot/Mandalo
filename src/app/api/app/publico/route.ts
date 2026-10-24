import { appJson } from "@/lib/app/routeKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Datos públicos del preview. La llave de Maps es de navegador; la privada de VAPID no sale. */
export async function GET() {
  return appJson({
    ok: true,
    mapsKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || null,
    vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null,
  });
}
