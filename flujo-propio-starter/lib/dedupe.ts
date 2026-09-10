/**
 * In-memory message-id dedupe for the starter.
 *
 * Whapi retries webhooks; without dedupe the bot replies twice.
 * For production, replace with a durable store (e.g. Postgres unique on message_id).
 */

const seen = new Map<string, number>();
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 5000;

function prune(now: number) {
  for (const [id, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(id);
  }
  if (seen.size > MAX_ENTRIES) {
    const excess = seen.size - Math.floor(MAX_ENTRIES / 2);
    let i = 0;
    for (const id of seen.keys()) {
      if (i++ >= excess) break;
      seen.delete(id);
    }
  }
}

/** Returns true if this id is new (should process). Empty id → always process. */
export function markSeen(messageId: string): boolean {
  if (!messageId) return true;
  const now = Date.now();
  prune(now);
  if (seen.has(messageId)) return false;
  seen.set(messageId, now);
  return true;
}
