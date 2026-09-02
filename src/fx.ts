/**
 * Currency helpers so the risk gate always reasons in the account's currency.
 *
 * Trading 212 quotes London-listed instruments in GBX (pence). Yahoo reports
 * the same as "GBp". Both mean one hundredth of a pound.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const rateCache = new Map<string, { rate: number; at: number }>();

export function normaliseCurrency(code: string | undefined): { code: string; scale: number } {
  const c = (code ?? "").trim();
  if (c === "GBX" || c === "GBp" || c === "GBX_EQ") return { code: "GBP", scale: 0.01 };
  return { code: c.toUpperCase(), scale: 1 };
}

/** Spot rate to convert one unit of `from` into `to`, via Yahoo. Cached 15 minutes. */
export async function fxRate(from: string, to: string): Promise<number> {
  const a = normaliseCurrency(from).code;
  const b = normaliseCurrency(to).code;
  if (a === b) return 1;
  const key = `${a}${b}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.at < 15 * 60 * 1000) return cached.rate;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${a}${b}=X?range=1d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FX ${a}->${b}: ${res.status} from Yahoo`);
  const data = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } };
  const rate = data.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!rate) throw new Error(`FX ${a}->${b}: no rate in Yahoo response`);
  rateCache.set(key, { rate, at: Date.now() });
  return rate;
}

/**
 * Convert a quoted price into the account currency.
 * e.g. 1469 GBX with a GBP account -> 14.69. 230 USD with a GBP account -> ~170.
 */
export async function toAccountCurrency(price: number, quotedIn: string | undefined, accountCurrency: string): Promise<number> {
  const q = normaliseCurrency(quotedIn);
  const rate = await fxRate(q.code, accountCurrency);
  return price * q.scale * rate;
}
