export interface Item {
  source: "news" | "reddit" | "stocktwits" | "x" | "web" | "price";
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
  bars: { date: string; close: number; volume?: number }[];
}

export interface Dossier {
  ticker: string;
  yahooSymbol: string;
  name: string;
  gatheredAt: string;
  price?: PriceSummary;
  items: Item[];
  errors: string[];
}
