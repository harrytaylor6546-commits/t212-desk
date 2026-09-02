import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { googleNews, reddit, stocktwits, tavily, x, yahooPrice } from "./sources.js";
import type { Dossier, Item } from "./types.js";

/**
 * Map a Trading 212 ticker to a Yahoo Finance symbol.
 * T212 examples: AAPL_US_EQ, BARCl_EQ (London), SAPd_EQ (Xetra), ASMLa_EQ (Amsterdam).
 */
export function toYahooSymbol(t212Ticker: string): string {
  const core = t212Ticker.replace(/_EQ$/, "");
  if (core.endsWith("_US")) return core.slice(0, -3);
  const suffixMap: Record<string, string> = {
    l: ".L", d: ".DE", a: ".AS", p: ".PA", m: ".MI", e: ".MC", s: ".SW", h: ".HE", c: ".CO", st: ".ST", o: ".OL", v: ".VI", b: ".BR", li: ".LS",
  };
  const m = core.match(/^([A-Z0-9.]+)([a-z]{1,2})$/);
  if (m && suffixMap[m[2]]) return m[1] + suffixMap[m[2]];
  return core;
}

async function safely(label: string, fn: () => Promise<Item[]>, errors: string[]): Promise<Item[]> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${(e as Error).message}`);
    return [];
  }
}

export async function gather(t212Ticker: string, name: string): Promise<Dossier> {
  const yahooSymbol = toYahooSymbol(t212Ticker);
  const errors: string[] = [];
  const bare = yahooSymbol.split(".")[0];
  const q = `"${name}" OR ${bare} stock`;

  const [price, news, red, st, xs, web] = await Promise.all([
    yahooPrice(yahooSymbol).catch((e) => {
      errors.push(`price: ${(e as Error).message}`);
      return undefined;
    }),
    safely("news", () => googleNews(q), errors),
    safely("reddit", () => reddit(`${bare} ${name}`), errors),
    safely("stocktwits", () => stocktwits(bare), errors),
    safely("x", () => x(`$${bare} OR "${name}"`), errors),
    safely("web", () => tavily(`${name} ${bare} stock news`), errors),
  ]);

  const dossier: Dossier = {
    ticker: t212Ticker,
    yahooSymbol,
    name,
    gatheredAt: new Date().toISOString(),
    price,
    items: [...news, ...web, ...red, ...st, ...xs],
    errors,
  };

  const dir = path.join(config.dataDir, "cache", "dossiers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${t212Ticker}-${Date.now()}.json`), JSON.stringify(dossier, null, 2));
  return dossier;
}

export function renderDossier(d: Dossier): string {
  const lines: string[] = [];
  lines.push(`# ${d.name} (${d.ticker}, yahoo ${d.yahooSymbol})`);
  lines.push(`Gathered ${d.gatheredAt}`);
  if (d.price) {
    const p = d.price;
    const f = (n?: number) => (n === undefined ? "n/a" : n.toFixed(2));
    lines.push(
      `Price ${f(p.last)} ${p.currency ?? ""} | 1d ${f(p.change1d)}% | 5d ${f(p.change5d)}% | 1m ${f(p.change1m)}% | 3m ${f(p.change3m)}% | 52w ${f(p.low52w)}-${f(p.high52w)}`,
    );
    lines.push("Last 30 closes: " + p.bars.map((b) => `${b.date.slice(5)}:${b.close.toFixed(2)}`).join(" "));
  }
  for (const src of ["news", "web", "reddit", "stocktwits", "x"] as const) {
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
