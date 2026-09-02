import { pushReview } from "../../../../src/bot";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>". */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await pushReview();
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.error("review cron failed", e);
    return new Response(`review failed: ${(e as Error).message}`, { status: 500 });
  }
}
