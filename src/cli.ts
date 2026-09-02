import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { T212Error } from "./t212/client";
import * as desk from "./desk";
import { storeKind } from "./store";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
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
  console.log(`t212-desk  |  ${desk.envLabel()}  |  storage: ${storeKind}\n`);

  switch (cmd) {
    case "account":
      return console.log(await desk.accountText());
    case "portfolio":
      return console.log(await desk.portfolioText());
    case "find": {
      const q = args.slice(1).join(" ");
      if (!q) throw new Error("usage: desk find <name or ticker>");
      return console.log(await desk.findText(q));
    }
    case "research":
      if (!args[1]) throw new Error("usage: desk research <TICKER>");
      return console.log(await desk.researchText(args[1]));
    case "propose": {
      if (!args[1]) throw new Error("usage: desk propose <TICKER>");
      console.log("gathering research and asking the analyst...");
      const { text } = await desk.propose(args[1]);
      return console.log(text);
    }
    case "proposals":
      return console.log(await desk.proposalsText());
    case "show":
      if (!args[1]) throw new Error("usage: desk show <proposalId>");
      return console.log(await desk.proposalText(args[1]));
    case "reject":
      if (!args[1]) throw new Error("usage: desk reject <proposalId> [--note text]");
      return console.log(await desk.rejectProposal(args[1], flag("note")));
    case "approve": {
      if (!args[1]) throw new Error("usage: desk approve <proposalId> [--qty N]");
      const qty = flag("qty") ? Number(flag("qty")) : undefined;
      const { plan, text, blocked } = await desk.planApprove(args[1], qty);
      console.log(text);
      if (blocked.length) process.exit(2);
      const go = await confirm(`\nSubmit this ${desk.envLabel()} order to Trading 212?`, plan.expected);
      if (!go) return console.log("aborted, proposal left pending");
      return console.log(await desk.executeApprove(plan));
    }
    case "review":
      return console.log((await desk.reviewText()).text);
    case "close": {
      if (!args[1]) throw new Error("usage: desk close <TICKER> [--qty N]");
      const qty = flag("qty") ? Number(flag("qty")) : undefined;
      const { plan, text, blocked } = await desk.planClose(args[1], qty);
      console.log(text);
      if (blocked.length) process.exit(2);
      const go = await confirm(`\nSubmit this ${desk.envLabel()} market SELL to Trading 212?`, plan.expected);
      if (!go) return console.log("aborted");
      return console.log(await desk.executeClose(plan));
    }
    case "untrack":
      if (!args[1]) throw new Error("usage: desk untrack <TICKER>");
      return console.log(await desk.untrack(args[1]));
    case "orders":
      return console.log(await desk.ordersText());
    case "cancel": {
      const id = Number(args[1]);
      if (!id) throw new Error("usage: desk cancel <orderId>");
      return console.log(await desk.cancelOrder(id));
    }
    default:
      console.log(`usage: npm run desk -- <command>

  account                 cash and account currency
  portfolio               open positions
  find <query>            search Trading 212 instruments (name, ticker, ISIN)
  research <TICKER>       gather news, social and price context, print it
  propose <TICKER>        research + analyst proposal, saved for review
  proposals               list saved proposals
  show <id>               print one proposal in full
  approve <id> [--qty N]  risk-check, confirm, then submit the order yourself
  reject <id> [--note s]  mark a proposal rejected
  review                  check every open trade against its target, stop and 3-day clock
  close <TICKER> [--qty]  confirm, then market-sell an open trade
  untrack <TICKER>        forget a trade you closed in the app
  orders                  open orders at the broker
  cancel <orderId>        cancel an open order

Environment is set by T212_ENV in .env (practice by default).
The same commands work from the Telegram bot once deployed.`);
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
