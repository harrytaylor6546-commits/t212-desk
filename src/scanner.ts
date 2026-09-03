import { store } from "./store";
import { googleNews, yahooPrice } from "./research/sources";
import { toYahooSymbol } from "./research/index";
import { DEFAULT_UNIVERSE } from "./universe";
import { mapLimit } from "./util";

/**
 * Candidate selection for the campaign, in two cheap stages before anything costs money:
 *   1. price only, across the whole universe: move, gap, volume versus normal
 *   2. news volume in the last 48 hours, on the top slice
 */

export const DEFAULT_WATCHLIST = DEFAULT_UNIVERSE;

const KEY = "watchlist";
const CACHE_KEY = "prescreen-cache";
const CACHE_TTL_MS = 45 * 60 * 1000;

export async function getWatchlist(): Promise<string[]> {
  return (await store.get<string[]>(KEY)) ?? DEFAULT_WATCHLIST;
}

export async function setWatchlist(list: string[]): Promise<void> {
  await store.set(KEY, list);
}

export interface Candidate {
  ticker: string;
  name: string;
  score: number;
  change1d?: number;
  change5d?: number;
  gapPct?: number;
  relVolume?: number;
  recentNews: number;
}

export async function prescreen(
  tickers: { ticker: string; name: string }[],
  opts: { newsTop?: number; useCache?: boolean } = {},
): Promise<Candidate[]> {
  const newsTop = opts.newsTop ?? 25;
  if (opts.useCache !== false) {
    const cached = await store.get<{ at: number; ranked: Candidate[]; n: number }>(CACHE_KEY);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.n === tickers.length) return cached.ranked;
  }

  // Stage 1: price only, whole universe.
  const stage1 = await mapLimit(tickers, 8, async ({ ticker, name }): Promise<Candidate> => {
    const price = await yahooPrice(toYahooSymbol(ticker), "3mo").catch(() => undefined);
    const c1 = price?.change1d ?? 0;
    const c5 = price?.change5d ?? 0;
    const gap = price?.gapPct ?? 0;
    const rv = price?.relVolume ?? 1;
    const score = Math.abs(c1) * 2 + Math.abs(c5) + Math.abs(gap) * 2 + Math.max(0, rv - 1) * 4;
    return { ticker, name, score: price ? score : -1, change1d: price?.change1d, change5d: price?.change5d, gapPct: price?.gapPct, relVolume: price?.relVolume, recentNews: 0 };
  });
  const ranked = stage1.filter((c) => c.score >= 0).sort((a, b) => b.score - a.score);

  // Stage 2: news volume on the top slice.
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  const top = ranked.slice(0, newsTop);
  await mapLimit(top, 5, async (c) => {
    const symbol = toYahooSymbol(c.ticker);
    const news = await googleNews(`"${c.name}" OR ${symbol.split(".")[0]} shares`, 15).catch(() => []);
    c.recentNews = news.filter((n) => n.publishedAt && new Date(n.publishedAt).getTime() > cutoff).length;
    c.score += c.recentNews * 1.5;
  });
  ranked.sort((a, b) => b.score - a.score);

  await store.set(CACHE_KEY, { at: Date.now(), ranked, n: tickers.length });
  return ranked;
}
