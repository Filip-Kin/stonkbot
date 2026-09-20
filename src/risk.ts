// #region risk
// Hard risk rails enforced every cycle. The strategy proposes; risk disposes.
import { config } from "./config";
import type { Account, Position } from "./alpaca";
import type { BotState } from "./state";

export interface RiskContext {
  account: Account;
  positions: Position[];
  state: BotState;
  // Set when the pattern-day-trader rail has spent its budget: no new entries,
  // because an entry is the only thing that can create another day trade.
  // See daytrades.ts.
  entriesBlocked?: boolean;
}

// Forced exits that override any strategy signal: hard stop-loss, an optional
// fixed take-profit, and an optional trailing stop. Order mirrors the
// experiment's sim.ts mechanicalExit: cut losers first, then a fixed target,
// then give-back on the trail. `highWater` is the per-symbol peak price since
// entry (index.ts maintains it in BotState, since Alpaca positions carry no
// peak); the trail only arms once a position has gone green.
export function forcedExits(
  positions: Position[],
  highWater: Record<string, number> = {},
): { symbol: string; reason: string }[] {
  const out: { symbol: string; reason: string }[] = [];
  const { stopLossFraction, takeProfitFraction, trailingStopFraction } = config.risk;
  for (const p of positions) {
    // 1) Hard stop-loss: cut a loser no matter what.
    if (p.unrealized_plpc <= -stopLossFraction) {
      out.push({ symbol: p.symbol, reason: `stop-loss hit (${(p.unrealized_plpc * 100).toFixed(1)}%)` });
      continue;
    }
    // 2) Fixed take-profit, when configured (null under the Anti-Asymmetry model).
    if (takeProfitFraction !== null && p.unrealized_plpc >= takeProfitFraction) {
      out.push({ symbol: p.symbol, reason: `take-profit hit (${(p.unrealized_plpc * 100).toFixed(1)}%)` });
      continue;
    }
    // 3) Trailing stop: only once green (high-water above entry), exit if price
    //    has given back the trail width from the peak.
    if (trailingStopFraction !== null) {
      const hw = highWater[p.symbol];
      if (hw !== undefined && hw > p.avg_entry_price && p.current_price <= hw * (1 - trailingStopFraction)) {
        out.push({ symbol: p.symbol, reason: `trailing stop (${(p.unrealized_plpc * 100).toFixed(1)}%)` });
      }
    }
  }
  return out;
}

// Is the daily loss cap breached? If so, no new buys today.
export function dailyLossBreached(ctx: RiskContext): boolean {
  if (ctx.state.dayOpenEquity <= 0) return false;
  const drawdown = (ctx.state.dayOpenEquity - ctx.account.equity) / ctx.state.dayOpenEquity;
  return drawdown >= config.risk.dailyLossCapFraction;
}

// The smallest buy worth placing on THIS book. A flat dollar floor is wrong for
// a small account: at $150 of equity a full-size 12% position is $18, so a flat
// $20 floor would reject every possible buy and the bot would sit in cash
// forever. The floor therefore scales with the per-position cap and only bites
// as an absolute number once the book is large enough for that to be the
// tighter constraint.
export function effectiveMinOrderUsd(equity: number): number {
  const r = config.risk;
  const perPositionCap = equity * r.maxPositionFraction;
  return Math.max(r.absoluteMinOrderUsd, Math.min(r.minOrderUsd, perPositionCap * r.minOrderFractionOfCap));
}

// How much can we spend on a NEW position right now, respecting per-position
// cap, cash buffer, and max open positions? Returns 0 if a buy isn't allowed.
export function allowedBuyUsd(ctx: RiskContext): number {
  const r = config.risk;
  if (!config.tradingEnabled) return 0;
  if (ctx.state.haltedForDay) return 0;
  if (dailyLossBreached(ctx)) return 0;
  if (ctx.entriesBlocked) return 0;
  if (ctx.positions.length >= r.maxOpenPositions) return 0;

  const equity = ctx.account.equity;
  const perPositionCap = equity * r.maxPositionFraction;
  const investableCash = ctx.account.cash - equity * r.cashBufferFraction;
  // Cash, not `non_marginable_buying_power`. That field is buying power for
  // NON-MARGINABLE securities, not settled cash, and on a multiplier-1 account it
  // sits at 0 while ordinary buying power is the full balance - capping on it
  // pinned every budget to $0 and the bot would never have opened a position.
  // The no-leverage guarantee comes from the broker lock (max_margin_multiplier=1,
  // so buying_power == cash) plus the simCash floor in index.ts, not from here.
  const budget = Math.min(perPositionCap, investableCash);

  if (budget < effectiveMinOrderUsd(equity)) return 0;
  return Math.floor(budget * 100) / 100;
}

export function alreadyHolding(positions: Position[], symbol: string): boolean {
  return positions.some((p) => p.symbol === symbol && p.qty > 0);
}

// Is this symbol's sector already at the per-sector position cap? Prevents the
// book from clustering (e.g. three healthcare names on a sector-wide dip).
export function sectorAtCap(positions: Position[], symbol: string): boolean {
  const sector = config.sectors[symbol];
  if (!sector) return false; // untagged symbol => no sector limit
  const held = positions.filter((p) => p.qty > 0 && config.sectors[p.symbol] === sector).length;
  return held >= config.risk.maxPerSector;
}
// #endregion
