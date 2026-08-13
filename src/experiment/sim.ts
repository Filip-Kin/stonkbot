// #region sim
// The virtual portfolio: mark-to-market, the mechanical exits (stop-loss,
// take-profit, trailing stop, ATR-scaled variants), and deterministic fills.
// The book owns entry price, entry time, and the running high-water mark, so
// the trailing/ATR/min-hold mechanisms the live bot can't do (Alpaca positions
// carry no entry timestamp) are trivial here.
//
// Fill model: buys and sells transact at the symbol's canonical price (the last
// intraday close). Zero slippage in round one — optimistic, but identical for
// every arm, so any difference in results is pure strategy, not fill luck.
import type { StrategyParams } from "./params";
import type { Book, SimPosition, SymbolData } from "./types";
import { sectorOf } from "./pools";

// Every arm starts the experiment with this stake, matching Filip's real $1000
// in SCHD so the scoreboard is a head-to-head vs the actual benchmark holding.
export const INITIAL_EQUITY = 1000;

export function newBook(tradingDay: string): Book {
  return {
    cash: INITIAL_EQUITY,
    positions: [],
    dayOpenEquity: INITIAL_EQUITY,
    haltedForDay: false,
    tradingDay,
  };
}

// Roll the book into a new trading day: reset the loss-cap baseline + halt flag.
export function rollDay(book: Book, today: string, equity: number): void {
  if (book.tradingDay === today) return;
  book.tradingDay = today;
  book.dayOpenEquity = equity;
  book.haltedForDay = false;
}

// Update every held lot's mark + high-water from the shared prices.
export function markToMarket(book: Book, md: Map<string, SymbolData>): void {
  for (const pos of book.positions) {
    const d = md.get(pos.symbol);
    if (!d) continue;
    pos.price = d.price;
    if (d.price > pos.highWater) pos.highWater = d.price;
  }
}

export interface Fill {
  symbol: string;
  sector: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  value: number;
  realizedPl: number;
  realizedPlPct: number;
  reason: string;
}

// Mechanical exit check for one held position. Order matters: the hard stop is
// evaluated first (cut losers no matter what), then the target, then the trail.
// Returns a reason string to exit, or null to hold.
export function mechanicalExit(pos: SimPosition, p: StrategyParams, atr: number | null): string | null {
  const pnlPct = (pos.price - pos.entryPrice) / pos.entryPrice;

  // Stop-loss: ATR-scaled if the arm uses it, else the flat fraction.
  if (p.atrStopMult !== null && atr !== null) {
    if (pos.price <= pos.entryPrice - p.atrStopMult * atr) {
      return `ATR stop hit (${(pnlPct * 100).toFixed(1)}%)`;
    }
  } else if (pnlPct <= -p.stopLossFraction) {
    return `stop-loss hit (${(pnlPct * 100).toFixed(1)}%)`;
  }

  // Take-profit: ATR-scaled, flat, or none (trailing-only arms).
  if (p.atrTakeProfitMult !== null && atr !== null) {
    if (pos.price >= pos.entryPrice + p.atrTakeProfitMult * atr) {
      return `ATR take-profit (${(pnlPct * 100).toFixed(1)}%)`;
    }
  } else if (p.takeProfitFraction !== null && pnlPct >= p.takeProfitFraction) {
    return `take-profit hit (${(pnlPct * 100).toFixed(1)}%)`;
  }

  // Trailing stop: only once the position has actually gone green (otherwise the
  // flat stop governs the downside), then exit if it gives back the trail width.
  if (p.trailingStopFraction !== null && pos.highWater > pos.entryPrice) {
    if (pos.price <= pos.highWater * (1 - p.trailingStopFraction)) {
      return `trailing stop (${(pnlPct * 100).toFixed(1)}%)`;
    }
  }

  return null;
}

// Close a held position at its current mark, returning the realized Fill and
// removing it from the book (cash credited).
export function closeAt(book: Book, pos: SimPosition, reason: string): Fill {
  const exitPrice = pos.price;
  const value = pos.qty * exitPrice;
  const realizedPl = pos.qty * (exitPrice - pos.entryPrice);
  const realizedPlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
  book.cash += value;
  book.positions = book.positions.filter((x) => x !== pos);
  return {
    symbol: pos.symbol,
    sector: pos.sector,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice,
    value,
    realizedPl,
    realizedPlPct,
    reason,
  };
}

// Open a new lot: spend `usd` on `symbol` at its price, fractional shares.
export function openAt(book: Book, d: SymbolData, usd: number, now: Date): void {
  const qty = usd / d.price;
  book.cash -= usd;
  book.positions.push({
    symbol: d.symbol,
    sector: sectorOf(d.symbol),
    qty,
    entryPrice: d.price,
    entryTime: now.toISOString(),
    price: d.price,
    highWater: d.price,
  });
}
// #endregion
