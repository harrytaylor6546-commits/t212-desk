# t212-desk

A small personal trading desk for a Trading 212 account, driven from your phone through a Telegram bot. Research agents gather evidence, a Claude analyst writes a structured proposal, a deterministic risk gate checks it, and **you** confirm every order by typing the ticker back. Nothing is submitted without that.

Practice (demo) mode is the default. Live mode has to be switched on deliberately.

```
Telegram  ->  research  ->  analyst  ->  proposal  ->  risk gate  ->  you confirm  ->  Trading 212
                                                                 daily cron  ->  "EXIT" push to your phone
```

## What it does

- **Research** pulls Google News, Reddit, StockTwits, Yahoo price history, and optionally X and Tavily, into a dossier per ticker.
- **Analyst** (Claude) reads the dossier and returns a schema-validated proposal: action, thesis, dated catalyst, evidence with sources, risks, target, stop, horizon. NO_TRADE is its default answer.
- **Risk gate** is plain code, not a prompt. Max order value, max fraction of free cash, max orders per day, blocklist. It converts pence and foreign currencies into your account currency before sizing. The analyst never sees it.
- **Three-day rule.** Every trade must close within three trading days. A weekday cron runs `review`, compares each open trade with its target, stop and day count, and pushes a message to Telegram when something needs closing.
- **Confirmation.** `approve` and `close` show the full plan, then wait for you to reply with the ticker (or `LIVE <TICKER>` in live mode). Any other reply cancels. Confirmations expire after ten minutes.

The same commands work from a laptop CLI, which is useful for the first connection test.

## Campaign mode (hands-off)

```
/campaign start 200
```

The desk then runs a loop on its own:

1. Scans in four stages, cheap to expensive. Pre-screens the whole universe (FTSE 100 plus about 130 large US names, roughly 240 in total) on price move, gap and volume versus normal, then news volume on the top 25. Gathers a full dossier for the top 12 and has a fast, cheap model rank them by short-term catalyst. Sends the best 5 with an upward catalyst to the full analyst. If one is a BUY above the confidence bar it messages you a recommendation sized to the campaign slot.
2. You reply `APPROVE` (or `APPROVE LIVE` on a live account). Anything else leaves it waiting; `/skip` passes.
3. It checks every open campaign trade on each tick and closes automatically at the take-profit, the stop-loss, or the three-day limit, then immediately looks for the next trade.
4. It stops when total profit reaches the goal (closing everything), when the days run out, or when you send `/campaign stop`.

Settings: `tp` take-profit %, `sl` stop-loss %, `goal` % of budget, `days`, `open` max simultaneous trades. Defaults are tp=5 sl=4 goal=30 days=7 open=1. Override any of them inline, e.g. `/campaign start 200 tp=6 sl=3 goal=20`. Keep the stop smaller than the target: risking 10 to make 4 needs a 72% hit rate just to break even.

`/watch` shows the universe, `/watch add RRl_EQ` and `/watch remove ...` edit it, `/watch reset` restores the default list in `src/universe.ts`.

Each dossier draws on: Yahoo price history with technicals (SMA20/50, RSI, gap, relative volume), a market backdrop line (FTSE, S&P, Nasdaq, VIX, GBP/USD), Google News, Yahoo Finance news, Reddit, StockTwits for US names, SEC filings for US names, and optionally Finnhub company news and earnings dates (`FINNHUB_API_KEY`, free), X (`X_BEARER_TOKEN`, paid) and Tavily web search (`TAVILY_API_KEY`).

Cost per scan is roughly 5 analyst calls at about 20p each plus a few pence of triage, so around £1. Scans run at most every two hours while a slot is free (`CAMPAIGN_SCAN_MIN_INTERVAL_MIN`). Tune the funnel with `CAMPAIGN_TRIAGE_TOP`, `CAMPAIGN_ANALYSE_TOP`, `CAMPAIGN_MIN_CATALYST` and `CAMPAIGN_MIN_CONFIDENCE`.

**Ticks.** Exits only happen when a tick runs. The Vercel cron in `vercel.json` runs once a day as a fallback, which is not enough for a 4% target. Point a free external scheduler at the tick endpoint every 15 minutes during market hours. On cron-job.org:

- URL: `https://<your-app>.vercel.app/api/cron/tick`
- Header: `Authorization: Bearer <CRON_SECRET>`
- Schedule: every 15 minutes, Monday to Friday, 08:00 to 21:00 UK time

If you're on Vercel Pro you can instead set the cron schedule to `*/15 7-20 * * 1-5`.

`AUTO_CLOSE=false` in the env vars turns automatic exits off. The bot then messages EXIT and waits for you to `/close`.

## Phone setup (Telegram + Vercel)

**1. Create the bot.** In Telegram, message `@BotFather`, send `/newbot`, pick a name. Copy the token it gives you.

**2. Keys.** Trading 212 app: menu > Settings > API (Beta), in Practice mode first. Anthropic: console.anthropic.com. Make up two long random strings for `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET`.

**3. Push this repo to GitHub** and import it into Vercel as a new project. Framework is detected as Next.js.

**4. Storage.** In the Vercel project, Storage tab > Create > Blob. Connect it to the project. This adds `BLOB_READ_WRITE_TOKEN` automatically.

**5. Environment variables** in the Vercel project settings (all environments):

```
T212_ENV=practice
T212_API_KEY=...
T212_API_SECRET=...          (if your key came with one)
ANTHROPIC_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...  (random string)
CRON_SECRET=...              (random string)
RISK_MAX_ORDER_VALUE=250
```

Leave `TELEGRAM_CHAT_ID` empty for now. Deploy.

**6. Register the webhook.** Open this in your phone browser, with your app's domain and the secret you chose:

```
https://<your-app>.vercel.app/api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
```

It should return JSON with `"registered"`.

**7. Lock it to you.** Message your bot `/start`. It replies with your chat id. Add `TELEGRAM_CHAT_ID=<that number>` to the Vercel env vars and redeploy. From then on the bot ignores everyone else.

**8. Use it.** `/help` lists the commands. Start with `/account`, then `/find rolls royce`, then `/propose RRl_EQ`.

The cron in `vercel.json` runs the review at 14:30 UTC on weekdays, which is 15:30 UK time in summer and 14:30 in winter. Adjust the schedule if you want it closer to the close. On the Hobby plan Vercel may run it up to an hour late.

## Laptop CLI

```bash
npm install
cp .env.example .env     # fill in the same values
npm run desk -- account
npm run desk -- propose RRl_EQ
npm run desk -- review
```

Locally the desk stores its state in `./data`. On Vercel it uses the Blob store. They are separate, so a proposal made on the laptop is not visible to the bot and vice versa.

## Commands

| Telegram | CLI | What it does |
|---|---|---|
| `/account` | `account` | cash and account currency |
| `/portfolio` | `portfolio` | open positions |
| `/find <name>` | `find <name>` | search instruments |
| `/research <T>` | `research <T>` | print the dossier |
| `/propose <T>` | `propose <T>` | research + analyst proposal |
| `/proposals` | `proposals` | recent proposals |
| `/show <id>` | `show <id>` | one proposal in full |
| `/approve <id> [qty]` | `approve <id> [--qty N]` | risk-check, then confirm |
| `/reject <id>` | `reject <id>` | mark rejected |
| `/review` | `review` | check open trades against target, stop, clock |
| `/close <T> [qty]` | `close <T> [--qty N]` | market-sell, then confirm |
| `/untrack <T>` | `untrack <T>` | forget a trade closed in the app |
| `/orders`, `/cancel <id>` | `orders`, `cancel <id>` | open orders at the broker |

Tickers are Trading 212 format: `AAPL_US_EQ`, `RRl_EQ` (London), `SAPd_EQ` (Xetra). Proposal ids can be abbreviated to any unique part, e.g. the last few digits.

## What the Trading 212 API can and cannot do

Verified September 2026. The API is still labelled beta by Trading 212.

- Stocks and ETFs on Invest and ISA accounts. No CFD, no crypto, no forex, no SIPP.
- Practice accounts accept market, limit, stop and stop-limit orders.
- **Live accounts accept market orders only** through the API. This desk enforces that.
- No quote endpoint. Prices for instruments you do not hold come from Yahoo Finance, which is unofficial.
- Tight rate limits. The instrument list is cached for 24 hours.
- The API cannot hold a stop order for you on live. The daily review is the stop. Setting a stop loss manually in the app as well is sensible.

## Security model

- Research code has **no broker keys**. It only touches public endpoints.
- The analyst has **no broker keys** and no way to submit anything. It returns JSON.
- Only the approve and close paths can place an order, and only after you repeat the ticker.
- The bot answers exactly one Telegram chat id and checks a secret on every webhook call.
- Risk caps live in env vars and are enforced in `risk.ts` before any request leaves the server. Set them low.
- Use a practice account until the proposals have earned trust. When you go live, generate a separate live key with an IP restriction and consider a separate Invest account with a fixed balance.

## Going live later

1. Run in practice for a few weeks. Compare `/proposals` against what happened.
2. Generate a live key in the app, not in practice mode this time.
3. Set `T212_ENV=live` in Vercel and lower `RISK_MAX_ORDER_VALUE` to something you would not miss. Redeploy.
4. Confirmations now require `LIVE <TICKER>`.

## Not financial advice

The analyst produces research summaries with sources. It is not a licensed adviser and neither is the person who wrote this README. Read the sources it cites before approving anything.
