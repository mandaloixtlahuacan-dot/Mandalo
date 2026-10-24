import { nominatimHeaders, nominatimReverseUrl, nominatimSearchUrl, parseGeocodeRequest, readNominatimHits, waitNominatimSlot } from "@/lib/app/geocode";
import { appJson, catchAppError } from "@/lib/app/routeKit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cache = new Map<string, { at: number; hits: ReturnType<typeof readNominatimHits> }>();
const CACHE_MS = 60_000;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = parseGeocodeRequest(url.searchParams);
    const reverse = parsed.latitude != null && parsed.longitude != null;
    if (!reverse && parsed.q.length < 3) return appJson({ ok: true, resultados: [] });

    const target = reverse ? nominatimReverseUrl(parsed.latitude as number, parsed.longitude as number) : nominatimSearchUrl(parsed.q);
    const cached = cache.get(target);
    if (cached && Date.now() - cached.at < CACHE_MS) return appJson({ ok: true, resultados: cached.hits });

    await waitNominatimSlot();
    const again = cache.get(target);
    if (again && Date.now() - again.at < CACHE_MS) return appJson({ ok: true, resultados: again.hits });

    const response = await fetch(target, { headers: nominatimHeaders(), cache: "no-store" });
    if (!response.ok) return appJson({ ok: false, mensaje: "No pude buscar la calle. Inténtalo en un momento." }, 502);
    const hits = readNominatimHits(await response.json());
    cache.set(target, { at: Date.now(), hits });
    return appJson({ ok: true, resultados: hits });
  } catch (error: unknown) {
    return catchAppError(error);
  }
}
