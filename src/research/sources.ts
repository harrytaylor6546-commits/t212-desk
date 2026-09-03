import { config } from "../config";
import type { Item, PriceSummary } from "./types";

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
      publishedAt: toIso(inner(block, "pubDate")),
      snippet: stripTags(inner(block, "description") ?? "").slice(0, 300),
    }));
}

/** RFC 2822 or anything Date can parse, to ISO. Undefined if unparseable. */
function toIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = new Date(s.trim()).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
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

function sma(values: number[], n: number): number | undefined {
  if (values.length < n) return undefined;
  const slice = values.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

function rsi(closes: number[], n = 14): number | undefined {
  if (closes.length < n + 1) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / n / (losses / n);
  return 100 - 100 / (1 + rs);
}

/** Yahoo Finance chart endpoint. Unofficial, keyless, good enough for context. */
export async function yahooPrice(symbol: string, range: "3mo" | "6mo" | "1y" = "6mo"): Promise<PriceSummary> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const data = await getJson<any>(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`no price data for ${symbol}`);
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes: (number | null)[] = q.close ?? [];
  const opens: (number | null)[] = q.open ?? [];
  const vols: (number | null)[] = q.volume ?? [];
  const bars = ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: closes[i],
      open: opens[i] ?? undefined,
      volume: vols[i] ?? undefined,
    }))
    .filter((b): b is { date: string; close: number; open: number | undefined; volume: number | undefined } => typeof b.close === "number");
  const last = bars.at(-1)?.close;
  const pct = (n: number) => {
    const then = bars.at(-1 - n)?.close;
    return last !== undefined && then ? ((last - then) / then) * 100 : undefined;
  };
  const closeSeries = bars.map((b) => b.close);
  const prevVols = bars.slice(-21, -1).map((b) => b.volume ?? 0).filter((v) => v > 0);
  const avgVol20 = prevVols.length >= 5 ? prevVols.reduce((s, v) => s + v, 0) / prevVols.length : undefined;
  const todayVol = bars.at(-1)?.volume;
  const prevClose = bars.at(-2)?.close;
  const todayOpen = bars.at(-1)?.open;
  const high52w = result.meta?.fiftyTwoWeekHigh ?? Math.max(...closeSeries);
  return {
    symbol,
    currency: result.meta?.currency,
    last,
    change1d: pct(1),
    change5d: pct(5),
    change1m: pct(21),
    change3m: pct(63),
    high52w,
    low52w: result.meta?.fiftyTwoWeekLow ?? Math.min(...closeSeries),
    sma20: sma(closeSeries, 20),
    sma50: sma(closeSeries, 50),
    rsi14: rsi(closeSeries, 14),
    relVolume: avgVol20 && todayVol ? todayVol / avgVol20 : undefined,
    gapPct: prevClose && todayOpen ? ((todayOpen - prevClose) / prevClose) * 100 : undefined,
    pctFromHigh52w: last && high52w ? (last / high52w - 1) * 100 : undefined,
    bars: bars.slice(-30).map(({ date, close, volume }) => ({ date, close, volume })),
  };
}

/** Yahoo Finance news for a symbol. Keyless. */
export async function yahooNews(symbol: string, limit = 12): Promise<Item[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${limit}&quotesCount=0&listsCount=0`;
  const data = await getJson<{ news?: any[] }>(url);
  return (data.news ?? []).map((n) => ({
    source: "yahoo" as const,
    title: `${n.title}${n.publisher ? ` - ${n.publisher}` : ""}`,
    url: n.link,
    publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : undefined,
  }));
}

// ---- SEC EDGAR (US names only) ----
const SEC_UA = "t212-desk personal research (aegeaskincare@gmail.com)";
let cikMap: Map<string, string> | undefined;

async function cikFor(symbol: string): Promise<string | undefined> {
  if (!cikMap) {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status} from sec.gov`);
    const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
    cikMap = new Map(Object.values(data).map((r) => [r.ticker.toUpperCase(), String(r.cik_str).padStart(10, "0")]));
  }
  return cikMap.get(symbol.toUpperCase().replace(".", "-"));
}

const INTERESTING_FORMS = new Set(["8-K", "10-Q", "10-K", "4", "SC 13D", "SC 13G", "424B5", "S-3", "DEF 14A"]);

/** Recent SEC filings for a US symbol. Free, needs a descriptive User-Agent. */
export async function edgarFilings(symbol: string, days = 30, limit = 8): Promise<Item[]> {
  const cik = await cikFor(symbol);
  if (!cik) return [];
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} from data.sec.gov`);
  const data = (await res.json()) as { filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; items?: string[] } } };
  const r = data.filings?.recent;
  if (!r) return [];
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out: Item[] = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    if (!INTERESTING_FORMS.has(r.form[i])) continue;
    if (new Date(r.filingDate[i]).getTime() < cutoff) continue;
    const acc = r.accessionNumber[i].replace(/-/g, "");
    out.push({
      source: "filing",
      title: `SEC ${r.form[i]}${r.items?.[i] ? ` (items ${r.items[i]})` : ""}`,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${r.primaryDocument[i]}`,
      publishedAt: r.filingDate[i],
    });
  }
  return out;
}

// ---- Finnhub (optional free key) ----
function finnhubKey(): string | undefined {
  return process.env.FINNHUB_API_KEY || undefined;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Company news from Finnhub. Only runs when FINNHUB_API_KEY is set. */
export async function finnhubNews(symbol: string, days = 7, limit = 12): Promise<Item[]> {
  const key = finnhubKey();
  if (!key) return [];
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${iso(from)}&to=${iso(to)}&token=${key}`;
  const data = await getJson<any[]>(url);
  return (Array.isArray(data) ? data : []).slice(0, limit).map((n) => ({
    source: "news" as const,
    title: `${n.headline}${n.source ? ` - ${n.source}` : ""}`,
    url: n.url,
    publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : undefined,
    snippet: String(n.summary ?? "").slice(0, 300),
  }));
}

/** Upcoming or just-passed earnings date from Finnhub. Only runs when FINNHUB_API_KEY is set. */
export async function finnhubEarnings(symbol: string): Promise<Item[]> {
  const key = finnhubKey();
  if (!key) return [];
  const from = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const to = new Date(Date.now() + 21 * 24 * 3600 * 1000);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${iso(from)}&to=${iso(to)}&symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const data = await getJson<{ earningsCalendar?: any[] }>(url);
  return (data.earningsCalendar ?? []).map((e) => ({
    source: "earnings" as const,
    title: `earnings ${e.date}${e.hour ? ` (${e.hour})` : ""}: EPS est ${e.epsEstimate ?? "?"} actual ${e.epsActual ?? "pending"}, revenue est ${e.revenueEstimate ?? "?"} actual ${e.revenueActual ?? "pending"}`,
    publishedAt: e.date,
  }));
}
