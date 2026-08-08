import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no" || v === "") return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  OPENAI_API_KEY: z.string().min(20),
  OPENAI_MODEL: z.string().default("gpt-4-turbo"),

  WAAPI_TOKEN: z.string().min(3),
  WAAPI_API_BASE: z.string().url().default("https://gate.whapi.cloud"),

  MANDALO_WEBHOOK_SECRET: z.string().optional(),

  MANDALO_COMISION_FIJA: z.coerce.number().nonnegative().default(0),
  MANDALO_ENVIO_FIJO: z.coerce.number().nonnegative().default(0),

  // Opcional por diseño: si falta, el flujo legacy NO debe detenerse.
  MANDALO_ADMIN_PHONE: z.string().min(8).optional(),

  // Worker interno (opcional en dev; recomendado/obligatorio en prod).
  CRON_SECRET: z.string().min(12).optional(),
  MANDALO_INTERNAL_WORKER_SECRET: z.string().min(12).optional(),
  ADMIN_OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  ADMIN_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  ADMIN_OUTBOX_BASE_BACKOFF_SECONDS: z.coerce.number().int().positive().default(60),
  ADMIN_OUTBOX_DRY_RUN: booleanFromEnv.default(false),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Nota (Next.js):
 * Los módulos se evalúan en build-time. Por eso cargamos/validamos env de forma "lazy"
 * (solo cuando el endpoint realmente se ejecuta).
 */
export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,

    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-4-turbo",

    WAAPI_TOKEN: process.env.WAAPI_TOKEN,
    WAAPI_API_BASE: process.env.WAAPI_API_BASE ?? "https://gate.whapi.cloud",

    MANDALO_WEBHOOK_SECRET: process.env.MANDALO_WEBHOOK_SECRET,

    MANDALO_COMISION_FIJA: process.env.MANDALO_COMISION_FIJA ?? "0",
    MANDALO_ENVIO_FIJO: process.env.MANDALO_ENVIO_FIJO ?? "0",

    MANDALO_ADMIN_PHONE: process.env.MANDALO_ADMIN_PHONE,

    CRON_SECRET: process.env.CRON_SECRET,
    MANDALO_INTERNAL_WORKER_SECRET: process.env.MANDALO_INTERNAL_WORKER_SECRET,
    ADMIN_OUTBOX_BATCH_SIZE: process.env.ADMIN_OUTBOX_BATCH_SIZE ?? "10",
    ADMIN_OUTBOX_MAX_ATTEMPTS: process.env.ADMIN_OUTBOX_MAX_ATTEMPTS ?? "5",
    ADMIN_OUTBOX_BASE_BACKOFF_SECONDS: process.env.ADMIN_OUTBOX_BASE_BACKOFF_SECONDS ?? "60",
    ADMIN_OUTBOX_DRY_RUN: process.env.ADMIN_OUTBOX_DRY_RUN ?? "false",
  });

  if (!parsed.success) {
    // Evita mensajes gigantes en logs; dejamos algo entendible.
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`ENV_INVALID: ${fields}`);
  }

  cachedEnv = parsed.data;
  if (!cachedEnv.MANDALO_ADMIN_PHONE || String(cachedEnv.MANDALO_ADMIN_PHONE).trim() === "") {
    console.warn("[mandalo] WARNING: MANDALO_ADMIN_PHONE no está configurado; admin_notificaciones no se encolarán.");
  }
  if (!cachedEnv.MANDALO_INTERNAL_WORKER_SECRET || String(cachedEnv.MANDALO_INTERNAL_WORKER_SECRET).trim() === "") {
    console.warn("[mandalo] WARNING: MANDALO_INTERNAL_WORKER_SECRET no está configurado; el endpoint interno del worker quedará sin protección fuerte en dev.");
  }
  if (!cachedEnv.CRON_SECRET || String(cachedEnv.CRON_SECRET).trim() === "") {
    console.warn("[mandalo] WARNING: CRON_SECRET no está configurado; Vercel Cron no podrá autenticar el endpoint interno.");
  }
  return cachedEnv;
}
