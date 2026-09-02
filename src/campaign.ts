import { store } from "./store";
import { config } from "./config";

/**
 * A campaign is a pot of money and a set of exit rules the desk runs on your behalf:
 * recommend one trade at a time, you reply APPROVE, it closes on take-profit, stop-loss
 * or the three-day limit, then looks for the next one. It ends when the goal is hit,
 * the week is up, or you stop it.
 */
export interface Campaign {
  status: "active" | "stopped" | "completed";
  env: string;
  budget: number; // account currency
  startedAt: string;
  endsAt: string;
  takeProfitPct: number;
  stopLossPct: number;
  goalPct: number;
  maxOpen: number;
  autoClose: boolean;
  realisedPnl: number;
  closedTrades: number;
  wins: number;
  lastScanAt?: string;
  lastRecommendedAt?: string;
  note?: string;
}

export const DEFAULTS = {
  takeProfitPct: 5,
  stopLossPct: 4,
  goalPct: 30,
  days: 7,
  maxOpen: 1,
};

const KEY = "campaign";

export async function getCampaign(): Promise<Campaign | null> {
  const c = await store.get<Campaign>(KEY);
  return c && c.env === config.t212.env ? c : null;
}

export async function saveCampaign(c: Campaign | null): Promise<void> {
  await store.set(KEY, c);
}

/** Parse "200 tp=5 sl=4 goal=30 days=7 open=2" style arguments. */
export function parseCampaignArgs(args: string[]): { budget: number; opts: Partial<Campaign> & { days?: number } } {
  const budget = Number(args[0]);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("usage: /campaign start <budget> [tp=5] [sl=4] [goal=30] [days=7] [open=1]");
  const opts: Partial<Campaign> & { days?: number } = {};
  for (const a of args.slice(1)) {
    const [k, v] = a.split("=");
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`bad setting "${a}"`);
    switch (k.toLowerCase()) {
      case "tp": opts.takeProfitPct = n; break;
      case "sl": opts.stopLossPct = n; break;
      case "goal": opts.goalPct = n; break;
      case "days": opts.days = n; break;
      case "open": opts.maxOpen = Math.max(1, Math.floor(n)); break;
      default: throw new Error(`unknown setting "${k}". Use tp, sl, goal, days, open.`);
    }
  }
  return { budget, opts };
}

export function newCampaign(budget: number, opts: Partial<Campaign> & { days?: number }): Campaign {
  const days = opts.days ?? DEFAULTS.days;
  const now = new Date();
  return {
    status: "active",
    env: config.t212.env,
    budget,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString(),
    takeProfitPct: opts.takeProfitPct ?? DEFAULTS.takeProfitPct,
    stopLossPct: opts.stopLossPct ?? DEFAULTS.stopLossPct,
    goalPct: opts.goalPct ?? DEFAULTS.goalPct,
    maxOpen: opts.maxOpen ?? DEFAULTS.maxOpen,
    autoClose: (process.env.AUTO_CLOSE ?? "true").toLowerCase() !== "false",
    realisedPnl: 0,
    closedTrades: 0,
    wins: 0,
  };
}

export function campaignText(c: Campaign, extra: { openCost: number; unrealised: number; openCount: number }): string {
  const total = c.realisedPnl + extra.unrealised;
  const pct = (total / c.budget) * 100;
  const daysLeft = Math.max(0, Math.ceil((new Date(c.endsAt).getTime() - Date.now()) / (24 * 3600 * 1000)));
  const lines = [
    `campaign ${c.status}  |  budget ${c.budget.toFixed(2)}  |  ${daysLeft} day(s) left`,
    `rules: take profit +${c.takeProfitPct}%  stop -${c.stopLossPct}%  goal +${c.goalPct}%  max ${c.maxOpen} open  3-day limit  auto-close ${c.autoClose ? "on" : "off"}`,
    `progress: ${total >= 0 ? "+" : ""}${total.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% of budget, goal +${c.goalPct}%)`,
    `realised ${c.realisedPnl >= 0 ? "+" : ""}${c.realisedPnl.toFixed(2)} over ${c.closedTrades} closed (${c.wins} wins)  |  unrealised ${extra.unrealised >= 0 ? "+" : ""}${extra.unrealised.toFixed(2)} on ${extra.openCount} open`,
    `deployed ${extra.openCost.toFixed(2)}  free to invest ${Math.max(0, c.budget + c.realisedPnl - extra.openCost).toFixed(2)}`,
  ];
  if (c.lastScanAt) lines.push(`last scan ${c.lastScanAt.slice(0, 16).replace("T", " ")} UTC`);
  if (c.note) lines.push(`note: ${c.note}`);
  return lines.join("\n");
}
