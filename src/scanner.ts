import { store } from "./store";
import { googleNews, yahooPrice } from "./research/sources";
import { toYahooSymbol } from "./research/index";

/**
 * Candidate selection for the campaign. A cheap, keyless pre-screen (price move + news
 * volume) ranks the watchlist, and only the top few go to the analyst, which costs money.
 */

export const DEFAULT_WATCHLIST = [
  // London
  "RRl_EQ", "BARCl_EQ", "LLOYl_EQ", "NWGl_EQ", "HSBAl_EQ", "BPl_EQ", "SHELl_EQ", "AZNl_EQ", "GSKl_EQ",
  "BAl_EQ", "RIOl_EQ", "GLENl_EQ", "ULVRl_EQ", "TSCOl_EQ", "VODl_EQ", "IAGl_EQ", "EZJl_EQ", "LGENl_EQ",
  "AVl_EQ", "DGEl_EQ", "BATSl_EQ", "MKSl_EQ", "OCDOl_EQ", "JDl_EQ",
  // US
  "AAPL_US_EQ", "MSFT_US_EQ", "NVDA_US_EQ", "AMZN_US_EQ", "GOOGL_US_EQ", "META_US_EQ", "TSLA_US_EQ",
  "AMD_US_EQ", "NFLX_US_EQ", "PLTR_US_EQ", "COIN_US_EQ", "UBER_US_EQ", "DIS_US_EQ", "BA_US_EQ", "JPM_US_EQ",
];

const KEY = "watchlist";

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
  recentNews: number;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Rank tickers by how much is going on: recent price movement plus news in the last two days. */
export async function prescreen(tickers: { ticker: string; name: string }[]): Promise<Candidate[]> {
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  const scored = await mapLimit(tickers, 5, async ({ ticker, name }): Promise<Candidate> => {
    const symbol = toYahooSymbol(ticker);
    const [price, news] = await Promise.all([
      yahooPrice(symbol).catch(() => undefined),
      googleNews(`"${name}" OR ${symbol.split(".")[0]} shares`, 15).catch(() => []),
    ]);
    const recentNews = news.filter((n) => n.publishedAt && new Date(n.publishedAt).getTime() > cutoff).length;
    const c1 = price?.change1d ?? 0;
    const c5 = price?.change5d ?? 0;
    // Movement is interesting in either direction. News volume is the tie-breaker.
    const score = Math.abs(c1) * 2 + Math.abs(c5) + recentNews * 1.5;
    return { ticker, name, score, change1d: price?.change1d, change5d: price?.change5d, recentNews };
  });
  return scored.sort((a, b) => b.score - a.score);
}
