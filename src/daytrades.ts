// #region pattern-day-trader rail
// FINRA 4210: an account that opens AND closes the same position within one
// session has made a "day trade". Four or more day trades in five rolling
// business days flags the account a pattern day trader, which then requires
// $25,000 of equity or the broker restricts it to closing transactions.
//
// This matters here because Alpaca does NOT offer cash accounts — every account
// is a margin account, and one under $2,000 is simply a "limited margin"
// account at 1x buying power. Setting max_margin_multiplier to 1 does not
// exempt it: PDT keys off the account TYPE, not whether you borrow. So on the
// $200 book the bot gets three day trades per five sessions, full stop.
//
// The rail is built out of two facts:
//   1. A day trade can only be created by an entry. Block new buys once the
//      budget is spent and the count cannot rise.
//   2. Closing a position opened in an EARLIER session is not a day trade. So
//      an exit that would breach the budget is deferred, not cancelled — it
//      fires on the next session's first cycle, when it is free.
//
// Alpaca's paper account object returns null for `daytrade_count`, so the bot
// keeps its own ledger and uses the broker's number only when it is present
// (the broker is authoritative; our count is the fallback and the simulator).
import { db } from "./db";
import { config } from "./config";
import type { Account, Position } from "./alpaca";

export type ExitKind = "stop" | "discretionary";

// #region ledger
// Stamp a newly opened position with the session it was opened in.
export function recordOpen(symbol: string, tradingDay: string, nowIso: string): void {
  db().query(
    `INSERT INTO position_opens (symbol, opened_day, opened_at) VALUES (?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET opened_day = excluded.opened_day, opened_at = excluded.opened_at`,
  ).run(symbol, tradingDay, nowIso);
}

export function openedDay(symbol: string): string | null {
  return db().query<{ opened_day: string }, [string]>(
    "SELECT opened_day FROM position_opens WHERE symbol = ?",
  ).get(symbol)?.opened_day ?? null;
}

// Close out the ledger row. Returns true if this close was a day trade, and
// records it so it counts against the rolling budget.
export function recordClose(symbol: string, tradingDay: string, nowIso: string): boolean {
  const opened = openedDay(symbol);
  db().query("DELETE FROM position_opens WHERE symbol = ?").run(symbol);
  if (opened !== tradingDay) return false;
  db().query(
    "INSERT INTO day_trades (symbol, trading_day, recorded_at) VALUES (?, ?, ?)",
  ).run(symbol, tradingDay, nowIso);
  return true;
}

// Reconcile the ledger against the broker's actual book. A held symbol with no
// ledger row (first run after this rail shipped, or a manual fill) is stamped
// as opened TODAY: that is the conservative direction, since it makes the bot
// defer that position's exit rather than risk an uncounted day trade. Rows for
// symbols no longer held are dropped.
export function syncOpens(positions: Position[], tradingDay: string, nowIso: string): void {
  const held = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol));
  const known = db().query<{ symbol: string }, []>("SELECT symbol FROM position_opens").all();
  for (const row of known) {
    if (!held.has(row.symbol)) db().query("DELETE FROM position_opens WHERE symbol = ?").run(row.symbol);
  }
  const knownSet = new Set(known.map((r) => r.symbol));
  for (const sym of held) {
    if (!knownSet.has(sym)) recordOpen(sym, tradingDay, nowIso);
  }
}
// #endregion

// #region rolling window
// The last N sessions the bot actually observed, newest first. Derived from the
// equity curve, which gets a row every cycle the market is open, so it tracks
// real trading sessions and skips weekends and holidays without a calendar.
export function recentSessions(limit = 5): string[] {
  return db().query<{ day: string }, [number]>(
    `SELECT DISTINCT substr(t, 1, 10) AS day FROM equity_history ORDER BY day DESC LIMIT ?`,
  ).all(limit).map((r) => r.day);
}

// Day trades used inside the rolling five-session window. Prefers the broker's
// own count when the account object carries one.
export function dayTradesUsed(tradingDay: string, account?: Account): number {
  if (account?.daytrade_count !== undefined && account.daytrade_count !== null) {
    return account.daytrade_count;
  }
  const sessions = new Set(recentSessions(5));
  sessions.add(tradingDay); // today may not have an equity row yet on the first cycle
  const rows = db().query<{ trading_day: string }, []>(
    "SELECT trading_day FROM day_trades ORDER BY id DESC LIMIT 200",
  ).all();
  return rows.filter((r) => sessions.has(r.trading_day)).length;
}
// #endregion

// #region policy
// Does the PDT rail apply at all? It does not above the $25,000 equity line,
// and it can be switched off entirely for a margin-irrelevant paper run.
export function pdtApplies(account: Account): boolean {
  if (!config.risk.pdtGuard) return false;
  if (account.pattern_day_trader === true) return true; // already flagged: stay conservative
  return account.equity < config.risk.pdtEquityFloor;
}

export interface DayTradeStatus {
  applies: boolean;
  used: number;
  max: number;
  remaining: number;
}

export function dayTradeStatus(account: Account, tradingDay: string): DayTradeStatus {
  const applies = pdtApplies(account);
  const max = config.risk.maxDayTradesPer5Days;
  const used = applies ? dayTradesUsed(tradingDay, account) : 0;
  return { applies, used, max, remaining: Math.max(0, max - used) };
}

// May this position be closed right now? A close is free unless it would be a
// day trade. Discretionary exits (the RSI momentum exit) must leave
// `dayTradeStopReserve` trades unspent, so a hard stop-loss can always be taken
// on a position opened the same session. Deferring is safe: the position is
// still held, and the same exit fires next session at no PDT cost.
export function mayExit(
  symbol: string,
  tradingDay: string,
  kind: ExitKind,
  status: DayTradeStatus,
): { allowed: true } | { allowed: false; reason: string } {
  if (!status.applies) return { allowed: true };
  if (openedDay(symbol) !== tradingDay) return { allowed: true }; // opened earlier: not a day trade
  const reserve = kind === "stop" ? 0 : config.risk.dayTradeStopReserve;
  if (status.remaining > reserve) return { allowed: true };
  return {
    allowed: false,
    reason: kind === "stop"
      ? `day-trade budget spent (${status.used}/${status.max}); holding overnight instead of tripping PDT`
      : `day-trade budget down to the stop reserve (${status.used}/${status.max}); deferring the momentum exit`,
  };
}

// May a NEW position be opened? Entries are the only way to create a day trade,
// so this is the valve that keeps the count bounded.
export function mayOpen(status: DayTradeStatus): { allowed: true } | { allowed: false; reason: string } {
  if (!status.applies) return { allowed: true };
  if (status.remaining > 0) return { allowed: true };
  return { allowed: false, reason: `day-trade budget spent (${status.used}/${status.max}); no new entries` };
}
// #endregion
// #endregion
