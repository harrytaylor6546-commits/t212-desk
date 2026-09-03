import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { edgarFilings, finnhubEarnings, finnhubNews, googleNews, reddit, stocktwits, tavily, x, yahooNews, yahooPrice } from "./sources";
import type { Dossier, Item, PriceSummary } from "./types";

/**
 * Map a Trading 212 ticker to a Yahoo Finance symbol.
 * T212 examples: AAPL_US_EQ, BARCl_EQ (London), SAPd_EQ (Xetra), ASMLa_EQ (Amsterdam).
 */
export function toYahooSymbol(t212Ticker: string): string {
  const core = t212Ticker.replace(/_EQ$/, "");
  if (core.endsWith("_US")) return core.slice(0, -3).replace(".", "-");
  const suffixMap: Record<string, string> = {
    l: ".L", d: ".DE", a: ".AS", p: ".PA", m: ".MI", e: ".MC", s: ".SW", h: ".HE", c: ".CO", st: ".ST", o: ".OL", v: ".VI", b: ".BR", li: ".LS",
  };
  const m = core.match(/^([A-Z0-9.]+)([a-z]{1,2})$/);
  if (m && suffixMap[m[2]]) return m[1] + suffixMap[m[2]];
  return core;
}

export function isUS(t212Ticker: string): boolean {
  return t212Ticker.endsWith("_US_EQ");
}

async function safely(label: string, fn: () => Promise<Item[]>, errors: string[]): Promise<Item[]> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${(e as Error).message}`);
    return [];
  }
}

// ---- market backdrop, cached 15 minutes per process ----
let marketMemo: { at: number; text: string } | undefined;

export async function marketContext(): Promise<string> {
  if (marketMemo && Date.now() - marketMemo.at < 15 * 60 * 1000) return marketMemo.text;
  const indices: [string, string][] = [["FTSE 100", "^FTSE"], ["S&P 500", "^GSPC"], ["Nasdaq", "^IXIC"], ["VIX", "^VIX"], ["GBP/USD", "GBPUSD=X"]];
  const parts = await Promise.all(
    indices.map(async ([label, sym]) => {
      try {
        const p = await yahooPrice(sym, "3mo");
        const f = (n?: number) => (n === undefined ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
        return `${label} ${p.last?.toFixed(sym === "GBPUSD=X" ? 4 : 0) ?? "n/a"} (1d ${f(p.change1d)}, 5d ${f(p.change5d)})`;
      } catch {
        return `${label} n/a`;
      }
    }),
  );
  const text = parts.join(" | ");
  marketMemo = { at: Date.now(), text };
  return text;
}

function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = (i.url ?? i.title).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function gather(t212Ticker: string, name: string): Promise<Dossier> {
  const yahooSymbol = toYahooSymbol(t212Ticker);
  const errors: string[] = [];
  const bare = yahooSymbol.split(".")[0];
  const q = `"${name}" OR ${bare} stock`;
  const us = isUS(t212Ticker);

  const [price, market, news, ynews, fnews, earnings, filings, red, st, xs, web] = await Promise.all([
    yahooPrice(yahooSymbol).catch((e) => {
      errors.push(`price: ${(e as Error).message}`);
      return undefined as PriceSummary | undefined;
    }),
    marketContext(),
    safely("news", () => googleNews(q), errors),
    safely("yahoo news", () => yahooNews(yahooSymbol), errors),
    safely("finnhub news", () => finnhubNews(yahooSymbol), errors),
    safely("earnings", () => finnhubEarnings(yahooSymbol), errors),
    us ? safely("sec", () => edgarFilings(bare), errors) : Promise.resolve([] as Item[]),
    safely("reddit", () => reddit(`${bare} ${name}`), errors),
    us ? safely("stocktwits", () => stocktwits(bare), errors) : Promise.resolve([] as Item[]),
    safely("x", () => x(`$${bare} OR "${name}"`), errors),
    safely("web", () => tavily(`${name} ${bare} stock news`), errors),
  ]);

  const dossier: Dossier = {
    ticker: t212Ticker,
    yahooSymbol,
    name,
    gatheredAt: new Date().toISOString(),
    price,
    market,
    items: dedupe([...earnings, ...filings, ...news, ...ynews, ...fnews, ...web, ...red, ...st, ...xs]),
    errors,
  };

  // Keep a local copy for later review. Serverless filesystems are read-only, so this is best-effort.
  try {
    const dir = path.join(config.dataDir, "cache", "dossiers");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${t212Ticker}-${Date.now()}.json`), JSON.stringify(dossier, null, 2));
  } catch {
    /* ignore */
  }
  return dossier;
}

function priceLines(p: PriceSummary): string[] {
  const f = (n?: number, dp = 2) => (n === undefined ? "n/a" : n.toFixed(dp));
  const pc = (n?: number) => (n === undefined ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
  return [
    `Price ${f(p.last)} ${p.currency ?? ""} | 1d ${pc(p.change1d)} | 5d ${pc(p.change5d)} | 1m ${pc(p.change1m)} | 3m ${pc(p.change3m)} | 52w ${f(p.low52w)}-${f(p.high52w)} (${pc(p.pctFromHigh52w)} from high)`,
    `Technicals: SMA20 ${f(p.sma20)} | SMA50 ${f(p.sma50)} | RSI14 ${f(p.rsi14, 0)} | gap today ${pc(p.gapPct)} | volume vs 20d avg ${p.relVolume === undefined ? "n/a" : p.relVolume.toFixed(2) + "x (partial if session open)"}`,
    "Last 30 closes: " + p.bars.map((b) => `${b.date.slice(5)}:${b.close.toFixed(2)}`).join(" "),
  ];
}

/** Compact one-screen version for the triage model. */
export function renderBrief(d: Dossier, maxItems = 10): string {
  const lines: string[] = [`# ${d.name} (${d.ticker})`];
  if (d.price) lines.push(...priceLines(d.price).slice(0, 2));
  const recent = [...d.items]
    .filter((i) => i.source !== "reddit" && i.source !== "stocktwits" && i.source !== "x")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, maxItems);
  for (const i of recent) lines.push(`- [${i.source}${i.publishedAt ? " " + i.publishedAt.slice(0, 10) : ""}] ${i.title}`);
  const social = d.items.filter((i) => i.source === "reddit" || i.source === "stocktwits" || i.source === "x").length;
  if (social) lines.push(`- ${social} social posts (reddit/stocktwits/x)`);
  return lines.join("\n");
}

export function renderDossier(d: Dossier): string {
  const lines: string[] = [];
  lines.push(`# ${d.name} (${d.ticker}, yahoo ${d.yahooSymbol})`);
  lines.push(`Gathered ${d.gatheredAt}`);
  if (d.market) lines.push(`Market backdrop: ${d.market}`);
  if (d.price) lines.push(...priceLines(d.price));
  for (const src of ["earnings", "filing", "news", "yahoo", "web", "reddit", "stocktwits", "x"] as const) {
    const items = d.items.filter((i) => i.source === src);
    if (!items.length) continue;
    lines.push(`\n## ${src} (${items.length})`);
    for (const i of items) {
      lines.push(`- ${i.publishedAt ? `[${i.publishedAt}] ` : ""}${i.title}${i.url ? ` <${i.url}>` : ""}`);
      if (i.snippet) lines.push(`  ${i.snippet.replace(/\s+/g, " ")}`);
    }
  }
  if (d.errors.length) lines.push(`\n## source errors\n${d.errors.map((e) => `- ${e}`).join("\n")}`);
  return lines.join("\n");
}
