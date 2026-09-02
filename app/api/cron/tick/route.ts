import { tick } from "../../../../src/autopilot";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Campaign tick: exits, goal check, next recommendation.
 * Call every 15 minutes in market hours with "Authorization: Bearer <CRON_SECRET>".
 * The daily Vercel cron also hits it as a fallback.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  const url = new URL(request.url);
  const ok = !!secret && (auth === `Bearer ${secret}` || url.searchParams.get("secret") === secret);
  if (!ok) return new Response("forbidden", { status: 403 });
  try {
    const log = await tick({ force: url.searchParams.get("force") === "1" });
    return new Response(log.join("\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.error("tick failed", e);
    return new Response(`tick failed: ${(e as Error).message}`, { status: 500 });
  }
}
