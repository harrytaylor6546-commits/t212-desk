export interface Item {
  source: "news" | "yahoo" | "reddit" | "stocktwits" | "x" | "web" | "filing" | "earnings" | "price";
  title: string;
  url?: string;
  publishedAt?: string;
  snippet?: string;
}

export interface PriceSummary {
  symbol: string;
  currency?: string;
  last?: number;
  change1d?: number;
  change5d?: number;
  change1m?: number;
  change3m?: number;
  high52w?: number;
  low52w?: number;
  /** Simple technicals from daily bars. */
  sma20?: number;
  sma50?: number;
  rsi14?: number;
  /** Today's volume divided by the 20-day average. Partial during the session. */
  relVolume?: number;
  /** Today's open versus yesterday's close, percent. */
  gapPct?: number;
  pctFromHigh52w?: number;
  bars: { date: string; close: number; volume?: number }[];
}

export interface Dossier {
  ticker: string;
  yahooSymbol: string;
  name: string;
  gatheredAt: string;
  price?: PriceSummary;
  market?: string;
  items: Item[];
  errors: string[];
}
