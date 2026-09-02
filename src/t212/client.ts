import fs from "node:fs";
import path from "node:path";
import { config, requireT212Key } from "../config.js";
import type {
  AccountCash,
  AccountInfo,
  Instrument,
  LimitOrderRequest,
  MarketOrderRequest,
  Order,
  Position,
  StopLimitOrderRequest,
  StopOrderRequest,
} from "./types.js";

export class T212Error extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Trading 212 ${status} on ${path}: ${body || "(empty body)"}`);
  }
}

/**
 * Minimal Trading 212 public API client.
 *
 * Practice (demo) and live share the same paths; only the host differs.
 * Live accounts currently accept MARKET orders only through the API.
 * Instruments are cached to disk because that endpoint allows one call per 50s.
 */
export class T212Client {
  private readonly base = config.t212.baseUrl;
  private lastCall = new Map<string, number>();

  readonly env = config.t212.env;

  private authHeader(): string {
    requireT212Key();
    const { apiKey, apiSecret } = config.t212;
    if (apiSecret) {
      return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    }
    return apiKey;
  }

  /** Simple client-side throttle so we stay under the per-endpoint limits. */
  private async throttle(key: string, minGapMs: number): Promise<void> {
    const last = this.lastCall.get(key) ?? 0;
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall.set(key, Date.now());
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    p: string,
    body?: unknown,
    throttleKey = p,
    minGapMs = 1000,
  ): Promise<T> {
    await this.throttle(throttleKey, minGapMs);
    const res = await fetch(this.base + p, {
      method,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new T212Error(res.status, text, p);
    return (text ? JSON.parse(text) : null) as T;
  }

  // ---- account ----
  cash(): Promise<AccountCash> {
    return this.request("GET", "/equity/account/cash", undefined, "cash", 2000);
  }

  info(): Promise<AccountInfo> {
    return this.request("GET", "/equity/account/info", undefined, "info", 30_000);
  }

  // ---- portfolio ----
  portfolio(): Promise<Position[]> {
    return this.request("GET", "/equity/portfolio", undefined, "portfolio", 5000);
  }

  position(ticker: string): Promise<Position> {
    return this.request("GET", `/equity/portfolio/${encodeURIComponent(ticker)}`, undefined, "position", 1000);
  }

  // ---- instruments (cached 24h on disk) ----
  async instruments(force = false): Promise<Instrument[]> {
    const file = path.join(config.dataDir, "cache", `instruments-${this.env}.json`);
    if (!force && fs.existsSync(file)) {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age < 24 * 3600 * 1000) {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Instrument[];
      }
    }
    const list = await this.request<Instrument[]>(
      "GET",
      "/equity/metadata/instruments",
      undefined,
      "instruments",
      50_000,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list));
    return list;
  }

  async findInstruments(query: string): Promise<Instrument[]> {
    const q = query.toLowerCase();
    const all = await this.instruments();
    return all
      .filter(
        (i) =>
          i.ticker.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q) ||
          (i.shortName ?? "").toLowerCase().includes(q) ||
          (i.isin ?? "").toLowerCase() === q,
      )
      .slice(0, 25);
  }

  async instrument(ticker: string): Promise<Instrument | undefined> {
    const all = await this.instruments();
    return all.find((i) => i.ticker === ticker);
  }

  // ---- orders ----
  orders(): Promise<Order[]> {
    return this.request("GET", "/equity/orders", undefined, "orders", 5000);
  }

  order(id: number): Promise<Order> {
    return this.request("GET", `/equity/orders/${id}`, undefined, "order", 1000);
  }

  cancel(id: number): Promise<void> {
    return this.request("DELETE", `/equity/orders/${id}`, undefined, "cancel", 1000);
  }

  placeMarket(req: MarketOrderRequest): Promise<Order> {
    return this.request("POST", "/equity/orders/market", req, "place", 1200);
  }

  placeLimit(req: LimitOrderRequest): Promise<Order> {
    this.assertPractice("limit");
    return this.request("POST", "/equity/orders/limit", req, "place", 1200);
  }

  placeStop(req: StopOrderRequest): Promise<Order> {
    this.assertPractice("stop");
    return this.request("POST", "/equity/orders/stop", req, "place", 1200);
  }

  placeStopLimit(req: StopLimitOrderRequest): Promise<Order> {
    this.assertPractice("stop-limit");
    return this.request("POST", "/equity/orders/stop_limit", req, "place", 1200);
  }

  orderHistory(ticker?: string, limit = 50): Promise<{ items: Order[]; nextPagePath?: string }> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (ticker) qs.set("ticker", ticker);
    return this.request("GET", `/equity/history/orders?${qs}`, undefined, "history", 10_000);
  }

  private assertPractice(kind: string): void {
    if (this.env === "live") {
      throw new Error(
        `Trading 212 live accounts only accept MARKET orders via the API right now. ${kind} orders are practice-only.`,
      );
    }
  }
}
