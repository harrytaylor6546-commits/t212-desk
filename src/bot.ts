/**
 * Telegram command handling. Every message is checked against the one allowed chat id.
 * Orders need a second message that repeats the ticker exactly, same as the CLI.
 */
import { config } from "./config";
import * as desk from "./desk";
import { sendMessage, type TelegramUpdate } from "./telegram";
import { store } from "./store";
import { T212Error } from "./t212/client";

interface PendingConfirm {
  kind: "approve" | "close";
  plan: desk.ApprovePlan | desk.ClosePlan;
  expected: string;
  expiresAt: string;
}

const PENDING_KEY = "pending-confirm";
const PENDING_TTL_MS = 10 * 60 * 1000;

const HELP = `Commands (practice or live is set on the server):
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

  switch (cmd) {
    case "start":
    case "help":
      return `t212-desk  |  ${desk.envLabel()}\n\n${HELP}`;
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
      if (!arg) return "usage: /approve <proposalId> [qty]";
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

/** Daily review, pushed to the owner. Called by the cron route. */
export async function pushReview(): Promise<string> {
  const { text, exits, urgent } = await desk.reviewText();
  const header = urgent ? "EXIT NOW" : exits ? "action needed" : "daily review";
  const body = `${header}  |  ${desk.envLabel()}\n\n${text}`;
  if (config.telegram.chatId) await sendMessage(config.telegram.chatId, body);
  return body;
}
