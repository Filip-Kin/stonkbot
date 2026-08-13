// #region risk
// Hard risk rails enforced every cycle. The strategy proposes; risk disposes.
import { config } from "./config";
import type { Account, Position } from "./alpaca";
import type { BotState } from "./state";

export interface RiskContext {
  account: Account;
  positions: Position[];
  state: BotState;
}

// Forced exits that override any strategy signal: stop-loss and take-profit.
export function forcedExits(positions: Position[]): { symbol: string; reason: string }[] {
  const out: { symbol: string; reason: string }[] = [];
  for (const p of positions) {
    if (p.unrealized_plpc <= -config.risk.stopLossFraction) {
      out.push({ symbol: p.symbol, reason: `stop-loss hit (${(p.unrealized_plpc * 100).toFixed(1)}%)` });
    } else if (p.unrealized_plpc >= config.risk.takeProfitFraction) {
      out.push({ symbol: p.symbol, reason: `take-profit hit (${(p.unrealized_plpc * 100).toFixed(1)}%)` });
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

// How much can we spend on a NEW position right now, respecting per-position
// cap, cash buffer, and max open positions? Returns 0 if a buy isn't allowed.
export function allowedBuyUsd(ctx: RiskContext): number {
  const r = config.risk;
  if (!config.tradingEnabled) return 0;
  if (ctx.state.haltedForDay) return 0;
  if (dailyLossBreached(ctx)) return 0;
  if (ctx.positions.length >= r.maxOpenPositions) return 0;

  const equity = ctx.account.equity;
  const perPositionCap = equity * r.maxPositionFraction;
  const investableCash = ctx.account.cash - equity * r.cashBufferFraction;
  const budget = Math.min(perPositionCap, investableCash);

  if (budget < r.minOrderUsd) return 0;
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
