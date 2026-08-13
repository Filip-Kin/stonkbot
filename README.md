# stonkbot

An AI day-trader for liquid US tech and medical stocks. Long-only, moderate
mean-reversion strategy (buy the dip inside an uptrend, sell into strength),
with hard risk rails it cannot override. Paper-first via Alpaca; the same code
goes live by swapping keys.

## Why paper first

Real live prices, simulated money. It proves the strategy actually beats
buy-and-hold before a real dollar is at risk. Flip `MODE` and the keys to go
live later, as a deliberate decision.

## Reality checks baked into the design

- **$200 is a small book.** Spreads and the per-trade minimum matter, so the
  watchlist is liquid large/mid caps only and each buy has a $20 floor.
- **Pattern Day Trader rule.** In a live *margin* account, 4+ day trades in 5
  business days forces a $25k minimum equity balance. This bot is long-only and
  buys one new position per cycle to stay well clear; for live use, prefer a
  **cash account** (no PDT) and accept that sold cash settles T+1 before reuse.
- **Free IEX data feed** by default. Upgrade `feed=iex` to `sip` in
  `src/alpaca.ts` if you have the Alpaca market-data subscription.

## Risk rails (config.ts, enforced every cycle)

- Max 25% of equity in any one position
- 2% hard stop-loss per position, 4% take-profit
- 6% daily loss cap halts new buys until the next trading day
- 10% cash buffer kept uninvested
- Max 4 concurrent positions
- Master kill switch: `TRADING_ENABLED=false`

## Setup

1. `cp .env.example .env`
2. Create Alpaca **paper** API keys at https://alpaca.markets and paste
   `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` into `.env`.
3. Add your Home Assistant long-lived token and notify service to `.env`.
4. `bun install`
5. One evaluation cycle (safe, paper): `bun run once`
6. Continuous during market hours: `bun start`
7. Dashboard: `bun run dashboard` then open `http://<server>:8770`

## How it runs

`src/index.ts` loops every 5 minutes. Each cycle it checks the Alpaca market
clock, and only when the market is open it: runs forced risk exits, checks the
daily loss cap, evaluates the watchlist, and places the single best allowed
buy. US market hours are overnight NZ time, so it works while you sleep.

## Deploy on the home server

See `deploy/stonkbot.service` and `deploy/stonkbot-dashboard.service` for
systemd units. Data (state, equity history) lives in `data/state.json`.
