export const MIGRACION_PENDIENTE = "MIGRACION_PENDIENTE";

export const MIGRACION_MENSAJE =
  "La app todavía no está activada en la base. Falta correr la migración propuesta (usuarios_app, sesiones_app y push_subscriptions). El bot de WhatsApp sigue igual. El catálogo sí se puede ver.";

type DbError = { code?: string; message?: string } | null | undefined;

export function isMissingRelation(error: DbError): boolean {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /does not exist/i.test(message) ||
    /schema cache/i.test(message) ||
    /could not find the table/i.test(message)
  );
}

export function isMissingColumn(error: DbError): boolean {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return code === "42703" || code === "PGRST204" || /could not find the '.+' column/i.test(message);
}
