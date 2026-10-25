import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingRelation } from "@/lib/app/dbError";
import { phoneVariants } from "@/lib/app/phone";
import { pushNoticesForState, type AppPushNotice } from "@/lib/app/pushCopy";
import type { OrderState } from "@/lib/orderStateMachine";
import { getSupabaseAdmin } from "@/lib/supabaseAdmin";

export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushSender = {
  send(subscriptions: PushSubscriptionRow[], notice: AppPushNotice): Promise<void>;
};

type QueryError = { code?: string; message?: string } | null;
type QueryResult = { data: unknown; error: QueryError };

type FilterQuery = PromiseLike<QueryResult> & {
  in(column: string, values: unknown[]): FilterQuery;
  eq(column: string, value: unknown): FilterQuery;
  maybeSingle(): Promise<QueryResult>;
};

type PushDb = {
  from(table: string): {
    select(columns: string): FilterQuery;
    delete(): { eq(column: string, value: unknown): Promise<{ error: QueryError }> };
  };
};

const PUSH_MISS_MS = 5 * 60 * 1000;
const PUSH_TIMEOUT_MS = 3000;

let missingUntil = 0;
let warnedMissing = false;
let testSender: PushSender | null = null;

export function setPushSenderForTests(sender: PushSender | null): void {
  testSender = sender;
}

export function resetPushSchemaProbeForTests(): void {
  missingUntil = 0;
  warnedMissing = false;
}

export async function notifyAppPushForOrderState(
  params: { pedidoId: number; estado: OrderState; previousEstado: string | null },
  deps?: { supabase?: SupabaseClient; sender?: PushSender | null },
): Promise<void> {
  const notices = pushNoticesForState(params.estado, params.pedidoId);
  if (!notices.length) return;
  if (!deps?.supabase && Date.now() < missingUntil) return;

  try {
    const supabase = (deps?.supabase ?? getSupabaseAdmin()) as unknown as PushDb;
    const pedido = await supabase
      .from("pedidos")
      .select("cliente_telefono")
      .eq("id", params.pedidoId)
      .maybeSingle();
    if (pedido.error || !pedido.data) return;
    const phone = String((pedido.data as { cliente_telefono?: unknown }).cliente_telefono ?? "");
    if (!phone) return;

    const users = await supabase.from("usuarios_app").select("id").in("telefono", phoneVariants(phone));
    if (users.error) {
      noteMissing(users.error);
      return;
    }
    const userIds = rowsOf(users.data)
      .map((row) => Number((row as { id?: unknown }).id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!userIds.length) return;

    const subsResult = await supabase.from("push_subscriptions").select("endpoint, p256dh, auth").in("usuario_id", userIds);
    if (subsResult.error) {
      noteMissing(subsResult.error);
      return;
    }

    const subscriptions = mapSubscriptions(subsResult.data);
    if (!subscriptions.length) return;
    const sender = deps?.sender === undefined ? (testSender ?? (await createWebPushSender())) : deps.sender;
    if (!sender) return;

    await withTimeout(
      (async () => {
        for (const notice of notices) {
          await sender.send(subscriptions, notice);
        }
      })(),
      PUSH_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    console.error("[app-push] fallo al leer suscripciones", error instanceof Error ? error.message : error);
  }
}

export async function createWebPushSender(): Promise<PushSender | null> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;

  const webpush = await import("web-push");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return {
    async send(subscriptions, notice) {
      const payload = JSON.stringify(notice);
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
              payload,
              { urgency: notice.highlight ? "high" : "normal", TTL: 60 * 60 },
            );
          } catch (error: unknown) {
            const status = statusCode(error);
            if (status === 404 || status === 410) {
              await removeDeadSubscription(subscription.endpoint);
              return;
            }
            console.error("[app-push] no se pudo enviar", status ?? (error instanceof Error ? error.message : error));
          }
        }),
      );
    },
  };
}

async function removeDeadSubscription(endpoint: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin() as unknown as PushDb;
    await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  } catch (error: unknown) {
    console.error("[app-push] no se pudo borrar una suscripción vencida", error instanceof Error ? error.message : error);
  }
}

function noteMissing(error: QueryError): void {
  if (!isMissingRelation(error)) return;
  missingUntil = Date.now() + PUSH_MISS_MS;
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn("[app-push] la tabla de avisos todavía no existe. El bot sigue igual. Se reintenta en 5 min.");
}

function rowsOf(data: unknown): unknown[] {
  return Array.isArray(data) ? data : [];
}

function mapSubscriptions(data: unknown): PushSubscriptionRow[] {
  const rows = rowsOf(data);
  const found: PushSubscriptionRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { endpoint?: unknown; p256dh?: unknown; auth?: unknown };
    const endpoint = String(item.endpoint ?? "");
    const p256dh = String(item.p256dh ?? "");
    const auth = String(item.auth ?? "");
    if (!endpoint || !p256dh || !auth) continue;
    found.push({ endpoint, p256dh, auth });
  }
  return found;
}

function statusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : null;
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
