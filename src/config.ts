// #region config
// Central configuration: env, risk rails, and the watchlist.
// Risk numbers are deliberately conservative for a small ($200) account.

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  mode: env("MODE", "paper") as "paper" | "live",
  tradingEnabled: env("TRADING_ENABLED", "true") === "true",

  // Benchmark to beat. Bot return is scored against this ETF's return over the
  // same window on the dashboard.
  benchmark: "SCHD",

  alpaca: {
    keyId: env("ALPACA_KEY_ID", ""),
    secretKey: env("ALPACA_SECRET_KEY", ""),
    tradingUrl: env("ALPACA_TRADING_URL", "https://paper-api.alpaca.markets"),
    dataUrl: env("ALPACA_DATA_URL", "https://data.alpaca.markets"),
  },

  ha: {
    baseUrl: env("HA_BASE_URL", "http://homeassistant.local:8123"),
    token: env("HA_TOKEN", ""),
    notifyService: env("HA_NOTIFY_SERVICE", "notify.notify"),
  },

  // ntfy push notifications (buy/sell alerts). Set NTFY_TOPIC to enable.
  // NTFY_URL defaults to the public service; point it at a self-hosted instance
  // later if you want. NTFY_TOKEN is optional (protected/self-hosted topics).
  ntfy: {
    url: env("NTFY_URL", "https://ntfy.sh"),
    topic: env("NTFY_TOPIC", ""),
    token: env("NTFY_TOKEN", ""),
  },

  // AI news classifier (news.ts). Claude reads the recent headlines and judges
  // whether there's genuinely material NEGATIVE news explaining a dip, instead
  // of the old dumb "3+ headlines = skip" count that permanently vetoed
  // always-in-the-news mega-caps. The call goes to a host-side shim
  // (stonkbot-classifier.service) that runs `claude --print` under Filip's
  // subscription, so no API key is needed. Empty url/token => fall back to the
  // count heuristic so the bot still runs.
  classifier: {
    url: env("CLASSIFIER_URL", ""),
    token: env("CLASSIFIER_TOKEN", ""),
  },

  dashboardPort: Number(env("DASHBOARD_PORT", "8770")),
  // Public dashboard URL, used as the tap target of push notifications so a
  // buy/sell alert opens straight into the live scoreboard.
  dashboardUrl: env("DASHBOARD_URL", "https://stonkbot.filipkin.com"),

  // #region risk rails
  // These are enforced in code on every cycle. The bot cannot override them.
  risk: {
    // HARD RULE: no shorting, ever. Enforced structurally (only submitBuy can
    // open exposure; exits use closePosition). This flag documents intent and
    // must stay false — flipping it does nothing without a short order path,
    // which deliberately does not exist. Worst case = lose the cash invested.
    allowShorting: false as const,
    // Never put more than this fraction of account equity into one position.
    // 0.12 with maxOpenPositions 8 + the 10% cash buffer => the book fills to
    // ~7 names before investable cash runs out (90% / 12% = 7.5); on the $200
    // live account that's ~$24/position, above the $20 min order.
    maxPositionFraction: 0.12,
    // Hard stop-loss per position. Sold at market if breached.
    stopLossFraction: 0.02,
    // Take-profit target per position.
    takeProfitFraction: 0.04,
    // If the account's realised+unrealised loss for the day hits this fraction
    // of the day's opening equity, halt all new buys until tomorrow.
    dailyLossCapFraction: 0.06,
    // Keep this fraction of equity as uninvested cash buffer.
    cashBufferFraction: 0.1,
    // Max number of concurrent open positions (diversification on a tiny book).
    // Cap is 8, but the 12% size + 10% cash buffer realistically fills ~7.
    maxOpenPositions: 8,
    // Max concurrent open positions within a single sector (avoids clustering
    // e.g. three pharma names on a sector-wide dip). See config.sectors.
    maxPerSector: 2,
    // Minimum order size in dollars (avoid dust trades eaten by spread).
    minOrderUsd: 20,
    // Max NEW buys opened in a single cycle. Sells/exits are never capped. Each
    // fill re-checks every rail (budget, cash buffer, sector cap, max positions)
    // against the simulated post-buy book, so this only lets the bot fill more
    // than one genuinely-qualified dip in the same 5-min cycle instead of
    // deferring the runner-up to the next cycle (by when the dip may be gone).
    maxBuysPerCycle: Number(env("MAX_BUYS_PER_CYCLE", "2")),
    // Minimum hold before the DISCRETIONARY RSI momentum exit may fire, to stop
    // churning a position at breakeven when RSI briefly pops back. The hard risk
    // exits (stop-loss / take-profit) are NEVER gated by this, so a tanking
    // position is still cut immediately. Tune via MIN_HOLD_MINUTES.
    minHoldMinutes: Number(env("MIN_HOLD_MINUTES", "90")),
  },
  // #endregion

  // #region watchlist
  // Liquid US large caps across sectors. No penny stocks, no thin names.
  // Diversified beyond the original tech+health so the dip-buyer has more
  // uncorrelated setups; the `sectors` map drives the per-sector cap.
  watchlist: [
    // Tech
    "AAPL", "MSFT", "NVDA", "AMD", "GOOGL", "META", "AVGO", "CRM", "ADBE", "QCOM",
    // Healthcare
    "JNJ", "UNH", "LLY", "ABBV", "PFE", "MRK", "TMO", "ISRG", "AMGN", "MDT",
    // Financials
    "JPM", "V", "MA", "BAC",
    // Consumer
    "AMZN", "COST", "HD", "PG", "KO", "WMT",
    // Industrials
    "CAT", "HON",
    // Energy
    "XOM", "CVX",
  ],
  // Sector tag per symbol, for the per-sector position cap (risk.ts).
  sectors: {
    AAPL: "Tech", MSFT: "Tech", NVDA: "Tech", AMD: "Tech", GOOGL: "Tech",
    META: "Tech", AVGO: "Tech", CRM: "Tech", ADBE: "Tech", QCOM: "Tech",
    JNJ: "Healthcare", UNH: "Healthcare", LLY: "Healthcare", ABBV: "Healthcare",
    PFE: "Healthcare", MRK: "Healthcare", TMO: "Healthcare", ISRG: "Healthcare",
    AMGN: "Healthcare", MDT: "Healthcare",
    JPM: "Financials", V: "Financials", MA: "Financials", BAC: "Financials",
    AMZN: "Consumer", COST: "Consumer", HD: "Consumer", PG: "Consumer",
    KO: "Consumer", WMT: "Consumer",
    CAT: "Industrials", HON: "Industrials",
    XOM: "Energy", CVX: "Energy",
  } as Record<string, string>,
  // #endregion

  // Strategy tunables (see strategy.ts).
  strategy: {
    barTimeframe: "5Min",
    lookbackBars: 60, // ~5 hours of 5-min bars
    rsiPeriod: 14,
    rsiOversold: 35,
    rsiOverbought: 65,
    smaPeriod: 20,
    // Only buy dips when the longer trend is up: price above this daily SMA.
    trendSmaPeriodDays: 50,
    // Falling-knife guard: never buy a dip deeper than this (a big intraday
    // drop is usually a real repricing, not noise to mean-revert into).
    maxDipFraction: 0.05,
    // If a dip coincides with this many fresh headlines in 24h, treat it as a
    // news catalyst and skip (avoid catching a knife falling on bad news).
    newsCatalystThreshold: 3,
  },
} as const;

export type Config = typeof config;
// #endregion
