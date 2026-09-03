/**
 * Campaign autopilot. Runs on every tick (external scheduler every 15 minutes in market
 * hours, or the daily Vercel cron as a fallback):
 *   1. exits: take-profit, stop-loss, three-day limit, goal reached
 *   2. recommend the next trade when there is a free slot, and wait for APPROVE
 * Entries always need a human. Exits are automatic only if auto-close is on.
 */
import { config } from "./config";
import * as desk from "./desk";
import { campaignText, getCampaign, saveCampaign, type Campaign } from "./campaign";
import { checkExit, listOpenTrades, type OpenTrade } from "./trades";
import { getWatchlist, prescreen } from "./scanner";
import { store } from "./store";
import { sendMessage } from "./telegram";
import { loadProposal, saveProposal } from "./proposals";
import type { Position } from "./t212/types";
import { gather } from "./research/index";
import { triage } from "./agents/triage";
import { mapLimit } from "./util";

export interface PendingRecommendation {
  proposalId: string;
  ticker: string;
  quantity: number;
  estimatedValue: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  expected: string;
}

export const REC_KEY = "pending-recommendation";
const REC_TTL_MS = 4 * 3600 * 1000;
const SCAN_INTERVAL_MIN = Number(process.env.CAMPAIGN_SCAN_MIN_INTERVAL_MIN ?? 120);
const TRIAGE_TOP = Number(process.env.CAMPAIGN_TRIAGE_TOP ?? 12);
const ANALYSE_TOP = Number(process.env.CAMPAIGN_ANALYSE_TOP ?? 5);
const MIN_CONFIDENCE = Number(process.env.CAMPAIGN_MIN_CONFIDENCE ?? 0.55);
const MIN_CATALYST = Number(process.env.CAMPAIGN_MIN_CATALYST ?? 4);

async function notify(text: string): Promise<void> {
  if (config.telegram.chatId) await sendMessage(config.telegram.chatId, text);
}

function marketHours(now = new Date()): boolean {
  const dow = now.getUTCDay();
  const h = now.getUTCHours();
  return dow >= 1 && dow <= 5 && h >= 7 && h <= 20;
}

function pnlPct(trade: OpenTrade, pos: Position | undefined): number | undefined {
  if (!pos) return undefined;
  if (trade.cost && trade.cost > 0) return (pos.ppl / trade.cost) * 100;
  if (trade.entryPrice > 0) return ((pos.currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
  return undefined;
}

export async function getPendingRecommendation(): Promise<PendingRecommendation | null> {
  const rec = await store.get<PendingRecommendation>(REC_KEY);
  if (!rec) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) {
    await store.set(REC_KEY, null);
    return null;
  }
  return rec;
}

export function approvalPhrase(): string {
  return config.t212.env === "live" ? "APPROVE LIVE" : "APPROVE";
}

/** Main entry. Returns a log of what happened, for the cron response. */
export async function tick(opts: { force?: boolean } = {}): Promise<string[]> {
  const log: string[] = [];
  const c = await getCampaign();
  const [trades, positions] = await Promise.all([listOpenTrades(), desk.positions()]);

  // ---- 1. exits ----
  const autoClose = c ? c.autoClose : (process.env.AUTO_CLOSE ?? "false").toLowerCase() === "true";
  for (const t of trades) {
    const pos = positions.find((p) => p.ticker === t.ticker);
    const pct = pnlPct(t, pos);
    const timeCheck = checkExit(t, pos?.currentPrice);
    const reasons: string[] = [];
    if (c && t.campaign && pct !== undefined) {
      if (pct >= c.takeProfitPct) reasons.push(`take profit: ${pct.toFixed(2)}% >= +${c.takeProfitPct}%`);
      if (pct <= -c.stopLossPct) reasons.push(`stop loss: ${pct.toFixed(2)}% <= -${c.stopLossPct}%`);
    } else {
      // Non-campaign trades keep the analyst's own levels.
      reasons.push(...timeCheck.reasons.filter((r) => r.startsWith("target") || r.startsWith("stop")));
    }
    if (timeCheck.daysLeft <= 0) reasons.push(timeCheck.reasons.find((r) => r.startsWith("time stop")) ?? "time stop");
    if (!reasons.length) continue;

    if (!pos) {
      log.push(`${t.ticker}: exit due but broker shows no position, untracking`);
      await desk.untrack(t.ticker);
      continue;
    }
    if (autoClose && marketHours()) {
      try {
        const { text } = await desk.closeNow(t.ticker, t.quantity);
        if (c && t.campaign) {
          c.realisedPnl += pos.ppl;
          c.closedTrades += 1;
          if (pos.ppl > 0) c.wins += 1;
          await saveCampaign(c);
        }
        const line = `closed ${t.ticker}  P/L ${pos.ppl >= 0 ? "+" : ""}${pos.ppl.toFixed(2)} (${pct?.toFixed(2) ?? "?"}%)\n${reasons.join("; ")}\n${text}`;
        log.push(line);
        await notify(line);
      } catch (e) {
        const line = `FAILED to close ${t.ticker}: ${(e as Error).message}\nreason: ${reasons.join("; ")}\nClose it yourself: /close ${t.ticker}`;
        log.push(line);
        await notify(line);
      }
    } else {
      const line = `EXIT ${t.ticker}  P/L ${pos.ppl >= 0 ? "+" : ""}${pos.ppl.toFixed(2)} (${pct?.toFixed(2) ?? "?"}%)\n${reasons.join("; ")}\n${autoClose ? "outside market hours, will close at the next tick" : "auto-close is off: /close " + t.ticker}`;
      log.push(line);
      await notify(line);
    }
  }

  if (!c || c.status !== "active") {
    if (!log.length) log.push(c ? `campaign ${c.status}, nothing to do` : "no campaign, nothing to do");
    return log;
  }

  // ---- 2. campaign accounting ----
  const stillOpen = (await listOpenTrades()).filter((t) => t.campaign);
  const livePositions = await desk.positions();
  const unrealised = stillOpen.reduce((s, t) => s + (livePositions.find((p) => p.ticker === t.ticker)?.ppl ?? 0), 0);
  const openCost = stillOpen.reduce((s, t) => s + (t.cost ?? 0), 0);
  const total = c.realisedPnl + unrealised;
  const goalValue = (c.budget * c.goalPct) / 100;

  if (total >= goalValue) {
    let line = `GOAL REACHED: ${total >= 0 ? "+" : ""}${total.toFixed(2)} on a ${c.budget.toFixed(2)} budget (goal +${c.goalPct}%).`;
    if (c.autoClose && marketHours()) {
      for (const t of stillOpen) {
        try {
          const pos = livePositions.find((p) => p.ticker === t.ticker);
          const { text } = await desk.closeNow(t.ticker, t.quantity);
          if (pos) {
            c.realisedPnl += pos.ppl;
            c.closedTrades += 1;
            if (pos.ppl > 0) c.wins += 1;
          }
          line += `\n${text}`;
        } catch (e) {
          line += `\nFAILED to close ${t.ticker}: ${(e as Error).message}. /close ${t.ticker}`;
        }
      }
      c.status = "completed";
      c.note = "goal reached";
    } else {
      line += stillOpen.length ? `\nClose the remaining ${stillOpen.length} trade(s) with /close, then /campaign stop.` : "";
      if (!stillOpen.length) c.status = "completed";
    }
    await saveCampaign(c);
    await store.set(REC_KEY, null);
    log.push(line);
    await notify(line);
    return log;
  }

  const ended = Date.now() >= new Date(c.endsAt).getTime();
  if (ended) {
    if (!stillOpen.length) {
      c.status = "completed";
      c.note = "week finished";
      await saveCampaign(c);
      const line = `campaign finished. ${campaignText(c, { openCost: 0, unrealised: 0, openCount: 0 })}`;
      log.push(line);
      await notify(line);
    } else {
      log.push("campaign past its end date, no new trades; open trades close on their rules");
    }
    return log;
  }

  // ---- 3. recommend the next trade ----
  const freeToInvest = c.budget + c.realisedPnl - openCost;
  const slotFree = stillOpen.length < c.maxOpen;
  const pending = await getPendingRecommendation();
  const scanDue = !c.lastScanAt || Date.now() - new Date(c.lastScanAt).getTime() > SCAN_INTERVAL_MIN * 60 * 1000;
  if (!slotFree) {
    log.push(`${stillOpen.length}/${c.maxOpen} slots in use, not scanning`);
    return log;
  }
  if (freeToInvest < 20) {
    log.push(`only ${freeToInvest.toFixed(2)} free to invest, not scanning`);
    return log;
  }
  if (pending) {
    log.push(`recommendation for ${pending.ticker} still waiting for APPROVE`);
    return log;
  }
  if (!opts.force && (!scanDue || !marketHours())) {
    log.push(scanDue ? "outside market hours" : "scanned recently, waiting");
    return log;
  }

  const perTrade = Math.min(freeToInvest, c.budget / c.maxOpen);
  const rec = await recommend(c, perTrade, stillOpen.map((t) => t.ticker), log);
  c.lastScanAt = new Date().toISOString();
  if (rec) c.lastRecommendedAt = c.lastScanAt;
  await saveCampaign(c);
  return log;
}

async function recommend(c: Campaign, perTrade: number, exclude: string[], log: string[]): Promise<PendingRecommendation | null> {
  // Stage 1+2: cheap pre-screen over the whole universe.
  const watch = (await getWatchlist()).filter((t) => !exclude.includes(t));
  const named = await desk.instrumentsFor(watch);
  const ranked = await prescreen(named);
  const shortlist = ranked.slice(0, TRIAGE_TOP);
  log.push(`pre-screened ${ranked.length} of ${watch.length}. shortlist: ${shortlist.map((t) => `${t.ticker} ${t.score.toFixed(0)}`).join(", ")}`);

  // Stage 3: gather full dossiers for the shortlist and let the cheap model rank catalysts.
  const dossiers = (
    await mapLimit(shortlist, 3, async (cand) => {
      try {
        return await gather(cand.ticker, cand.name);
      } catch (e) {
        log.push(`${cand.ticker}: research failed: ${(e as Error).message}`);
        return null;
      }
    })
  ).filter((d): d is NonNullable<typeof d> => d !== null);

  let ordered = dossiers;
  let triageNote = "";
  try {
    const ranks = await triage(dossiers);
    const byTicker = new Map(dossiers.map((d) => [d.ticker, d]));
    const upward = ranks.filter((r) => r.direction === "up" && r.catalystScore >= MIN_CATALYST);
    ordered = upward.map((r) => byTicker.get(r.ticker)!).filter(Boolean);
    triageNote = ranks.slice(0, 8).map((r) => `${r.ticker} ${r.catalystScore}/10 ${r.direction}`).join(", ");
    log.push(`triage: ${triageNote}`);
  } catch (e) {
    log.push(`triage failed, falling back to pre-screen order: ${(e as Error).message}`);
  }
  const top = ordered.slice(0, ANALYSE_TOP);
  if (!top.length) {
    const line = `scan: ${ranked.length} names screened, ${dossiers.length} researched. Triage found no upward catalyst worth the analyst (${triageNote || "no scores"}). Will look again in ${SCAN_INTERVAL_MIN} min.`;
    log.push(line);
    await notify(line);
    return null;
  }

  // Stage 4: the full analyst on the survivors, a few in parallel.
  const rules = `take profit at +${c.takeProfitPct}%, stop loss at -${c.stopLossPct}%, position size about ${perTrade.toFixed(0)} in account currency, must close within 3 trading days`;
  const results: { id: string; ticker: string; confidence: number; action: string; quality: string }[] = [];
  await mapLimit(top, 3, async (dossier) => {
    try {
      const { stored } = await desk.proposeFromDossier(dossier, { rules });
      results.push({ id: stored.id, ticker: stored.proposal.ticker, confidence: stored.proposal.confidence, action: stored.proposal.action, quality: stored.proposal.dataQuality });
    } catch (e) {
      log.push(`${dossier.ticker}: analyst failed: ${(e as Error).message}`);
    }
  });
  const best = results
    .filter((r) => r.action === "BUY" && r.quality !== "poor" && r.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)[0];

  const summary = results.map((r) => `${r.ticker} ${r.action} ${(r.confidence * 100).toFixed(0)}%`).join(", ");
  if (!best) {
    const line = `scan: ${ranked.length} screened, ${dossiers.length} researched, ${results.length} analysed: ${summary || "no results"}.\nNothing met the bar, will look again in ${SCAN_INTERVAL_MIN} min.`;
    log.push(line);
    await notify(line);
    return null;
  }

  // Size the order to the campaign slot, not the analyst's suggestion.
  const probe = await desk.planApprove(best.id);
  const quantity = Number((perTrade / probe.plan.priceInAccount).toFixed(2));
  const { plan, text, blocked } = await desk.planApprove(best.id, quantity);
  if (blocked.length) {
    const line = `recommendation ${best.ticker} blocked by the risk gate:\n${blocked.map((b) => "  - " + b).join("\n")}\nRaise RISK_MAX_ORDER_VALUE or lower the campaign budget.`;
    log.push(line);
    await notify(line);
    return null;
  }
  const rec: PendingRecommendation = {
    proposalId: best.id,
    ticker: best.ticker,
    quantity,
    estimatedValue: plan.estimatedValue,
    currency: plan.currency,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + REC_TTL_MS).toISOString(),
    expected: approvalPhrase(),
  };
  await store.set(REC_KEY, rec);
  const line = `RECOMMENDATION (${ranked.length} screened, ${dossiers.length} researched, analysed: ${summary})\n\n${text}\n\nReply ${rec.expected} to buy ~${plan.estimatedValue.toFixed(2)} ${plan.currency} of ${best.ticker}.\nReply /skip to pass. Expires in 4 hours.`;
  log.push(`recommended ${best.ticker}`);
  await notify(line);
  return rec;
}

export async function approveRecommendation(): Promise<string> {
  const rec = await getPendingRecommendation();
  if (!rec) return "no recommendation waiting. Send /next to scan now.";
  const { plan, text, blocked } = await desk.planApprove(rec.proposalId, rec.quantity);
  if (blocked.length) return text;
  await store.set(REC_KEY, null);
  const result = await desk.executeApprove(plan, { campaign: true });
  return `${result}\nCampaign trade open: ${rec.ticker}. Exits are automatic.`;
}

export async function skipRecommendation(): Promise<string> {
  const rec = await getPendingRecommendation();
  if (!rec) return "nothing to skip";
  await store.set(REC_KEY, null);
  try {
    const p = await loadProposal(rec.proposalId);
    p.status = "rejected";
    p.note = "skipped";
    await saveProposal(p);
  } catch {
    /* ignore */
  }
  return `skipped ${rec.ticker}. Send /next to scan again now, or wait for the next tick.`;
}

export async function statusText(): Promise<string> {
  const c = await getCampaign();
  if (!c) return "no campaign. Start one with: /campaign start 200";
  const [trades, positions] = await Promise.all([listOpenTrades(), desk.positions()]);
  const open = trades.filter((t) => t.campaign);
  const unrealised = open.reduce((s, t) => s + (positions.find((p) => p.ticker === t.ticker)?.ppl ?? 0), 0);
  const openCost = open.reduce((s, t) => s + (t.cost ?? 0), 0);
  let text = campaignText(c, { openCost, unrealised, openCount: open.length });
  const rec = await getPendingRecommendation();
  if (rec) text += `\nwaiting for ${rec.expected}: ${rec.ticker} ~${rec.estimatedValue.toFixed(2)} ${rec.currency}`;
  return text;
}
