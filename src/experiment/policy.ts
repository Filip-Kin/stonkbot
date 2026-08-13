// #region policy
// The pure decision policy: given the shared market data and an arm's params,
// produce entry candidates and the discretionary (RSI momentum) exit. This is a
// refactor of strategy.ts's evaluateSymbol with ALL I/O removed — no bar fetch,
// no news fetch, no global config. Everything it needs is passed in, so it is a
// deterministic function of (data, params) and every arm can be run through the
// same code with only its params differing (the friend's INPUT->OUTPUT ask).
//
// The mechanical exits (stop / take-profit / trailing / ATR) live in sim.ts,
// since they key off entry price + high-water mark, which the book owns. This
// mirrors the live bot's split: risk.ts forcedExits vs strategy.ts momentum exit.
import { rsi, sma, dipFraction } from "../indicators";
import type { StrategyParams } from "./params";
import type { SymbolData, SimPosition } from "./types";

export interface BuyCandidate {
  symbol: string;
  score: number; // higher = stronger conviction, for ranking
  price: number;
  reason: string;
}

// Buy-the-dip entry for a symbol NOT currently held. Returns null if no setup.
export function entrySignal(d: SymbolData, p: StrategyParams): BuyCandidate | null {
  if (d.intradayCloses.length < p.smaPeriod + 1 || d.dailyCloses.length < p.trendSmaPeriodDays) {
    return null;
  }
  const price = d.price;
  const trendSma = sma(d.dailyCloses, p.trendSmaPeriodDays);
  const r = rsi(d.intradayCloses, p.rsiPeriod);
  const dip = dipFraction(d.intradayCloses, p.smaPeriod);
  if (trendSma === null || r === null || dip === null) return null;

  const trendUp = price > trendSma;
  if (!(trendUp && r <= p.rsiOversold && dip > 0)) return null;
  // Falling-knife guard: an extreme dip is usually a real repricing.
  if (dip > p.maxDipFraction) return null;
  // AI news veto: skip a dip that sits on a genuine adverse catalyst.
  if (p.newsVeto && d.news.blockBuy) return null;

  const score = (p.rsiOversold - r) + dip * 100; // more oversold + deeper dip = higher
  return {
    symbol: d.symbol,
    score,
    price,
    reason: `uptrend, RSI ${r.toFixed(0)} oversold, ${(dip * 100).toFixed(1)}% below SMA${p.smaPeriod}`,
  };
}

// Discretionary momentum exit: sell a HELD position into strength when RSI runs
// hot. Gated by the breakeven rule (only when green — an RSI spike on a name
// still underwater is held for reversion, not dumped at a loss) and, if set, a
// minimum hold age. Returns a reason string, or null to hold. The mechanical
// stop / take-profit / trailing exits are checked separately in sim.ts.
export function momentumExit(
  d: SymbolData,
  p: StrategyParams,
  pos: SimPosition,
  now: Date,
): string | null {
  if (p.rsiOverbought === null) return null;
  const r = rsi(d.intradayCloses, p.rsiPeriod);
  if (r === null || r < p.rsiOverbought) return null;
  // Min-hold gate: block churn on a position opened too recently.
  if (p.minHoldMinutes > 0) {
    const heldMin = (now.getTime() - new Date(pos.entryTime).getTime()) / 60000;
    if (heldMin < p.minHoldMinutes) return null;
  }
  // Breakeven gate: don't realize a loss on an overbought-but-underwater name.
  const pnlPct = (pos.price - pos.entryPrice) / pos.entryPrice;
  if (p.breakevenGate && pnlPct <= 0) return null;
  return `RSI ${r.toFixed(0)} overbought, sell into strength`;
}
// #endregion
