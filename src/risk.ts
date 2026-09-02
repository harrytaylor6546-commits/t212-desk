import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface OrderIntent {
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  estimatedPrice: number;
  freeCash: number;
  heldQuantity: number;
}

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
  estimatedValue: number;
}

interface LedgerEntry {
  at: string;
  ticker: string;
  side: string;
  quantity: number;
  env: string;
}

const ledgerFile = () => path.join(config.dataDir, "orders-ledger.json");

function readLedger(): LedgerEntry[] {
  const f = ledgerFile();
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as LedgerEntry[]) : [];
}

export function recordSubmitted(entry: Omit<LedgerEntry, "at">): void {
  const ledger = readLedger();
  ledger.push({ at: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2));
}

/**
 * Every check here runs in our code, before anything touches the broker.
 * These are deliberately dumb and deterministic. The analyst never sees them
 * and cannot argue with them.
 */
export function checkRisk(intent: OrderIntent): RiskVerdict {
  const reasons: string[] = [];
  const value = intent.quantity * intent.estimatedPrice;
  const r = config.risk;

  if (r.blocklist.includes(intent.ticker.toUpperCase())) reasons.push(`${intent.ticker} is on RISK_BLOCKLIST`);
  if (!(intent.quantity > 0)) reasons.push("quantity must be positive");
  if (!(intent.estimatedPrice > 0)) reasons.push("no usable price to size the order");
  if (value > r.maxOrderValue) reasons.push(`order value ${value.toFixed(2)} exceeds RISK_MAX_ORDER_VALUE ${r.maxOrderValue}`);
  if (intent.side === "BUY") {
    if (value > intent.freeCash) reasons.push(`order value ${value.toFixed(2)} exceeds free cash ${intent.freeCash.toFixed(2)}`);
    if (value > intent.freeCash * r.maxOrderFraction) {
      reasons.push(
        `order is ${((value / intent.freeCash) * 100).toFixed(1)}% of free cash, cap is ${(r.maxOrderFraction * 100).toFixed(1)}%`,
      );
    }
  } else if (intent.quantity > intent.heldQuantity) {
    reasons.push(`selling ${intent.quantity} but only ${intent.heldQuantity} held`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = readLedger().filter((e) => e.at.startsWith(today) && e.env === config.t212.env).length;
  if (todayCount >= r.maxOrdersPerDay) reasons.push(`already submitted ${todayCount} orders today, cap is ${r.maxOrdersPerDay}`);

  return { ok: reasons.length === 0, reasons, estimatedValue: value };
}
