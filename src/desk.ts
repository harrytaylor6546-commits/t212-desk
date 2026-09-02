/**
 * The desk: every operation the CLI and the Telegram bot can perform, as plain functions
 * that return text. Anything that sends an order to the broker is split into a plan step
 * and an execute step, so the caller can put a human confirmation in between.
 */
import { config } from "./config";
import { T212Client } from "./t212/client";
import { gather, renderDossier } from "./research/index";
import { analyse } from "./agents/analyst";
import { checkRisk, recordSubmitted } from "./risk";
import { toAccountCurrency } from "./fx";
import { addOpenTrade, checkExit, listOpenTrades, MAX_HOLD_DAYS, removeOpenTrade } from "./trades";
import { listProposals, loadProposal, newId, saveProposal, type StoredProposal } from "./proposals";

const client = new T212Client();

export function envLabel(): string {
  return config.t212.env === "live" ? "LIVE (real money)" : "PRACTICE (fake money)";
}

export function confirmationPhrase(ticker: string): string {
  return config.t212.env === "live" ? `LIVE ${ticker}` : ticker;
}

function money(n: number | undefined, ccy = ""): string {
  return n === undefined ? "n/a" : `${n.toFixed(2)} ${ccy}`.trim();
}

async function accountContext(ticker: string) {
  const [cash, info, portfolio] = await Promise.all([client.cash(), client.info(), client.portfolio()]);
  const held = portfolio.find((p) => p.ticker === ticker);
  return { freeCash: cash.free, currency: info.currencyCode, heldQuantity: held?.quantity ?? 0, lastPrice: held?.currentPrice };
}

// ---------- read-only ----------

export async function accountText(): Promise<string> {
  const [cash, info] = await Promise.all([client.cash(), client.info()]);
  return [
    `account ${info.id}  currency ${info.currencyCode}  [${envLabel()}]`,
    `free ${money(cash.free)}  invested ${money(cash.invested)}  total ${money(cash.total)}`,
    `open P/L ${money(cash.ppl)}  realised ${money(cash.result)}`,
  ].join("\n");
}

export async function portfolioText(): Promise<string> {
  const positions = await client.portfolio();
  if (!positions.length) return "no open positions";
  return positions
    .map((p) => `${p.ticker}  qty ${p.quantity}  avg ${money(p.averagePrice)}  now ${money(p.currentPrice)}  P/L ${money(p.ppl)}`)
    .join("\n");
}

export async function findText(query: string): Promise<string> {
  const matches = await client.findInstruments(query);
  if (!matches.length) return "no matches";
  return matches.map((m) => `${m.ticker}  ${m.name}  (${m.currencyCode}, ${m.type})`).join("\n");
}

export async function resolveTicker(input: string): Promise<{ ticker: string; name: string }> {
  const exact = await client.instrument(input);
  if (exact) return { ticker: exact.ticker, name: exact.name };
  const matches = await client.findInstruments(input);
  if (matches.length === 1) return { ticker: matches[0].ticker, name: matches[0].name };
  if (matches.length === 0) throw new Error(`no Trading 212 instrument matches "${input}"`);
  throw new Error(
    `"${input}" is ambiguous. Use one of:\n` + matches.slice(0, 10).map((m) => `${m.ticker}  ${m.name}`).join("\n"),
  );
}

export async function researchText(input: string): Promise<string> {
  const { ticker, name } = await resolveTicker(input);
  return renderDossier(await gather(ticker, name));
}

export async function ordersText(): Promise<string> {
  const orders = await client.orders();
  if (!orders.length) return "no open orders";
  return orders
    .map((o) => `${o.id}  ${o.ticker}  ${o.type}  qty ${o.quantity ?? o.value}  ${o.limitPrice ? `limit ${o.limitPrice}  ` : ""}${o.status}`)
    .join("\n");
}

export async function cancelOrder(id: number): Promise<string> {
  await client.cancel(id);
  return `cancelled order ${id}`;
}

// ---------- proposals ----------

export function formatProposal(p: StoredProposal): string {
  const x = p.proposal;
  const lines = [
    `[${p.id}]  ${x.action}  ${x.ticker}  confidence ${(x.confidence * 100).toFixed(0)}%  data ${x.dataQuality}  status ${p.status}`,
    `thesis: ${x.thesis}`,
    `catalyst: ${x.catalyst}`,
    `evidence:`,
    ...x.evidence.map((e) => `  - (${e.weight}) ${e.claim}  ${e.source}`),
    `risks: ${x.risks.join(" | ")}`,
    `invalidation: ${x.invalidation}`,
    `horizon ${x.horizonDays} day(s)  target ${x.targetPrice ?? "n/a"}  stop ${x.stopPrice ?? "n/a"}  (${p.context.priceCurrency ?? "quoted ccy"})`,
    `sizing: ${(x.suggestedSizeFraction * 100).toFixed(1)}% of free cash (${money(p.context.freeCash, p.context.currency)})`,
    `order: ${x.orderType}${x.limitPrice ? ` @ ${x.limitPrice}` : ""}`,
  ];
  if (p.orderId) lines.push(`broker order id: ${p.orderId}`);
  if (p.note) lines.push(`note: ${p.note}`);
  return lines.join("\n");
}

export async function propose(input: string): Promise<{ stored: StoredProposal; text: string }> {
  const { ticker, name } = await resolveTicker(input);
  const [dossier, context, instrument] = await Promise.all([gather(ticker, name), accountContext(ticker), client.instrument(ticker)]);
  if (!context.lastPrice && dossier.price?.last) context.lastPrice = dossier.price.last;
  const proposal = await analyse(dossier, context);
  const stored: StoredProposal = {
    id: newId(ticker),
    createdAt: new Date().toISOString(),
    env: config.t212.env,
    proposal,
    context: { ...context, priceCurrency: instrument?.currencyCode ?? dossier.price?.currency },
    status: "pending",
  };
  await saveProposal(stored);
  const summary = `${dossier.items.length} items from ${new Set(dossier.items.map((i) => i.source)).size} sources${dossier.errors.length ? `, ${dossier.errors.length} source errors` : ""}`;
  let text = `${summary}\n\n${formatProposal(stored)}`;
  if (proposal.action !== "NO_TRADE") text += `\n\nTo act on this: approve ${stored.id}`;
  return { stored, text };
}

export async function proposalsText(): Promise<string> {
  const all = await listProposals();
  if (!all.length) return "no proposals yet";
  return all
    .slice(0, 15)
    .map((p) => `${p.id}  ${p.proposal.action}  ${p.proposal.ticker}  ${(p.proposal.confidence * 100).toFixed(0)}%  ${p.status}`)
    .join("\n");
}

export async function proposalText(id: string): Promise<string> {
  return formatProposal(await loadProposal(id));
}

export async function rejectProposal(id: string, note?: string): Promise<string> {
  const p = await loadProposal(id);
  p.status = "rejected";
  if (note) p.note = note;
  await saveProposal(p);
  return `rejected ${p.id}`;
}

// ---------- approve (plan, then execute) ----------

export interface ApprovePlan {
  proposalId: string;
  ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  quotedPrice: number;
  quotedIn?: string;
  priceInAccount: number;
  estimatedValue: number;
  currency: string;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  horizonDays: number;
  expected: string;
}

export async function planApprove(id: string, qtyOverride?: number): Promise<{ plan: ApprovePlan; text: string; blocked: string[] }> {
  const p = await loadProposal(id);
  if (p.status !== "pending") throw new Error(`proposal ${p.id} is ${p.status}, not pending`);
  if (p.env !== config.t212.env) throw new Error(`proposal was made against ${p.env}, current env is ${config.t212.env}`);
  const x = p.proposal;
  if (x.action === "NO_TRADE") throw new Error("analyst proposed NO_TRADE, nothing to approve");

  const [context, instrument] = await Promise.all([accountContext(x.ticker), client.instrument(x.ticker)]);
  const quotedPrice = x.limitPrice ?? context.lastPrice ?? p.context.lastPrice;
  if (!quotedPrice) throw new Error("no price available to size the order; pass a quantity explicitly");
  const quotedIn = instrument?.currencyCode ?? p.context.priceCurrency;
  const priceInAccount = await toAccountCurrency(quotedPrice, quotedIn, context.currency);
  const quantity = qtyOverride ?? Number(((x.suggestedSizeFraction * context.freeCash) / priceInAccount).toFixed(2));

  const verdict = await checkRisk({
    ticker: x.ticker,
    side: x.action,
    quantity,
    estimatedPrice: priceInAccount,
    freeCash: context.freeCash,
    heldQuantity: context.heldQuantity,
  });

  const plan: ApprovePlan = {
    proposalId: p.id,
    ticker: x.ticker,
    side: x.action,
    quantity,
    quotedPrice,
    quotedIn,
    priceInAccount,
    estimatedValue: verdict.estimatedValue,
    currency: context.currency,
    orderType: x.orderType,
    limitPrice: x.limitPrice,
    targetPrice: x.targetPrice,
    stopPrice: x.stopPrice,
    horizonDays: x.horizonDays,
    expected: confirmationPhrase(x.ticker),
  };

  const lines = [
    formatProposal(p),
    "",
    `intent: ${plan.side} ${plan.quantity} x ${plan.ticker} at ${plan.quotedPrice} ${plan.quotedIn ?? ""} (~${money(plan.priceInAccount, plan.currency)} each) = ~${money(plan.estimatedValue, plan.currency)}`,
  ];
  if (verdict.ok) lines.push("risk gate: ok");
  else lines.push("risk gate BLOCKED this order:", ...verdict.reasons.map((r) => `  - ${r}`));
  return { plan, text: lines.join("\n"), blocked: verdict.ok ? [] : verdict.reasons };
}

export async function executeApprove(plan: ApprovePlan): Promise<string> {
  const p = await loadProposal(plan.proposalId);
  if (p.status !== "pending") throw new Error(`proposal ${p.id} is ${p.status}, not pending`);
  // Trading 212 has no side field: positive quantity buys, negative sells.
  const signedQty = plan.side === "SELL" ? -Math.abs(plan.quantity) : Math.abs(plan.quantity);
  try {
    const order =
      plan.orderType === "LIMIT" && plan.limitPrice && config.t212.env === "practice"
        ? await client.placeLimit({ ticker: plan.ticker, quantity: signedQty, limitPrice: plan.limitPrice, timeValidity: "DAY" })
        : await client.placeMarket({ ticker: plan.ticker, quantity: signedQty });
    await recordSubmitted({ ticker: plan.ticker, side: plan.side, quantity: plan.quantity, env: config.t212.env });
    p.status = "submitted";
    p.orderId = order.id;
    await saveProposal(p);
    if (plan.side === "BUY") {
      await addOpenTrade({
        ticker: plan.ticker,
        proposalId: p.id,
        env: config.t212.env,
        side: "LONG",
        quantity: plan.quantity,
        openedAt: new Date().toISOString(),
        entryPrice: plan.quotedPrice,
        quotedIn: plan.quotedIn,
        targetPrice: plan.targetPrice,
        stopPrice: plan.stopPrice,
        horizonDays: plan.horizonDays,
        maxHoldDays: MAX_HOLD_DAYS,
      });
    } else {
      await removeOpenTrade(plan.ticker);
    }
    let text = `submitted. broker order ${order.id} status ${order.status}`;
    if (plan.side === "BUY") text += `\nclock started: close within ${MAX_HOLD_DAYS} trading days. The daily review will nudge you.`;
    return text;
  } catch (e) {
    p.status = "failed";
    p.note = (e as Error).message;
    await saveProposal(p);
    throw e;
  }
}

// ---------- review / close ----------

export async function reviewText(): Promise<{ text: string; exits: number; urgent: number }> {
  const [trades, positions] = await Promise.all([listOpenTrades(), client.portfolio()]);
  if (!trades.length) {
    const untracked = positions.filter((pos) => pos.quantity > 0);
    let text = "no open trades tracked by the desk";
    if (untracked.length) text += `\nnote: broker shows ${untracked.length} position(s) the desk did not open: ${untracked.map((u) => u.ticker).join(", ")}`;
    return { text, exits: 0, urgent: 0 };
  }
  let exits = 0;
  let urgent = 0;
  const lines: string[] = [];
  for (const t of trades) {
    const pos = positions.find((pp) => pp.ticker === t.ticker);
    const check = checkExit(t, pos?.currentPrice);
    const pnl = pos ? `P/L ${money(pos.ppl)}` : "not in broker portfolio";
    const flag = check.urgent ? "EXIT NOW" : check.shouldExit ? "EXIT" : `hold (${check.daysLeft} day(s) left)`;
    lines.push(`${t.ticker}  day ${check.daysHeld}/${t.maxHoldDays}  entry ${t.entryPrice}  now ${pos?.currentPrice ?? "n/a"}  target ${t.targetPrice ?? "-"}  stop ${t.stopPrice ?? "-"}  ${pnl}  => ${flag}`);
    for (const r of check.reasons) lines.push(`  - ${r}`);
    if (check.shouldExit) exits += 1;
    if (check.urgent) urgent += 1;
    if (!pos) lines.push(`  - broker no longer shows this position. If you sold it in the app: untrack ${t.ticker}`);
  }
  if (exits) lines.push("", `${exits} trade(s) need closing: close <TICKER>`);
  return { text: lines.join("\n"), exits, urgent };
}

export interface ClosePlan {
  ticker: string;
  quantity: number;
  quotedPrice: number | undefined;
  expected: string;
}

export async function planClose(ticker: string, qtyOverride?: number): Promise<{ plan: ClosePlan; text: string; blocked: string[] }> {
  const [trade, context] = await Promise.all([listOpenTrades().then((all) => all.find((t) => t.ticker === ticker)), accountContext(ticker)]);
  if (context.heldQuantity <= 0) throw new Error(`broker shows no position in ${ticker}`);
  const quantity = qtyOverride ?? Math.min(trade?.quantity ?? context.heldQuantity, context.heldQuantity);
  const price = context.lastPrice ?? 0;
  const verdict = await checkRisk({ ticker, side: "SELL", quantity, estimatedPrice: price, freeCash: context.freeCash, heldQuantity: context.heldQuantity });
  const lines: string[] = [];
  if (trade) {
    const check = checkExit(trade, context.lastPrice);
    lines.push(`tracked trade: day ${check.daysHeld}/${trade.maxHoldDays}, entry ${trade.entryPrice}, now ${context.lastPrice ?? "n/a"}`);
    for (const r of check.reasons) lines.push(`  - ${r}`);
  } else {
    lines.push(`note: ${ticker} was not opened by the desk. Closing it anyway if you confirm.`);
  }
  lines.push(`intent: SELL ${quantity} x ${ticker} at market (last ${money(price)} quoted)`);
  if (verdict.ok) lines.push("risk gate: ok");
  else lines.push("risk gate BLOCKED this order:", ...verdict.reasons.map((r) => `  - ${r}`));
  return {
    plan: { ticker, quantity, quotedPrice: context.lastPrice, expected: confirmationPhrase(ticker) },
    text: lines.join("\n"),
    blocked: verdict.ok ? [] : verdict.reasons,
  };
}

export async function executeClose(plan: ClosePlan): Promise<string> {
  const order = await client.placeMarket({ ticker: plan.ticker, quantity: -Math.abs(plan.quantity) });
  await recordSubmitted({ ticker: plan.ticker, side: "SELL", quantity: plan.quantity, env: config.t212.env });
  await removeOpenTrade(plan.ticker);
  return `submitted. broker order ${order.id} status ${order.status}`;
}

export async function untrack(ticker: string): Promise<string> {
  const removed = await removeOpenTrade(ticker);
  return removed ? `stopped tracking ${ticker}` : `${ticker} was not tracked`;
}
