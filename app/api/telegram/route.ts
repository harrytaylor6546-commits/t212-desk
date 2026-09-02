import { waitUntil } from "@vercel/functions";
import { handleUpdate } from "../../../src/bot";
import type { TelegramUpdate } from "../../../src/telegram";

// Research plus the analyst can take a couple of minutes.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || got !== expected) return new Response("forbidden", { status: 403 });

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Acknowledge immediately so Telegram does not retry, keep working in the background.
  waitUntil(handleUpdate(update).catch((e) => console.error("telegram handler failed", e)));
  return Response.json({ ok: true });
}
