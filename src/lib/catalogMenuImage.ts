/**
 * Foto de menú de una tienda con catálogo fijo.
 *
 * George: `public/menus/george.png` (o el base64 partido que ya está en el repo).
 * Carnicería La Central: el mismo mecanismo. Si Víctor todavía no manda la
 * foto, no hay archivo y esta función regresa null — el pedido no se bloquea.
 * También acepta `CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL` (https) para no
 * esperar el PNG en el deploy.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type CatalogMenuImageKind = "george" | "carniceria-la-central";

const SPECS: Record<CatalogMenuImageKind, { png: string; b64: string; chunk: RegExp; env: string | null }> = {
  george: {
    png: "george.png",
    b64: "george.png.b64",
    chunk: /^george\.b64\.\d{2}$/,
    env: null,
  },
  "carniceria-la-central": {
    png: "carniceria-la-central.png",
    b64: "carniceria-la-central.png.b64",
    chunk: /^carniceria-la-central\.b64\.\d{2}$/,
    env: "CARNICERIA_LA_CENTRAL_MENU_IMAGE_URL",
  },
};

export function catalogMenuPngRelative(kind: CatalogMenuImageKind): string {
  return `public/menus/${SPECS[kind].png}`;
}

async function readUrlImage(url: string): Promise<Buffer | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  try {
    const response = await fetch(parsed);
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 32 ? bytes : null;
  } catch {
    return null;
  }
}

export async function readCatalogMenuPng(kind: CatalogMenuImageKind): Promise<Buffer | null> {
  const spec = SPECS[kind];
  const envUrl = spec.env ? String(process.env[spec.env] ?? "").trim() : "";
  if (envUrl) {
    const remote = await readUrlImage(envUrl);
    if (remote) return remote;
  }

  const dir = path.join(process.cwd(), "public", "menus");
  try {
    return await readFile(path.join(dir, spec.png));
  } catch {
    // El PNG a veces no entra en el despliegue. El mismo archivo en base64,
    // entero o partido, sí. Si tampoco está, null: el caller manda texto.
  }

  try {
    const encoded = await readFile(path.join(dir, spec.b64), "utf8");
    const decoded = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    if (decoded.length > 32) return decoded;
  } catch {
    // sigue el base64 partido
  }

  try {
    const names = (await readdir(dir)).filter((name) => spec.chunk.test(name)).sort();
    if (!names.length) return null;
    let encoded = "";
    for (const name of names) encoded += await readFile(path.join(dir, name), "utf8");
    const decoded = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    return decoded.length > 32 ? decoded : null;
  } catch {
    return null;
  }
}
