// #region experiment types
// Shared value types for the multi-arm engine. The market data (bars + news) is
// fetched ONCE per cycle and fanned out to every arm; only the virtual book
// diverges per arm.
import type { Bar } from "../alpaca";

// The AI adverse-catalyst verdict for a symbol this cycle (arm-invariant: the
// same headlines yield the same verdict regardless of which arm reads them).
export interface NewsVerdict {
  blockBuy: boolean;
  reason: string;
  count: number;
}

// All shared market inputs for one symbol this cycle.
export interface SymbolData {
  symbol: string;
  sector: string;
  price: number; // canonical price = last intraday close (deterministic fills)
  intradayCloses: number[];
  dailyCloses: number[];
  atr: number | null; // ATR on daily bars, for the volatility-aware arms
  news: NewsVerdict;
}

export type MarketData = Map<string, SymbolData>;

// One open lot in an arm's virtual portfolio. We own these records (unlike
// Alpaca positions), so entry time and the running high-water mark are free —
// which is exactly what trailing stops and the min-hold gate need.
export interface SimPosition {
  symbol: string;
  sector: string;
  qty: number;
  entryPrice: number;
  entryTime: string; // ISO
  price: number; // last mark
  highWater: number; // highest mark seen since entry (for the trailing stop)
}

// An arm's persisted virtual portfolio + day tracking.
export interface Book {
  cash: number;
  positions: SimPosition[];
  dayOpenEquity: number;
  haltedForDay: boolean;
  tradingDay: string; // ET day the book last rolled
}
// #endregion
