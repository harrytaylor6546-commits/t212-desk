import { config, requireT212Key } from "../config";
import { store } from "../store";
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
} from "./types";

export class T212Error extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`Trading 212 ${status} on ${path}: ${body || "(empty body)"}`);
  }
}

interface InstrumentCache {
  fetchedAt: string;
  items: Instrument[];
}

let instrumentMemo: InstrumentCache | undefined;

/**
 * Minimal Trading 212 public API client.
 *
 * Practice (demo) and live share the same paths; only the host differs.
 * Live accounts currently accept MARKET orders only through the API.
 * Instruments are cached for a day because that endpoint allows one call per 50s.
 */
// Module-level so every T212Client in the same process shares one queue and one cache.
const queues = new Map<string, Promise<void>>();
const lastCall = new Map<string, number>();
const memo = new Map<string, { at: number; value: unknown }>();
const MEMO_TTL_MS = 4000;

export class T212Client {
  private readonly base = config.t212.baseUrl;

  readonly env = config.t212.env;

  private authHeader(): string {
    requireT212Key();
    const { apiKey, apiSecret } = config.t212;
    if (apiSecret) {
      return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
    }
    return apiKey;
  }

  /**
   * Per-endpoint throttle. Calls with the same key run one at a time, spaced by minGapMs,
   * so a burst of overlapping calls cannot trip Trading 212's limits.
   */
  private throttled<T>(key: string, minGapMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (lastCall.get(key) ?? 0) + minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall.set(key, Date.now());
        return fn();
      });
    queues.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    p: string,
    body?: unknown,
    throttleKey = p,
    minGapMs = 1000,
  ): Promise<T> {
    // Repeated reads of the same account endpoint within a few seconds return the cached answer.
    const cacheable = method === "GET" && body === undefined;
    if (cacheable) {
      const hit = memo.get(p);
      if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value as T;
    }
    const call = async (): Promise<T> => {
      const res = await fetch(this.base + p, {
        method,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      const text = await res.text();
      if (!res.ok) throw new T212Error(res.status, text, p);
      return (text ? JSON.parse(text) : null) as T;
    };
    let value: T;
    try {
      value = await this.throttled(throttleKey, minGapMs, call);
    } catch (e) {
      // One retry on a rate limit, after the endpoint's full gap.
      if (e instanceof T212Error && e.status === 429 && cacheable) {
        await new Promise((r) => setTimeout(r, Math.max(minGapMs, 5000)));
        value = await this.throttled(throttleKey, minGapMs, call);
      } else {
        throw e;
      }
    }
    if (cacheable) memo.set(p, { at: Date.now(), value });
    return value;
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

  // ---- instruments (cached 24h in the store, plus in memory) ----
  async instruments(force = false): Promise<Instrument[]> {
    const key = `instruments-${this.env}`;
    const fresh = (c: InstrumentCache | null | undefined) =>
      !!c && Date.now() - new Date(c.fetchedAt).getTime() < 24 * 3600 * 1000;
    if (!force && fresh(instrumentMemo)) return instrumentMemo!.items;
    const cached = force ? null : await store.get<InstrumentCache>(key);
    if (fresh(cached)) {
      instrumentMemo = cached!;
      return cached!.items;
    }
    const items = await this.request<Instrument[]>(
      "GET",
      "/equity/metadata/instruments",
      undefined,
      "instruments",
      50_000,
    );
    instrumentMemo = { fetchedAt: new Date().toISOString(), items };
    await store.set(key, instrumentMemo);
    return items;
  }

  /** Word-based search: "rolls royce" matches "Rolls-Royce Holdings". */
  async findInstruments(query: string): Promise<Instrument[]> {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const words = norm(query).split(" ").filter(Boolean);
    if (!words.length) return [];
    const all = await this.instruments();
    const exactTicker = all.filter((i) => i.ticker.toLowerCase() === query.toLowerCase());
    const matches = all.filter((i) => {
      const hay = `${norm(i.ticker)} ${norm(i.name)} ${norm(i.shortName ?? "")} ${(i.isin ?? "").toLowerCase()}`;
      return words.every((w) => hay.includes(w));
    });
    // Prefer names that start with the query, then shorter names.
    const first = words[0];
    matches.sort((a, b) => {
      const as = norm(a.name).startsWith(first) ? 0 : 1;
      const bs = norm(b.name).startsWith(first) ? 0 : 1;
      return as - bs || a.name.length - b.name.length;
    });
    return [...exactTicker, ...matches.filter((m) => !exactTicker.includes(m))].slice(0, 25);
  }

  async instrumentCount(): Promise<number> {
    return (await this.instruments()).length;
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
