import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { buildSystemPrompt, loadBrief } from "@/lib/brief";
import { markSeen } from "@/lib/dedupe";
import { toMexicoWhatsappJid } from "@/lib/mexicoJid";
import { sendText } from "@/lib/whapi";

export const runtime = "nodejs";
export const maxDuration = 60;

type WhapiMessage = {
  id?: string;
  from_me?: boolean;
  fromMe?: boolean;
  chat_id?: string;
  from?: string;
  type?: string;
  text?: { body?: string } | string;
  body?: string;
  location?: { latitude?: number; longitude?: number; caption?: string };
};

/**
 * Auth: prefer header `x-bot-webhook-secret`, also accept `?secret=` fallback.
 * Documented in README / ONBOARDING.
 */
function verifySecret(req: NextRequest): boolean {
  const expected = process.env.WEBHOOK_SECRET || "";
  if (!expected) {
    // Fail closed if secret not configured in production-like deploys
    console.warn("[bot] WEBHOOK_SECRET missing — rejecting webhook");
    return false;
  }
  const header =
    req.headers.get("x-bot-webhook-secret") ||
    req.headers.get("X-Bot-Webhook-Secret") ||
    "";
  const query = req.nextUrl.searchParams.get("secret") || "";
  return header === expected || query === expected;
}

function extractText(msg: WhapiMessage): string | null {
  if (msg.type === "location" || msg.location) {
    const loc = msg.location;
    if (!loc?.latitude || loc.longitude === undefined) return null;
    const caption = (loc.caption || "").trim();
    const parts = [
      "[El cliente compartió ubicación GPS]",
      `Lat: ${loc.latitude}, Lng: ${loc.longitude}`,
      `Maps: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`,
    ];
    if (caption) parts.push(`Caption: ${caption}`);
    return parts.join("\n");
  }

  if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
  if (msg.text && typeof msg.text === "object" && msg.text.body?.trim()) {
    return msg.text.body.trim();
  }
  if (typeof msg.body === "string" && msg.body.trim()) return msg.body.trim();
  return null;
}

function collectMessages(payload: unknown): WhapiMessage[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;

  if (Array.isArray(p.messages)) {
    return p.messages.filter((m): m is WhapiMessage => !!m && typeof m === "object");
  }

  // Some providers nest under data / message
  if (p.message && typeof p.message === "object") {
    return [p.message as WhapiMessage];
  }
  if (p.data && typeof p.data === "object") {
    const d = p.data as Record<string, unknown>;
    if (Array.isArray(d.messages)) {
      return d.messages.filter(
        (m): m is WhapiMessage => !!m && typeof m === "object",
      );
    }
  }
  return [];
}

async function generateReply(userText: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const brief = loadBrief();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const client = new OpenAI({ apiKey });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.6,
    messages: [
      { role: "system", content: buildSystemPrompt(brief) },
      { role: "user", content: userText },
    ],
  });

  const reply = (completion.choices[0]?.message?.content || "").trim();
  return (
    reply ||
    "Gracias por escribirnos. En un momento te atendemos. ¿En qué te podemos ayudar?"
  );
}

async function processMessage(msg: WhapiMessage): Promise<void> {
  const msgId = msg.id || "";
  if (!markSeen(msgId)) {
    console.info("[bot] DUPLICATE_MESSAGE id=%s", msgId);
    return;
  }

  const fromMe = msg.from_me === true || msg.fromMe === true;
  if (fromMe) {
    console.info("[bot] ignore fromMe id=%s", msgId);
    return;
  }

  const chatId = msg.chat_id || msg.from;
  if (!chatId) {
    console.warn("[bot] message without chat_id/from id=%s", msgId);
    return;
  }

  const text = extractText(msg);
  if (!text) {
    console.info("[bot] ignore non-text type=%s id=%s", msg.type, msgId);
    return;
  }

  let toJid: string;
  try {
    toJid = toMexicoWhatsappJid(chatId);
  } catch {
    // Groups / non-MX: pass through as-is if already a JID
    toJid = chatId.includes("@") ? chatId : `${chatId}@s.whatsapp.net`;
  }

  console.info(
    "[bot] inbound id=%s to=%s chars=%s",
    msgId,
    toJid,
    text.length,
  );

  const reply = await generateReply(text);
  await sendText(toJid, reply);
  console.info("[bot] replied id=%s chars=%s", msgId, reply.length);
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 },
    );
  }

  const messages = collectMessages(payload);
  if (messages.length === 0) {
    // Ack non-message events (statuses, etc.) so Whapi does not retry forever
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Process sequentially; always try to return 200 so Whapi does not storm retries
  const errors: string[] = [];
  for (const msg of messages) {
    try {
      await processMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[bot] process error:", message);
      errors.push(message);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: messages.length,
    errors: errors.length ? errors.length : undefined,
  });
}

/** Optional GET for human smoke-checks (does not replace Whapi POST). */
export async function GET(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    hint: "Webhook listo. Configura Whapi POST a esta URL con eventos messages / messages.post.",
  });
}
