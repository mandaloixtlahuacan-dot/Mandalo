import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingRelation, MIGRACION_MENSAJE, MIGRACION_PENDIENTE } from "@/lib/app/dbError";
import { parseAppPhone, phoneVariants, samePhone } from "@/lib/app/phone";

export const APP_SESSION_COOKIE = "mandalo_app";
export const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 10;

export type SessionCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: "lax";
    path: "/";
    maxAge: number;
  };
};

export type AppUser = { id: number; telefono: string; nombre: string };

export type AuthResult =
  | { ok: true; user: AppUser; cookie: SessionCookie }
  | { ok: false; status: number; code: string; mensaje: string };

type Db = SupabaseClient;

export function sessionCookie(token: string): SessionCookie {
  return {
    name: APP_SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    },
  };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function registerAppUser(
  supabase: Db,
  input: { nombre: string; telefono: string; password: string },
): Promise<AuthResult> {
  const nombre = cleanName(input.nombre);
  const telefono = parseAppPhone(input.telefono);
  const password = String(input.password ?? "");
  if (!nombre) return fail(400, "DATOS", "Escribe tu nombre.");
  if (!telefono) return fail(400, "DATOS", "El teléfono debe ser de WhatsApp, a 10 dígitos.");
  if (password.length < 8) return fail(400, "DATOS", "La contraseña necesita 8 caracteres o más.");

  const blocked = await phoneIsStaff(supabase, telefono);
  if (blocked === "missing") return missing();
  if (blocked) {
    return fail(409, "NUMERO_DE_TRABAJO", "Ese número es de una tienda o un repartidor. Para pedir, usa otro WhatsApp.");
  }

  const existing = await findUser(supabase, telefono);
  if (existing === "missing") return missing();
  if (existing) return fail(409, "YA_EXISTE", "Ya hay una cuenta con ese WhatsApp. Entra con tu contraseña.");

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const inserted = await supabase
    .from("usuarios_app")
    .insert({ telefono, nombre, password_hash: passwordHash })
    .select("id, telefono, nombre")
    .maybeSingle();
  if (inserted.error) {
    if (isMissingRelation(inserted.error)) return missing();
    return fail(500, "REGISTRO", "No pude crear la cuenta. Inténtalo otra vez.");
  }
  const user = mapUser(inserted.data);
  if (!user) return fail(500, "REGISTRO", "No pude crear la cuenta.");
  return openSession(supabase, user);
}

export async function loginAppUser(
  supabase: Db,
  input: { telefono: string; password: string },
): Promise<AuthResult> {
  const telefono = parseAppPhone(input.telefono);
  if (!telefono) return fail(400, "DATOS", "Revisa el teléfono.");
  const found = await findUser(supabase, telefono, true);
  if (found === "missing") return missing();
  if (!found) return fail(401, "ENTRADA", "Ese WhatsApp no tiene cuenta, o la contraseña no coincide.");
  const hash = String((found as UserRow).password_hash ?? "");
  const matches = hash ? await bcrypt.compare(String(input.password ?? ""), hash) : false;
  if (!matches) return fail(401, "ENTRADA", "Ese WhatsApp no tiene cuenta, o la contraseña no coincide.");
  const user = mapUser(found);
  if (!user) return fail(401, "ENTRADA", "No pude entrar.");
  return openSession(supabase, user);
}

export async function userFromSessionToken(supabase: Db, token: string | null | undefined): Promise<AppUser | "missing" | null> {
  const raw = String(token ?? "").trim();
  if (!raw) return null;
  const row = await supabase
    .from("sesiones_app")
    .select("usuario_id, expires_at")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (row.error) return isMissingRelation(row.error) ? "missing" : null;
  const session = row.data as { usuario_id?: unknown; expires_at?: unknown } | null;
  if (!session) return null;
  const expires = Date.parse(String(session.expires_at ?? ""));
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  const user = await supabase.from("usuarios_app").select("id, telefono, nombre").eq("id", session.usuario_id).maybeSingle();
  if (user.error) return isMissingRelation(user.error) ? "missing" : null;
  return mapUser(user.data);
}

export async function deleteSession(supabase: Db, token: string | null | undefined): Promise<void> {
  const raw = String(token ?? "").trim();
  if (!raw) return;
  await supabase.from("sesiones_app").delete().eq("token_hash", hashSessionToken(raw));
}

async function openSession(supabase: Db, user: AppUser): Promise<AuthResult> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const inserted = await supabase.from("sesiones_app").insert({
    usuario_id: user.id,
    token_hash: hashSessionToken(token),
    expires_at: expires,
  });
  if (inserted.error) {
    if (isMissingRelation(inserted.error)) return missing();
    return fail(500, "SESION", "La cuenta quedó creada, pero no pude abrir la sesión.");
  }
  return { ok: true, user, cookie: sessionCookie(token) };
}

type UserRow = { id?: unknown; telefono?: unknown; nombre?: unknown; password_hash?: unknown };

async function findUser(supabase: Db, telefono: string, withHash = false): Promise<UserRow | "missing" | null> {
  const columns = withHash ? "id, telefono, nombre, password_hash" : "id, telefono, nombre";
  const result = await supabase.from("usuarios_app").select(columns).in("telefono", phoneVariants(telefono)).limit(1);
  if (result.error) return isMissingRelation(result.error) ? "missing" : null;
  const rows = (result.data ?? []) as unknown as UserRow[];
  return rows.find((row) => samePhone(String(row.telefono ?? ""), telefono)) ?? rows[0] ?? null;
}

export async function phoneIsStaff(supabase: Db, telefono: string): Promise<boolean | "missing"> {
  const [tiendas, repartidores] = await Promise.all([
    supabase.from("tiendas").select("telefono").limit(1000),
    supabase.from("repartidores").select("telefono").limit(1000),
  ]);
  if (tiendas.error || repartidores.error) return "missing";
  const phones = [...((tiendas.data ?? []) as Array<{ telefono?: unknown }>), ...((repartidores.data ?? []) as Array<{ telefono?: unknown }>)];
  return phones.some((row) => samePhone(String(row.telefono ?? ""), telefono));
}

function mapUser(data: unknown): AppUser | null {
  if (!data || typeof data !== "object") return null;
  const row = data as UserRow;
  const id = Number(row.id);
  const telefono = String(row.telefono ?? "");
  const nombre = String(row.nombre ?? "");
  if (!Number.isInteger(id) || id <= 0 || !telefono || !nombre) return null;
  return { id, telefono, nombre };
}

function cleanName(value: string): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 80) return null;
  return text;
}

function missing(): AuthResult {
  return fail(503, MIGRACION_PENDIENTE, MIGRACION_MENSAJE);
}

function fail(status: number, code: string, mensaje: string): AuthResult {
  return { ok: false, status, code, mensaje };
}
