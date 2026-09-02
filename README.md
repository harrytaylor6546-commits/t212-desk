# t212-desk

A small personal trading desk for a Trading 212 account. Research agents gather evidence, a Claude analyst writes a structured proposal, a deterministic risk gate checks it, and **you** press the button. Nothing is submitted without a typed confirmation from a human.

Practice (demo) mode is the default. Live mode has to be switched on deliberately.

## What it does

```
research  ->  analyst  ->  proposal on disk  ->  risk gate  ->  you confirm  ->  Trading 212
```

- **Research** pulls Google News, Reddit, StockTwits, Yahoo price history, and optionally X and Tavily, into a dossier per ticker.
- **Analyst** (Claude) reads the dossier and returns a schema-validated proposal: action, thesis, evidence with sources, risks, invalidation level, sizing, order type. NO_TRADE is its default answer.
- **Risk gate** is plain code, not a prompt. Max order value, max fraction of free cash, max orders per day, blocklist. The analyst never sees it and cannot argue with it.
- **Approve** re-reads live account state, sizes the order, runs the gate, and asks you to type the ticker (or `LIVE <ticker>` in live mode) before submitting.

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

1. In the Trading 212 app, **Switch to Practice** first, then Settings > API (Beta) > Generate. Paste the key (and secret, if you got one) into `T212_API_KEY` / `T212_API_SECRET`. Restrict the key to your IP.
2. Add `ANTHROPIC_API_KEY`.
3. Leave `T212_ENV=practice`.

## Commands

```bash
npm run desk -- account
npm run desk -- portfolio
npm run desk -- find rolls royce
npm run desk -- research RRl_EQ
npm run desk -- propose RRl_EQ
npm run desk -- proposals
npm run desk -- approve 202609022130-RRlEQ
npm run desk -- orders
```

Tickers are Trading 212 format: `AAPL_US_EQ`, `RRl_EQ` (London), `SAPd_EQ` (Xetra). Use `find` if unsure.

## What the Trading 212 API can and cannot do

Verified September 2026. The API is still labelled beta by Trading 212.

- Stocks and ETFs on Invest and ISA accounts. No CFD, no crypto, no forex, no SIPP.
- Practice accounts accept market, limit, stop and stop-limit orders.
- **Live accounts accept market orders only** through the API. This desk enforces that.
- No quote endpoint. Price for instruments you do not hold comes from Yahoo Finance, which is unofficial.
- Tight rate limits. The instrument list is cached for 24 hours because that endpoint allows one call per 50 seconds.

## Security model

The Instagram post that prompted this project made one point worth keeping: one login shared across every bot means one mistake reaches everything. So:

- Research code has **no broker keys**. It only ever touches public endpoints.
- The analyst has **no broker keys** and no way to submit anything. It returns JSON.
- Only `approve` in `cli.ts` can place an order, and only after a typed confirmation in the terminal.
- Risk caps live in `.env` and are enforced in `risk.ts` before any request leaves the machine. Set them low.
- Use a Trading 212 practice account until the proposals have earned trust. When you do go live, generate a separate live key with an IP restriction, and consider a separate Invest account with a fixed balance.
- `.env`, proposals and the order ledger are git-ignored.

## Going live later

1. Run in practice for a few weeks. Review `data/proposals/` against what actually happened.
2. Generate a live key in the app (not in practice mode this time). Restrict it to your IP.
3. Set `T212_ENV=live` and lower `RISK_MAX_ORDER_VALUE` to something you would not miss.
4. `approve` will demand you type `LIVE <TICKER>`.

## Not financial advice

The analyst produces research summaries with sources. It is not a licensed adviser and neither is the person who wrote this README. Read the sources it cites before approving anything.
