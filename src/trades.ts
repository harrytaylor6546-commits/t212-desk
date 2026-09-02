import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Open trades the desk is responsible for exiting.
 * Trading 212 knows about the position; only we know why it was opened,
 * what the target and stop were, and when the three-day clock runs out.
 */
export interface OpenTrade {
  ticker: string;
  proposalId: string;
  env: string;
  side: "LONG" | "SHORT";
  quantity: number;
  openedAt: string;
  entryPrice: number;
  quotedIn?: string;
  targetPrice: number | null;
  stopPrice: number | null;
  horizonDays: number;
  maxHoldDays: number;
}

export const MAX_HOLD_DAYS = 3;

const file = () => path.join(config.dataDir, "open-trades.json");

export function listOpenTrades(): OpenTrade[] {
  const f = file();
  const all = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as OpenTrade[]) : [];
  return all.filter((t) => t.env === config.t212.env);
}

function writeAll(trades: OpenTrade[]): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(trades, null, 2));
}

export function addOpenTrade(trade: OpenTrade): void {
  const f = file();
  const all = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as OpenTrade[]) : [];
  all.push(trade);
  writeAll(all);
}

export function removeOpenTrade(ticker: string): OpenTrade | undefined {
  const f = file();
  const all = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as OpenTrade[]) : [];
  const idx = all.findIndex((t) => t.ticker === ticker && t.env === config.t212.env);
  if (idx < 0) return undefined;
  const [removed] = all.splice(idx, 1);
  writeAll(all);
  return removed;
}

/** Whole trading days (Mon-Fri) elapsed since `from`. Ignores exchange holidays. */
export function tradingDaysSince(from: string, now = new Date()): number {
  const start = new Date(from);
  let days = 0;
  const d = new Date(start);
  d.setUTCHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

export interface ExitCheck {
  shouldExit: boolean;
  urgent: boolean;
  reasons: string[];
  daysHeld: number;
  daysLeft: number;
}

export function checkExit(trade: OpenTrade, currentPrice: number | undefined, now = new Date()): ExitCheck {
  const reasons: string[] = [];
  let urgent = false;
  const daysHeld = tradingDaysSince(trade.openedAt, now);
  const daysLeft = trade.maxHoldDays - daysHeld;

  if (daysLeft <= 0) {
    reasons.push(`time stop: held ${daysHeld} trading days, limit is ${trade.maxHoldDays}`);
    urgent = true;
  } else if (daysLeft === 1) {
    reasons.push(`last day: must be closed by end of the next session`);
  }

  if (currentPrice !== undefined) {
    const long = trade.side === "LONG";
    if (trade.targetPrice !== null && (long ? currentPrice >= trade.targetPrice : currentPrice <= trade.targetPrice)) {
      reasons.push(`target hit: ${currentPrice} vs target ${trade.targetPrice}`);
    }
    if (trade.stopPrice !== null && (long ? currentPrice <= trade.stopPrice : currentPrice >= trade.stopPrice)) {
      reasons.push(`stop hit: ${currentPrice} vs stop ${trade.stopPrice}`);
      urgent = true;
    }
  } else {
    reasons.push("no current price from broker, check manually");
  }

  return { shouldExit: reasons.some((r) => r.startsWith("time stop") || r.startsWith("target") || r.startsWith("stop")), urgent, reasons, daysHeld, daysLeft };
}
