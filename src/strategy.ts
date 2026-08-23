// #region strategy
// A deliberately moderate long-only strategy: buy the dip inside an uptrend,
// sell into strength or at the risk-managed exits. No shorting, no leverage.
//
// Entry (buy the dip):
//   - longer daily trend is up (price above its 50-day SMA), AND
//   - intraday price has dipped below its short SMA, AND
//   - RSI is oversold (mean-reversion setup).
// Exit is handled by risk.ts (stop-loss / take-profit) plus a momentum
// exit here when RSI runs hot.
import { config } from "./config";
import { getBars } from "./alpaca";
import { rsi, sma, dipFraction } from "./indicators";
import { getRecentNews } from "./news";

// Raw indicator readings behind a signal, surfaced to the dashboard so the
// watchlist can show exactly how each name measures up against the criteria.
export interface SignalMetrics {
  rsi: number | null; // intraday RSI
  trendSma: number | null; // 50-day SMA (the uptrend gate)
  sma20: number | null; // short SMA (the dip reference)
  dip: number | null; // fraction below sma20 (0 if above)
  trendUp: boolean; // price > trendSma
}

export interface Signal {
  symbol: string;
  action: "buy" | "sell" | "hold";
  reason: string;
  score: number; // higher = stronger conviction, for ranking buys
  price: number;
  metrics?: SignalMetrics; // absent while data/indicators are warming up
  // recent headlines for the dashboard, with a five-level sentiment tag. `latest`
  // stays for back-compat; `headlines` carries the top few for the watchlist card.
  news?: {
    count: number;
    latest: string | null;
    headlines?: string[];
    sentiment?: "great" | "positive" | "neutral" | "negative" | "terrible";
  };
}

export async function evaluateSymbol(
  symbol: string,
  // The held position's unrealized P/L fraction (0.02 = +2%), or null if we
  // don't hold it. Lets the momentum exit gate on cost basis (see below).
  heldPnlPct: number | null,
  now: Date,
): Promise<Signal> {
  const s = config.strategy;
  const holding = heldPnlPct !== null;
  // Look-back windows: the bars endpoint needs an explicit `start` or it only
  // returns the current session. Daily needs enough calendar days to cover
  // `trendSmaPeriodDays` trading days (~7 cal days per 5 trading days, plus
  // slack); intraday a week comfortably covers `lookbackBars` 5-min bars.
  const day = 24 * 60 * 60 * 1000;
  const dailyStart = new Date(now.getTime() - (s.trendSmaPeriodDays * 2 + 20) * day).toISOString();
  const intradayStart = new Date(now.getTime() - 7 * day).toISOString();
  const intraday = await getBars(symbol, s.barTimeframe, s.lookbackBars, intradayStart);
  const daily = await getBars(symbol, "1Day", s.trendSmaPeriodDays + 2, dailyStart);

  if (intraday.length < s.smaPeriod + 1 || daily.length < s.trendSmaPeriodDays) {
    return { symbol, action: "hold", reason: "insufficient data", score: 0, price: 0 };
  }

  const closes = intraday.map((b) => b.c);
  const dailyCloses = daily.map((b) => b.c);
  const price = closes[closes.length - 1]!;

  const trendSma = sma(dailyCloses, s.trendSmaPeriodDays);
  const intradayRsi = rsi(closes, s.rsiPeriod);
  const sma20 = sma(closes, s.smaPeriod);
  const dip = dipFraction(closes, s.smaPeriod);

  if (trendSma === null || intradayRsi === null || dip === null) {
    return { symbol, action: "hold", reason: "indicators warming up", score: 0, price };
  }

  const trendUp = price > trendSma;
  const metrics: SignalMetrics = { rsi: intradayRsi, trendSma, sma20, dip, trendUp };

  // Momentum exit for existing holdings: RSI hot -> take gains, let risk.ts
  // handle the hard stop/target. BREAKEVEN GATE: only "sell into strength" when
  // the position is actually in profit. An intraday RSI spike on a dead-cat
  // bounce would otherwise realize a LOSS on a name still below our cost basis
  // (which is what dumped LLY/AMZN underwater). Losers are left to the -2%
  // stop-loss; this keeps the two exits doing distinct jobs.
  if (holding && s.momentumExit && intradayRsi >= s.rsiOverbought) {
    if ((heldPnlPct ?? 0) > 0) {
      return {
        symbol,
        action: "sell",
        reason: `RSI ${intradayRsi.toFixed(0)} overbought, sell into strength`,
        score: intradayRsi,
        price,
        metrics,
      };
    }
    return {
      symbol,
      action: "hold",
      reason: `RSI ${intradayRsi.toFixed(0)} overbought but underwater ` +
        `(${((heldPnlPct ?? 0) * 100).toFixed(2)}%), hold for reversion`,
      score: 0,
      price,
      metrics,
    };
  }

  // Buy-the-dip entry.
  if (!holding && trendUp && intradayRsi <= s.rsiOversold && dip > 0) {
    // Falling-knife guard: an extreme dip is usually a real repricing.
    if (dip > s.maxDipFraction) {
      return {
        symbol,
        action: "hold",
        reason: `dip ${(dip * 100).toFixed(1)}% too deep (falling knife), skip`,
        score: 0,
        price,
        metrics,
      };
    }
    // News-catalyst guard: fetch headlines only now that a buy would fire, and
    // let the AI classifier decide if they're a real adverse catalyst.
    const news = await getRecentNews(symbol, now);
    if (news.blockBuy) {
      return {
        symbol,
        action: "hold",
        reason: `dip on bad news, skip: ${news.reason}`,
        score: 0,
        price,
        metrics,
      };
    }
    const score = (s.rsiOversold - intradayRsi) + dip * 100; // more oversold + deeper dip = higher
    return {
      symbol,
      action: "buy",
      reason: `uptrend, RSI ${intradayRsi.toFixed(0)} oversold, ${(dip * 100).toFixed(1)}% below SMA${s.smaPeriod}, news clear`,
      score,
      price,
      metrics,
    };
  }

  return {
    symbol,
    action: "hold",
    reason: `no setup (trendUp=${trendUp}, RSI=${intradayRsi.toFixed(0)})`,
    score: 0,
    price,
    metrics,
  };
}
// #endregion
