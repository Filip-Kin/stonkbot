// #region rails
// The risk rails, parameterized per arm. A structural clone of risk.ts, but it
// takes RailsParams + a virtual Book instead of the global config + a live
// Alpaca account. Same semantics: the policy proposes, the rails dispose.
import type { RailsParams } from "./params";
import type { Book } from "./types";

// Current mark-to-market equity of a virtual book.
export function equityOf(book: Book): number {
  return book.cash + book.positions.reduce((s, p) => s + p.qty * p.price, 0);
}

// Has this arm breached its daily loss cap? If so, no new buys until it rolls.
export function dailyLossBreached(book: Book, p: RailsParams): boolean {
  if (book.dayOpenEquity <= 0) return false;
  const drawdown = (book.dayOpenEquity - equityOf(book)) / book.dayOpenEquity;
  return drawdown >= p.dailyLossCapFraction;
}

// How much can this arm spend on a NEW position right now, respecting the
// per-position cap, cash buffer, and max open positions? 0 if a buy isn't
// allowed. Mirrors risk.allowedBuyUsd.
export function allowedBuyUsd(book: Book, p: RailsParams): number {
  if (book.haltedForDay) return 0;
  if (dailyLossBreached(book, p)) return 0;
  if (book.positions.length >= p.maxOpenPositions) return 0;

  const equity = equityOf(book);
  const perPositionCap = equity * p.maxPositionFraction;
  const investableCash = book.cash - equity * p.cashBufferFraction;
  const budget = Math.min(perPositionCap, investableCash);

  if (budget < p.minOrderUsd) return 0;
  return Math.floor(budget * 100) / 100;
}

export function alreadyHolding(book: Book, symbol: string): boolean {
  return book.positions.some((pos) => pos.symbol === symbol && pos.qty > 0);
}

// Is this symbol's sector already at the per-sector cap? Infinite cap = never.
export function sectorAtCap(book: Book, sector: string, p: RailsParams): boolean {
  if (!Number.isFinite(p.maxPerSector)) return false;
  const held = book.positions.filter((pos) => pos.qty > 0 && pos.sector === sector).length;
  return held >= p.maxPerSector;
}
// #endregion
