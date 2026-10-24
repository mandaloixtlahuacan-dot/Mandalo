import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { APP_SESSION_COOKIE, userFromSessionToken, type AppUser, type SessionCookie } from "@/lib/app/auth";
import { MIGRACION_MENSAJE, MIGRACION_PENDIENTE } from "@/lib/app/dbError";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export function appJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function applySessionCookie(response: NextResponse, cookie: SessionCookie): NextResponse {
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}

export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(APP_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function currentAppUser(): Promise<AppUser | "missing" | null> {
  const jar = await cookies();
  return userFromSessionToken(getSupabaseAdmin(), jar.get(APP_SESSION_COOKIE)?.value);
}

export function catchAppError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("ENV_INVALID")) {
    return appJson(
      { ok: false, code: "ENV", mensaje: "Faltan variables del servidor. En este preview todavía no se puede leer la base." },
      503,
    );
  }
  console.error("[app]", message || error);
  return appJson({ ok: false, code: "ERROR", mensaje: "Algo falló. Inténtalo otra vez." }, 500);
}

export function migrationJson(): NextResponse {
  return appJson({ ok: false, code: MIGRACION_PENDIENTE, mensaje: MIGRACION_MENSAJE }, 503);
}
