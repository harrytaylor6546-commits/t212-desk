import { config } from "../config.js";
import type { Item, PriceSummary } from "./types.js";

// Several public endpoints (Reddit, StockTwits, Yahoo) return 403 to non-browser user agents.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-GB,en;q=0.9", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  return JSON.parse(await getText(url, headers)) as T;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Inner text of the first <tag>...</tag> in block, CDATA unwrapped. Plain string scanning, no regex. */
function inner(block: string, tag: string): string | undefined {
  const open = block.indexOf("<" + tag);
  if (open < 0) return undefined;
  const openEnd = block.indexOf(">", open);
  const close = block.indexOf("</" + tag + ">", openEnd);
  if (openEnd < 0 || close < 0) return undefined;
  let text = block.slice(openEnd + 1, close);
  if (text.startsWith("<![CDATA[")) text = text.slice(9, text.lastIndexOf("]]>"));
  return text;
}

/** Value of attribute on the first <tag ...> in block. */
function attr(block: string, tag: string, attrName: string): string | undefined {
  const open = block.indexOf("<" + tag);
  if (open < 0) return undefined;
  const end = block.indexOf(">", open);
  const head = block.slice(open, end);
  const needle = attrName + '="';
  const s = head.indexOf(needle);
  if (s < 0) return undefined;
  const e = head.indexOf('"', s + needle.length);
  return e < 0 ? undefined : decodeEntities(head.slice(s + needle.length, e));
}

/** Split an XML document into the raw text of each <tag> element. */
function split(xml: string, tag: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf("<" + tag + ">", i);
    const b = xml.indexOf("<" + tag + " ", i);
    const s = a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (s < 0) break;
    const e = xml.indexOf("</" + tag + ">", s);
    if (e < 0) break;
    out.push(xml.slice(s, e));
    i = e + 1;
  }
  return out;
}

/** Google News RSS. Free, no key, UK edition. */
export async function googleNews(query: string, limit = 15): Promise<Item[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const xml = await getText(url);
  return split(xml, "item")
    .slice(0, limit)
    .map((block) => ({
      source: "news" as const,
      title: stripTags(inner(block, "title") ?? "(untitled)"),
      url: inner(block, "link")?.trim(),
      publishedAt: inner(block, "pubDate")?.trim(),
      snippet: stripTags(inner(block, "description") ?? "").slice(0, 300),
    }));
}

/** Reddit search as an Atom feed. The JSON endpoint 403s from most IPs; the RSS one does not. */
export async function reddit(query: string, limit = 15): Promise<Item[]> {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=week&limit=${limit}`;
  const xml = await getText(url);
  return split(xml, "entry")
    .slice(0, limit)
    .map((block) => {
      const title = stripTags(inner(block, "title") ?? "(untitled)");
      const cat = attr(block, "category", "label") ?? attr(block, "category", "term");
      return {
        source: "reddit" as const,
        title: cat ? `[${cat}] ${title}` : title,
        url: attr(block, "link", "href"),
        publishedAt: inner(block, "updated")?.trim(),
        snippet: stripTags(inner(block, "content") ?? "").slice(0, 300),
      };
    });
}

/** StockTwits public symbol stream. Mostly US tickers. */
export async function stocktwits(symbol: string, limit = 15): Promise<Item[]> {
  const data = await getJson<{ messages: any[] }>(
    `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`,
  );
  return data.messages.slice(0, limit).map((m) => ({
    source: "stocktwits" as const,
    title: `${m.user?.username ?? "user"}${m.entities?.sentiment?.basic ? ` (${m.entities.sentiment.basic})` : ""}`,
    url: `https://stocktwits.com/symbol/${symbol}`,
    publishedAt: m.created_at,
    snippet: String(m.body ?? "").slice(0, 300),
  }));
}

/** X API v2 recent search. Only runs when X_BEARER_TOKEN is set. */
export async function x(query: string, limit = 20): Promise<Item[]> {
  if (!config.research.xBearerToken) return [];
  const qs = new URLSearchParams({
    query: `${query} -is:retweet lang:en`,
    max_results: String(Math.min(Math.max(limit, 10), 100)),
    "tweet.fields": "created_at,public_metrics,author_id",
  });
  const data = await getJson<{ data?: any[] }>(`https://api.x.com/2/tweets/search/recent?${qs}`, {
    Authorization: `Bearer ${config.research.xBearerToken}`,
  });
  return (data.data ?? []).map((t) => ({
    source: "x" as const,
    title: `likes ${t.public_metrics?.like_count ?? 0}, reposts ${t.public_metrics?.retweet_count ?? 0}`,
    url: `https://x.com/i/web/status/${t.id}`,
    publishedAt: t.created_at,
    snippet: String(t.text ?? "").slice(0, 300),
  }));
}

/** Tavily web search. Only runs when TAVILY_API_KEY is set. */
export async function tavily(query: string, limit = 8): Promise<Item[]> {
  if (!config.research.tavilyKey) return [];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      api_key: config.research.tavilyKey,
      query,
      search_depth: "basic",
      topic: "news",
      days: 7,
      max_results: limit,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} from tavily`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? []).map((r) => ({
    source: "web" as const,
    title: r.title,
    url: r.url,
    publishedAt: r.published_date,
    snippet: String(r.content ?? "").slice(0, 300),
  }));
}

/** Yahoo Finance chart endpoint. Unofficial, keyless, good enough for context. */
export async function yahooPrice(symbol: string): Promise<PriceSummary> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const data = await getJson<any>(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`no price data for ${symbol}`);
  const ts: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  const vols: (number | null)[] = result.indicators?.quote?.[0]?.volume ?? [];
  const bars = ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i], volume: vols[i] ?? undefined }))
    .filter((b): b is { date: string; close: number; volume: number | undefined } => typeof b.close === "number");
  const last = bars.at(-1)?.close;
  const pct = (n: number) => {
    const then = bars.at(-1 - n)?.close;
    return last !== undefined && then ? ((last - then) / then) * 100 : undefined;
  };
  return {
    symbol,
    currency: result.meta?.currency,
    last,
    change1d: pct(1),
    change5d: pct(5),
    change1m: pct(21),
    change3m: pct(63),
    high52w: result.meta?.fiftyTwoWeekHigh ?? Math.max(...bars.map((b) => b.close)),
    low52w: result.meta?.fiftyTwoWeekLow ?? Math.min(...bars.map((b) => b.close)),
    bars: bars.slice(-30),
  };
}
