// #region experiment params + arms
// The parameter space for the multi-arm experiment, plus the 40 pre-registered
// arms. Each arm is the baseline (the live bot's current config) with a small,
// deliberate set of overrides, so a difference in results is attributable to the
// knob(s) that changed. Named arms are the ones expected to be notable; unnamed
// OFAT arms display as "Arm N".
//
// The pre-registration lives at ~/.claude/plans (the approved plan). Do not
// silently re-tune these mid-run: changing a live arm's params breaks the
// controlled comparison. Add a NEW arm instead.
import type { PoolId } from "./pools";

// The decision policy's tunables (see policy.ts + sim.ts).
export interface StrategyParams {
  // Entry gates.
  rsiOversold: number; // buy when intraday RSI <= this
  maxDipFraction: number; // falling-knife guard: skip dips deeper than this
  trendSmaPeriodDays: number; // uptrend gate: price must exceed this daily SMA
  smaPeriod: number; // short SMA used as the intraday dip reference
  rsiPeriod: number;
  newsVeto: boolean; // honour the AI adverse-catalyst veto on a dip buy
  // Exits (see sim.ts — these run on the virtual book each cycle).
  stopLossFraction: number; // flat stop, as a fraction below entry
  takeProfitFraction: number | null; // flat target; null = no fixed take-profit
  rsiOverbought: number | null; // RSI momentum exit level; null = disabled
  breakevenGate: boolean; // momentum exit only fires while the position is green
  trailingStopFraction: number | null; // trail below the high-water mark; null = off
  atrStopMult: number | null; // if set, stop = entry - mult*ATR (overrides flat stop)
  atrTakeProfitMult: number | null; // if set, target = entry + mult*ATR
  minHoldMinutes: number; // discretionary (RSI) exit is gated until this hold age
}

// The risk rails (see rails.ts — a parameterized clone of risk.ts).
export interface RailsParams {
  maxPositionFraction: number;
  maxOpenPositions: number;
  maxPerSector: number; // Number.POSITIVE_INFINITY = no sector cap
  cashBufferFraction: number;
  dailyLossCapFraction: number;
  maxBuysPerCycle: number;
  minOrderUsd: number;
}

export interface Arm {
  id: number;
  name: string; // "" => an unnamed OFAT arm, shown as "Arm N"
  hypothesis: string;
  pool: PoolId;
  strategy: StrategyParams;
  rails: RailsParams;
}

// Baseline = the live bot's current config (config.ts). minHoldMinutes starts at
// 0 to match the live bot, where that knob is currently dead (never enforced).
export const BASE_STRATEGY: StrategyParams = {
  rsiOversold: 35,
  maxDipFraction: 0.05,
  trendSmaPeriodDays: 50,
  smaPeriod: 20,
  rsiPeriod: 14,
  newsVeto: true,
  stopLossFraction: 0.02,
  takeProfitFraction: 0.04,
  rsiOverbought: 65,
  breakevenGate: true,
  trailingStopFraction: null,
  atrStopMult: null,
  atrTakeProfitMult: null,
  minHoldMinutes: 0,
};

export const BASE_RAILS: RailsParams = {
  maxPositionFraction: 0.12,
  maxOpenPositions: 8,
  maxPerSector: 2,
  cashBufferFraction: 0.1,
  dailyLossCapFraction: 0.06,
  maxBuysPerCycle: 2,
  minOrderUsd: 20,
};

// Small builder: an arm is baseline plus overrides. `pool` defaults to P0.
function arm(
  id: number,
  name: string,
  hypothesis: string,
  opts: {
    strategy?: Partial<StrategyParams>;
    rails?: Partial<RailsParams>;
    pool?: PoolId;
  } = {},
): Arm {
  return {
    id,
    name,
    hypothesis,
    pool: opts.pool ?? "P0",
    strategy: { ...BASE_STRATEGY, ...opts.strategy },
    rails: { ...BASE_RAILS, ...opts.rails },
  };
}

export const ARMS: Arm[] = [
  // #region A. Control
  arm(1, "The Control", "Reproduces the observed negative expectancy (avg loss 2.5x avg win). The yardstick every other arm is measured against."),
  // #endregion

  // #region B. Exit logic (H1 — the prime suspect)
  arm(2, "", "Tighter stop cuts losers faster but adds whipsaw stop-outs; may not fix the win/loss size asymmetry.",
    { strategy: { stopLossFraction: 0.015 } }),
  arm(3, "Wide Stop", "Room past intraday noise avoids premature -2% stop-outs on names that would have reverted; fewer but larger losses.",
    { strategy: { stopLossFraction: 0.03 } }),
  arm(4, "", "A bigger target lets winners exceed today's tiny average win.",
    { strategy: { takeProfitFraction: 0.06 } }),
  arm(5, "Let It Ride", "Doubling the target materially raises avg win; risk is fewer TP hits (winners round-trip before reaching 8%).",
    { strategy: { takeProfitFraction: 0.08 } }),
  arm(6, "", "Delaying the momentum exit stops the +0.3% scalps and captures more of each up-move.",
    { strategy: { rsiOverbought: 75 } }),
  arm(7, "Diamond Hands", "The RSI>65 exit is what knifes winners at tiny gains; removing it and letting the 4% take-profit work is the most direct fix for the asymmetry.",
    { strategy: { rsiOverbought: null } }),
  arm(8, "The Trailer", "Textbook asymmetry fix: cap the loss, let the win run, exit only on a reversal. Should raise avg win most while bounding avg loss.",
    { strategy: { takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.03 } }),
  arm(9, "", "A looser trail rides bigger trends at the cost of giving back more on reversal; tests trail width.",
    { strategy: { takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.05 } }),
  arm(10, "Volatility-Aware", "Flat 2%/4% ignores each name's volatility (2% is noise for NVDA, a real move for KO). Volatility-scaled exits stop the whipsaw.",
    { strategy: { atrStopMult: 2, atrTakeProfitMult: 4 } }),
  arm(11, "", "Enforcing a minimum hold blocks same-cycle churn on the discretionary RSI exit; tests the currently-dead hold-time gate.",
    { strategy: { minHoldMinutes: 90 } }),
  // #endregion

  // #region C. Entry logic (H2)
  arm(12, "Deep Dip", "Only-deeper-oversold entries improve per-trade edge (better entries) at the cost of trade frequency.",
    { strategy: { rsiOversold: 30 } }),
  arm(13, "", "More entries, lower average quality; tests whether frequency or selectivity wins.",
    { strategy: { rsiOversold: 40 } }),
  arm(14, "", "A stricter knife guard avoids real repricings; higher win rate, fewer trades.",
    { strategy: { maxDipFraction: 0.03 } }),
  arm(15, "", "A looser knife guard catches sharper reversions but risks catching falling knives.",
    { strategy: { maxDipFraction: 0.08 } }),
  arm(16, "", "A faster trend filter admits more names in shorter uptrends; more trades, possibly weaker trend quality.",
    { strategy: { trendSmaPeriodDays: 20 } }),
  arm(17, "", "Requiring a stronger long-term uptrend improves the base rate of mean-reversion working.",
    { strategy: { trendSmaPeriodDays: 100 } }),
  arm(18, "", "The AI news gate is protective; disabling it should increase losing trades (buying into real bad-news dips), quantifying the gate's value.",
    { strategy: { newsVeto: false } }),
  // #endregion

  // #region D. Sizing & concentration (H3)
  arm(19, "Sniper", "Fewer, larger, higher-conviction positions concentrate into the best setups; higher variance, tests conviction over diversification.",
    { rails: { maxPositionFraction: 0.2, maxOpenPositions: 5 } }),
  arm(20, "", "Smaller, more numerous positions diversify idiosyncratic risk; smoother equity but diluted edge.",
    { rails: { maxPositionFraction: 0.08, maxOpenPositions: 12 } }),
  arm(21, "", "Relaxing the sector cap lets more of a broad-market dip be captured; risks sector clustering on correlated drops.",
    { rails: { maxPerSector: 3 } }),
  arm(22, "", "Removing the sector cap maximizes setups captured but exposes the book to a single-sector crash (the original clustering problem).",
    { rails: { maxPerSector: Number.POSITIVE_INFINITY } }),
  arm(23, "", "Staying more fully invested captures more upside but leaves less dry powder for the next dip.",
    { rails: { cashBufferFraction: 0.05 } }),
  arm(24, "", "A bigger buffer means more ammo for successive dips but more cash drag vs SCHD.",
    { rails: { cashBufferFraction: 0.2 } }),
  arm(25, "", "Filling more qualified dips per cycle raises deployment speed on broad down-days.",
    { rails: { maxBuysPerCycle: 4 } }),
  arm(26, "", "A looser halt lets the bot keep trading through a bad day; tests whether the 6% halt protects or just locks in losses before a rebound.",
    { rails: { dailyLossCapFraction: 0.1 } }),
  // #endregion

  // #region E. Universe / pool (Filip's idea)
  arm(27, "Big Pond", "A larger universe gives the dip-buyer more uncorrelated setups per day, raising trade count and diversification without lowering quality.",
    { pool: "P1" }),
  arm(28, "High Voltage", "Higher-volatility names dip bigger and more often for mean reversion to exploit; more edge if the reversion holds, more damage if it does not.",
    { pool: "P2" }),
  arm(29, "Blue Chips", "Calmer names mean-revert more reliably and hug SCHD's world; may beat the benchmark most consistently with smaller swings.",
    { pool: "P3" }),
  arm(30, "", "Isolates whether the strategy's edge is concentrated in one sector (tech dips revert differently than energy).",
    { pool: "P4" }),
  arm(31, "Index Reverter", "Mean-reverting broad ETFs removes single-stock catalyst risk entirely; tests whether the edge survives without idiosyncratic dips.",
    { pool: "P5" }),
  // #endregion

  // #region F. Combination arms (interactions — headline contenders)
  arm(32, "Anti-Asymmetry", "The direct minimal fix aimed squarely at the observed problem: keep the tight loss cap, kill the tiny-win scalp, let a trailing stop harvest the full up-move. Predicted top performer if H1 holds.",
    { strategy: { stopLossFraction: 0.02, takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.04 } }),
  arm(33, "Let Winners Run", "Combine wider loss tolerance, a big target, and no premature exit; maximizes avg win, tests whether bigger wins outweigh wider losses.",
    { strategy: { stopLossFraction: 0.03, takeProfitFraction: 0.08, rsiOverbought: null } }),
  arm(34, "Patient Value", "Best entries (deep dips) plus room to run; fewer, higher-quality, bigger trades — the quality-over-quantity thesis.",
    { strategy: { rsiOversold: 30, maxDipFraction: 0.08, stopLossFraction: 0.03, takeProfitFraction: 0.08 } }),
  arm(35, "The Scalper", "Opposite thesis: many fast, small, tightly-managed trades; tests whether high-frequency small-edge beats patient.",
    { strategy: { stopLossFraction: 0.015, takeProfitFraction: 0.03, rsiOverbought: 65 }, rails: { maxBuysPerCycle: 4 } }),
  arm(36, "Sniper Elite", "Concentrated conviction into the deepest dips with a wide trail; the highest-variance arm, biggest potential up- or down-side.",
    { strategy: { rsiOversold: 30, takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.05 }, rails: { maxPositionFraction: 0.2, maxOpenPositions: 5 } }),
  arm(37, "Big Voltage", "Pair the best exit mechanism with the most volatile pool; if trailing stops fix the asymmetry, high-vol names should amplify the gain.",
    { strategy: { takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.04 }, pool: "P2" }),
  arm(38, "Steady Eddie", "The conservative, SCHD-adjacent build; most likely to beat the benchmark on a risk-adjusted basis even if raw return is modest.",
    { strategy: { stopLossFraction: 0.02, takeProfitFraction: 0.04 }, rails: { cashBufferFraction: 0.2 }, pool: "P3" }),
  arm(39, "Volatility Native", "Fully volatility-adaptive on entry depth and both exits — let the market's own scale set the parameters.",
    { strategy: { rsiOversold: 30, atrStopMult: 2, atrTakeProfitMult: 4 } }),
  arm(40, "Kitchen Sink v1", "An a priori synthesis of the most promising single knobs; tests whether the best individual changes are additive or interfere.",
    { strategy: { rsiOversold: 30, stopLossFraction: 0.03, takeProfitFraction: null, rsiOverbought: null, trailingStopFraction: 0.04 }, rails: { cashBufferFraction: 0.2 }, pool: "P1" }),
  // #endregion
];

// Display label for an arm: its name, or "Arm N" for the unnamed OFAT arms.
export function armLabel(a: Arm): string {
  return a.name || `Arm ${a.id}`;
}
// #endregion
