/**
 * Telegram command handling. Every message is checked against the one allowed chat id.
 * Orders need a second message that repeats the ticker exactly, same as the CLI.
 */
import { config } from "./config";
import * as desk from "./desk";
import { sendMessage, type TelegramUpdate } from "./telegram";
import { store } from "./store";
import { T212Error } from "./t212/client";
import * as autopilot from "./autopilot";
import { getCampaign, newCampaign, parseCampaignArgs, saveCampaign } from "./campaign";
import { DEFAULT_WATCHLIST, getWatchlist, setWatchlist } from "./scanner";

interface PendingConfirm {
  kind: "approve" | "close";
  plan: desk.ApprovePlan | desk.ClosePlan;
  expected: string;
  expiresAt: string;
}

const PENDING_KEY = "pending-confirm";
const PENDING_TTL_MS = 10 * 60 * 1000;

const HELP = `Campaign (hands-off mode):
/campaign start 200  invest 200 over a week, defaults tp=4 sl=10 goal=100 open=1
   e.g. /campaign start 200 tp=5 sl=4 goal=30 days=7
/campaign  status
/campaign stop  stop recommending (open trades still close on their rules)
/campaign autoclose on|off
/next  scan the watchlist now and recommend a trade
APPROVE  buy the recommended trade (APPROVE LIVE in live mode)
/skip  pass on it
/watch  show the watchlist  |  /watch add <T>  |  /watch remove <T>  |  /watch reset

Manual commands:
/account  balance
/portfolio  open positions
/find <name>  search instruments
/research <TICKER>  news, social and price context
/propose <TICKER>  full analyst proposal (takes a minute)
/proposals  recent proposals
/show <id>  one proposal in full
/approve <id> [qty]  risk-check, then asks you to confirm
/reject <id>  mark it rejected
/review  every open trade against target, stop, 3-day clock
/close <TICKER> [qty]  market-sell, asks you to confirm
/untrack <TICKER>  forget a trade you closed in the app
/orders  open orders at the broker
/cancel <orderId>  cancel an open order
/help  this list

To confirm an order, reply with the exact phrase the bot asks for.
Anything else cancels it.`;

function errorText(e: unknown): string {
  if (e instanceof T212Error) {
    let t = e.message;
    if (e.status === 401 || e.status === 403) t += "\nCheck the T212 key on the server and that it matches T212_ENV.";
    if (e.status === 429) t += "\nRate limited by Trading 212. Wait a minute.";
    return t;
  }
  return (e as Error)?.message ?? String(e);
}

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  // First-run helper: tell the owner their chat id so they can lock the bot to it.
  if (!config.telegram.chatId) {
    await sendMessage(chatId, `Your chat id is ${chatId}. Set TELEGRAM_CHAT_ID to that value on the server and redeploy. Until then the bot ignores commands.`);
    return;
  }
  if (chatId !== config.telegram.chatId) return; // silently ignore strangers

  try {
    const reply = await dispatch(chatId, text);
    if (reply) await sendMessage(chatId, reply);
  } catch (e) {
    await sendMessage(chatId, `error: ${errorText(e)}`);
  }
}

async function dispatch(chatId: string, text: string): Promise<string | undefined> {
  // A pending confirmation swallows the next message, whatever it is.
  const pending = await store.get<PendingConfirm>(PENDING_KEY);
  if (pending) {
    await store.set(PENDING_KEY, null);
    if (new Date(pending.expiresAt).getTime() < Date.now()) return "that confirmation expired. Start again.";
    if (text !== pending.expected) return `not confirmed (expected "${pending.expected}"). Nothing was sent.`;
    return pending.kind === "approve"
      ? desk.executeApprove(pending.plan as desk.ApprovePlan)
      : desk.executeClose(pending.plan as desk.ClosePlan);
  }

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();
  const arg = rest[0];
  const qty = rest[1] ? Number(rest[1]) : undefined;

  // A bare APPROVE (or APPROVE LIVE) accepts the campaign recommendation.
  if (text.toUpperCase() === autopilot.approvalPhrase()) return autopilot.approveRecommendation();
  if (text.toUpperCase() === "APPROVE" && config.t212.env === "live") return "this is a LIVE account. Reply APPROVE LIVE if you mean it.";

  switch (cmd) {
    case "start":
    case "help":
      return `t212-desk  |  ${desk.envLabel()}\n\n${HELP}`;
    case "campaign": {
      const sub = (arg ?? "status").toLowerCase();
      if (sub === "status") return autopilot.statusText();
      if (sub === "start") {
        const existing = await getCampaign();
        if (existing?.status === "active") return `a campaign is already active. /campaign stop first.\n\n${await autopilot.statusText()}`;
        const { budget, opts } = parseCampaignArgs(rest.slice(1));
        const c = newCampaign(budget, opts);
        if (budget > config.risk.maxOrderValue * c.maxOpen) {
          return `budget ${budget} is above what the risk gate allows (RISK_MAX_ORDER_VALUE ${config.risk.maxOrderValue} per trade x ${c.maxOpen} open). Raise that setting in Vercel first, or start with a smaller budget.`;
        }
        await saveCampaign(c);
        await sendMessage(chatId, `campaign started. Scanning the watchlist now, this takes a few minutes.\n\n${await autopilot.statusText()}`);
        const log = await autopilot.tick({ force: true });
        return log.some((l) => l.startsWith("recommended")) ? undefined : log.join("\n");
      }
      if (sub === "stop") {
        const c = await getCampaign();
        if (!c) return "no campaign to stop";
        c.status = "stopped";
        c.note = "stopped by you";
        await saveCampaign(c);
        await store.set(autopilot.REC_KEY, null);
        return `campaign stopped. Open trades still close on their rules. /review to see them.`;
      }
      if (sub === "autoclose") {
        const c = await getCampaign();
        if (!c) return "no campaign";
        c.autoClose = (rest[1] ?? "").toLowerCase() === "on";
        await saveCampaign(c);
        return `auto-close ${c.autoClose ? "on" : "off"}`;
      }
      return "usage: /campaign start <budget> [tp=4 sl=10 goal=100 days=7 open=1] | /campaign status | /campaign stop | /campaign autoclose on|off";
    }
    case "next": {
      const c = await getCampaign();
      if (!c || c.status !== "active") return "no active campaign. /campaign start 200";
      await sendMessage(chatId, "scanning now, a few minutes...");
      const log = await autopilot.tick({ force: true });
      return log.some((l) => l.startsWith("recommended")) ? undefined : log.join("\n");
    }
    case "skip":
      return autopilot.skipRecommendation();
    case "watch": {
      const sub = (arg ?? "list").toLowerCase();
      const list = await getWatchlist();
      if (sub === "list") return `watchlist (${list.length}):\n${list.join(", ")}`;
      if (sub === "reset") {
        await setWatchlist(DEFAULT_WATCHLIST);
        return `watchlist reset to the default ${DEFAULT_WATCHLIST.length} names`;
      }
      const t = rest[1];
      if (!t) return "usage: /watch add <TICKER> | /watch remove <TICKER>";
      if (sub === "add") {
        const found = await desk.instrumentsFor([t]);
        if (!found.length) return `Trading 212 does not know "${t}". Try /find first.`;
        if (!list.includes(t)) await setWatchlist([...list, t]);
        return `added ${t} (${found[0].name})`;
      }
      if (sub === "remove") {
        await setWatchlist(list.filter((x) => x !== t));
        return `removed ${t}`;
      }
      return "usage: /watch | /watch add <T> | /watch remove <T> | /watch reset";
    }
    case "account":
      return desk.accountText();
    case "portfolio":
      return desk.portfolioText();
    case "find":
      if (!rest.length) return "usage: /find <name or ticker>";
      return desk.findText(rest.join(" "));
    case "research":
      if (!arg) return "usage: /research <TICKER>";
      return desk.researchText(arg);
    case "propose": {
      if (!arg) return "usage: /propose <TICKER>";
      await sendMessage(chatId, `researching ${arg}... this takes about a minute.`);
      const { text: out } = await desk.propose(arg);
      return out;
    }
    case "proposals":
      return desk.proposalsText();
    case "show":
      if (!arg) return "usage: /show <proposalId>";
      return desk.proposalText(arg);
    case "reject":
      if (!arg) return "usage: /reject <proposalId>";
      return desk.rejectProposal(arg, rest.slice(1).join(" ") || undefined);
    case "approve": {
      if (!arg) return autopilot.approveRecommendation();
      const { plan, text: out, blocked } = await desk.planApprove(arg, qty);
      if (blocked.length) return out;
      await store.set(PENDING_KEY, {
        kind: "approve",
        plan,
        expected: plan.expected,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
      } satisfies PendingConfirm);
      return `${out}\n\nSubmit this ${desk.envLabel()} order to Trading 212?\nReply exactly:  ${plan.expected}\nAnything else cancels. Expires in 10 minutes.`;
    }
    case "review":
      return (await desk.reviewText()).text;
    case "close": {
      if (!arg) return "usage: /close <TICKER> [qty]";
      const { plan, text: out, blocked } = await desk.planClose(arg, qty);
      if (blocked.length) return out;
      await store.set(PENDING_KEY, {
        kind: "close",
        plan,
        expected: plan.expected,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
      } satisfies PendingConfirm);
      return `${out}\n\nSubmit this ${desk.envLabel()} market SELL to Trading 212?\nReply exactly:  ${plan.expected}\nAnything else cancels. Expires in 10 minutes.`;
    }
    case "untrack":
      if (!arg) return "usage: /untrack <TICKER>";
      return desk.untrack(arg);
    case "orders":
      return desk.ordersText();
    case "cancel": {
      const id = Number(arg);
      if (!id) return "usage: /cancel <orderId>";
      return desk.cancelOrder(id);
    }
    default:
      return `unknown command "${rawCmd}". Send /help.`;
  }
}

/** Daily review, pushed to the owner. Called by the review cron route. */
export async function pushReview(): Promise<string> {
  const { text, exits, urgent } = await desk.reviewText();
  const header = urgent ? "EXIT NOW" : exits ? "action needed" : "daily review";
  const body = `${header}  |  ${desk.envLabel()}\n\n${text}`;
  if (config.telegram.chatId) await sendMessage(config.telegram.chatId, body);
  return body;
}
