import { getWebhookInfo, setWebhook } from "../../../../src/telegram";

export const dynamic = "force-dynamic";

/**
 * One-time webhook registration. Open in a browser:
 *   https://<your-app>.vercel.app/api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || url.searchParams.get("secret") !== secret) return new Response("forbidden", { status: 403 });

  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const webhook = `https://${host}/api/telegram`;
  try {
    const result = await setWebhook(webhook, secret);
    const info = await getWebhookInfo();
    return Response.json({ registered: webhook, result, info });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
