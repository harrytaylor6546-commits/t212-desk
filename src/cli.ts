import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.js";
import { T212Client, T212Error } from "./t212/client.js";
import { gather, renderDossier } from "./research/index.js";
import { analyse } from "./agents/analyst.js";
import { checkRisk, recordSubmitted } from "./risk.js";
import { toAccountCurrency } from "./fx.js";
import { listProposals, loadProposal, newId, saveProposal, type StoredProposal } from "./proposals.js";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function banner(): void {
  const env = config.t212.env.toUpperCase();
  const tag = env === "LIVE" ? "LIVE  (real money)" : "PRACTICE  (fake money)";
  console.log(`t212-desk  |  ${tag}\n`);
}

function money(n: number | undefined, ccy = ""): string {
  return n === undefined ? "n/a" : `${n.toFixed(2)} ${ccy}`.trim();
}

async function accountContext(client: T212Client, ticker: string) {
  const [cash, info, portfolio] = await Promise.all([client.cash(), client.info(), client.portfolio()]);
  const held = portfolio.find((p) => p.ticker === ticker);
  return { freeCash: cash.free, currency: info.currencyCode, heldQuantity: held?.quantity ?? 0, lastPrice: held?.currentPrice };
}

async function resolveTicker(client: T212Client, input: string): Promise<{ ticker: string; name: string }> {
  const exact = await client.instrument(input);
  if (exact) return { ticker: exact.ticker, name: exact.name };
  const matches = await client.findInstruments(input);
  if (matches.length === 1) return { ticker: matches[0].ticker, name: matches[0].name };
  if (matches.length === 0) throw new Error(`no Trading 212 instrument matches "${input}"`);
  console.log(`"${input}" is ambiguous. Use one of these exact tickers:`);
  for (const m of matches) console.log(`  ${m.ticker.padEnd(18)} ${m.name} (${m.currencyCode})`);
  process.exit(1);
}

function printProposal(p: StoredProposal): void {
  const x = p.proposal;
  console.log(`\n[${p.id}]  ${x.action}  ${x.ticker}  confidence ${(x.confidence * 100).toFixed(0)}%  data ${x.dataQuality}  status ${p.status}`);
  console.log(`  thesis: ${x.thesis}`);
  console.log(`  evidence:`);
  for (const e of x.evidence) console.log(`    - (${e.weight}) ${e.claim}  <${e.source}>`);
  console.log(`  risks: ${x.risks.join(" | ")}`);
  console.log(`  invalidation: ${x.invalidation}`);
  console.log(`  sizing: ${(x.suggestedSizeFraction * 100).toFixed(1)}% of free cash (${money(p.context.freeCash, p.context.currency)})`);
  console.log(`  order: ${x.orderType}${x.limitPrice ? ` @ ${x.limitPrice}` : ""}`);
  if (p.orderId) console.log(`  broker order id: ${p.orderId}`);
  if (p.note) console.log(`  note: ${p.note}`);
}

async function confirm(question: string, expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question}\nType "${expected}" to proceed, anything else to abort: `)).trim();
    return answer === expected;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  banner();
  const client = new T212Client();

  switch (cmd) {
    case "account": {
      const [cash, info] = await Promise.all([client.cash(), client.info()]);
      console.log(`account ${info.id}  currency ${info.currencyCode}`);
      console.log(`free ${money(cash.free)}  invested ${money(cash.invested)}  total ${money(cash.total)}  open P/L ${money(cash.ppl)}  realised ${money(cash.result)}`);
      return;
    }

    case "portfolio": {
      const positions = await client.portfolio();
      if (!positions.length) return console.log("no open positions");
      for (const p of positions) {
        console.log(`${p.ticker.padEnd(18)} qty ${String(p.quantity).padEnd(10)} avg ${money(p.averagePrice).padEnd(10)} now ${money(p.currentPrice).padEnd(10)} P/L ${money(p.ppl)}`);
      }
      return;
    }

    case "find": {
      const q = args.slice(1).join(" ");
      if (!q) throw new Error("usage: desk find <name or ticker>");
      const matches = await client.findInstruments(q);
      if (!matches.length) return console.log("no matches");
      for (const m of matches) console.log(`${m.ticker.padEnd(18)} ${m.name}  (${m.currencyCode}, ${m.type})`);
      return;
    }

    case "research": {
      if (!args[1]) throw new Error("usage: desk research <TICKER>");
      const { ticker, name } = await resolveTicker(client, args[1]);
      const dossier = await gather(ticker, name);
      console.log(renderDossier(dossier));
      return;
    }

    case "propose": {
      if (!args[1]) throw new Error("usage: desk propose <TICKER>");
      const { ticker, name } = await resolveTicker(client, args[1]);
      console.log(`gathering research for ${name} (${ticker})...`);
      const [dossier, context] = await Promise.all([gather(ticker, name), accountContext(client, ticker)]);
      console.log(`${dossier.items.length} items from ${new Set(dossier.items.map((i) => i.source)).size} sources${dossier.errors.length ? `, ${dossier.errors.length} source errors` : ""}`);
      if (!context.lastPrice && dossier.price?.last) context.lastPrice = dossier.price.last;
      const instrument = await client.instrument(ticker);
      console.log("asking the analyst...");
      const proposal = await analyse(dossier, context);
      const stored: StoredProposal = {
        id: newId(ticker),
        createdAt: new Date().toISOString(),
        env: config.t212.env,
        proposal,
        context: { ...context, priceCurrency: instrument?.currencyCode ?? dossier.price?.currency },
        status: "pending",
      };
      saveProposal(stored);
      printProposal(stored);
      if (proposal.action !== "NO_TRADE") console.log(`\nTo act on this: npm run desk -- approve ${stored.id} [--qty N]`);
      return;
    }

    case "proposals": {
      const all = listProposals();
      if (!all.length) return console.log("no proposals yet");
      for (const p of all.slice(0, 20)) {
        console.log(`${p.id.padEnd(30)} ${p.proposal.action.padEnd(9)} ${p.proposal.ticker.padEnd(16)} ${(p.proposal.confidence * 100).toFixed(0).padStart(3)}%  ${p.status}  (${p.env})`);
      }
      return;
    }

    case "reject": {
      const p = loadProposal(args[1] ?? "");
      p.status = "rejected";
      p.note = flag("note");
      saveProposal(p);
      return console.log(`rejected ${p.id}`);
    }

    case "approve": {
      const p = loadProposal(args[1] ?? "");
      if (p.status !== "pending") throw new Error(`proposal ${p.id} is ${p.status}, not pending`);
      if (p.env !== config.t212.env) throw new Error(`proposal was made against ${p.env}, current env is ${config.t212.env}`);
      const x = p.proposal;
      if (x.action === "NO_TRADE") throw new Error("analyst proposed NO_TRADE, nothing to approve");

      const [context, instrument] = await Promise.all([accountContext(client, x.ticker), client.instrument(x.ticker)]);
      const quotedPrice = x.limitPrice ?? context.lastPrice ?? p.context.lastPrice;
      if (!quotedPrice) throw new Error("no price available to size the order; pass --qty explicitly");
      // T212 quotes in the instrument's currency (GBX for London). Size and risk-check in the account currency.
      const quotedIn = instrument?.currencyCode ?? p.context.priceCurrency;
      const price = await toAccountCurrency(quotedPrice, quotedIn, context.currency);
      const qtyFlag = flag("qty");
      const quantity = qtyFlag ? Number(qtyFlag) : Number(((x.suggestedSizeFraction * context.freeCash) / price).toFixed(2));

      const verdict = checkRisk({
        ticker: x.ticker,
        side: x.action,
        quantity,
        estimatedPrice: price,
        freeCash: context.freeCash,
        heldQuantity: context.heldQuantity,
      });

      printProposal(p);
      console.log(`\nintent: ${x.action} ${quantity} x ${x.ticker} at ${quotedPrice} ${quotedIn ?? ""} (~${money(price, context.currency)} each) = ~${money(verdict.estimatedValue, context.currency)}`);
      if (!verdict.ok) {
        console.log("risk gate BLOCKED this order:");
        for (const r of verdict.reasons) console.log(`  - ${r}`);
        process.exit(2);
      }
      console.log("risk gate: ok");

      const expected = config.t212.env === "live" ? `LIVE ${x.ticker}` : x.ticker;
      const go = await confirm(`\nSubmit this ${config.t212.env.toUpperCase()} order to Trading 212?`, expected);
      if (!go) return console.log("aborted, proposal left pending");

      // Trading 212 has no side field: positive quantity buys, negative sells.
      const signedQty = x.action === "SELL" ? -Math.abs(quantity) : Math.abs(quantity);
      try {
        const order =
          x.orderType === "LIMIT" && x.limitPrice && config.t212.env === "practice"
            ? await client.placeLimit({ ticker: x.ticker, quantity: signedQty, limitPrice: x.limitPrice, timeValidity: "DAY" })
            : await client.placeMarket({ ticker: x.ticker, quantity: signedQty });
        recordSubmitted({ ticker: x.ticker, side: x.action, quantity, env: config.t212.env });
        p.status = "submitted";
        p.orderId = order.id;
        saveProposal(p);
        console.log(`submitted. broker order ${order.id} status ${order.status}`);
      } catch (e) {
        p.status = "failed";
        p.note = (e as Error).message;
        saveProposal(p);
        throw e;
      }
      return;
    }

    case "orders": {
      const orders = await client.orders();
      if (!orders.length) return console.log("no open orders");
      for (const o of orders) {
        console.log(`${String(o.id).padEnd(12)} ${o.ticker.padEnd(16)} ${o.type.padEnd(11)} qty ${String(o.quantity ?? o.value).padEnd(10)} ${o.limitPrice ? `limit ${o.limitPrice} ` : ""}${o.status}`);
      }
      return;
    }

    case "cancel": {
      const id = Number(args[1]);
      if (!id) throw new Error("usage: desk cancel <orderId>");
      await client.cancel(id);
      return console.log(`cancelled ${id}`);
    }

    default:
      console.log(`usage: npm run desk -- <command>

  account                 cash and account currency
  portfolio               open positions
  find <query>            search Trading 212 instruments (name, ticker, ISIN)
  research <TICKER>       gather news, social and price context, print it
  propose <TICKER>        research + analyst proposal, saved for review
  proposals               list saved proposals
  approve <id> [--qty N]  risk-check, confirm, then submit the order yourself
  reject <id> [--note s]  mark a proposal rejected
  orders                  open orders at the broker
  cancel <orderId>        cancel an open order

Environment is set by T212_ENV in .env (practice by default).`);
  }
}

main().catch((e) => {
  if (e instanceof T212Error) {
    console.error(e.message);
    if (e.status === 401 || e.status === 403) console.error("Check T212_API_KEY / T212_API_SECRET and that the key was generated in the same environment as T212_ENV.");
    if (e.status === 429) console.error("Rate limited by Trading 212. Wait a minute and retry.");
  } else {
    console.error((e as Error).message);
  }
  process.exit(1);
});
