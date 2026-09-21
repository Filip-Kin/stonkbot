// #region daytrades tests
// Regression cover for the pattern-day-trader rail. This rail is the only thing
// standing between a $200 book and a 90-day trading restriction, so the cases
// below are the ones that must never silently change: what counts as a day
// trade, when an exit is deferred instead of taken, and when entries stop.
// Runs against a throwaway DB via STONKBOT_DATA_DIR.
import { test, expect, beforeAll } from "bun:test";

// The scratch data dir is set by src/test-setup.ts (bunfig.toml preload), which
// has to run before db.ts memoises its handle.
process.env.PDT_GUARD = "true";

import { db } from "./db";
import * as dt from "./daytrades";
import type { Account, Position } from "./alpaca";

const TODAY = "2026-09-11";
const YESTERDAY = "2026-09-10";
const acct = (over: Partial<Account> = {}): Account => ({
  equity: 200, cash: 200, buying_power: 200, ...over,
});
const pos = (symbol: string): Position => ({
  symbol, qty: 1, avg_entry_price: 1, current_price: 1,
  market_value: 1, unrealized_pl: 0, unrealized_plpc: 0,
});

beforeAll(() => {
  db().query("DELETE FROM day_trades").run();
  db().query("DELETE FROM position_opens").run();
  db().query("DELETE FROM equity_history").run();
  for (const d of [YESTERDAY, TODAY]) {
    db().query("INSERT OR IGNORE INTO equity_history (t, equity) VALUES (?, ?)").run(`${d}T14:00:00Z`, 200);
  }
});

test("a position opened in an earlier session is not a day trade when closed", () => {
  dt.recordOpen("AAPL", YESTERDAY, "x");
  expect(dt.recordClose("AAPL", TODAY, "x")).toBe(false);
  expect(dt.dayTradesUsed(TODAY, acct())).toBe(0);
});

test("a same-session round trip counts against the budget", () => {
  dt.recordOpen("MSFT", TODAY, "x");
  expect(dt.recordClose("MSFT", TODAY, "x")).toBe(true);
  expect(dt.dayTradesUsed(TODAY, acct())).toBe(1);
});

test("the stop reserve blocks a discretionary exit before it blocks a stop", () => {
  dt.recordOpen("NVDA", TODAY, "x");
  dt.recordClose("NVDA", TODAY, "x"); // 2 used, 1 left, reserve is 1
  const st = dt.dayTradeStatus(acct(), TODAY);
  expect(st.used).toBe(2);
  dt.recordOpen("CRM", TODAY, "x");
  expect(dt.mayExit("CRM", TODAY, "discretionary", st).allowed).toBe(false);
  expect(dt.mayExit("CRM", TODAY, "stop", st).allowed).toBe(true);
  expect(dt.mayOpen(st).allowed).toBe(true);
});

test("a spent budget stops entries and defers same-session stops, not overnight exits", () => {
  dt.recordOpen("V", TODAY, "x");
  dt.recordClose("V", TODAY, "x"); // 3 used
  const st = dt.dayTradeStatus(acct(), TODAY);
  expect(st.used).toBe(3);
  expect(st.remaining).toBe(0);
  expect(dt.mayOpen(st).allowed).toBe(false);
  expect(dt.mayExit("CRM", TODAY, "stop", st).allowed).toBe(false); // opened today: defer
  dt.recordOpen("KO", YESTERDAY, "x");
  expect(dt.mayExit("KO", TODAY, "stop", st).allowed).toBe(true); // opened earlier: free
});

test("the rail switches itself off above the $25k PDT floor", () => {
  const st = dt.dayTradeStatus(acct({ equity: 30_000 }), TODAY);
  expect(st.applies).toBe(false);
  expect(dt.mayOpen(st).allowed).toBe(true);
});

test("syncOpens stamps unknown holdings as today and prunes what is no longer held", () => {
  dt.syncOpens([pos("KO"), pos("TSLA")], TODAY, "x");
  expect(dt.openedDay("TSLA")).toBe(TODAY); // conservative: assume same session
  expect(dt.openedDay("KO")).toBe(YESTERDAY); // existing stamp preserved
  expect(dt.openedDay("CRM")).toBe(null); // no longer held
});

test("the broker's own day-trade count wins when the account carries one", () => {
  expect(dt.dayTradesUsed(TODAY, acct({ daytrade_count: 0 }))).toBe(0);
});
// #endregion

// #region budget freshness
// The cycle used to read the budget once and reuse it. recordClose writes during
// the exit loops, so a cached value goes stale mid-cycle and lets a fourth day
// trade through - the exact thing the rail exists to prevent.
test("the budget reflects a close recorded moments earlier", () => {
  db().query("DELETE FROM day_trades").run();
  db().query("DELETE FROM position_opens").run();
  const a = acct();
  expect(dt.dayTradeStatus(a, TODAY).remaining).toBe(3);

  dt.recordOpen("AAPL", TODAY, "x");
  dt.recordClose("AAPL", TODAY, "x");
  expect(dt.dayTradeStatus(a, TODAY).remaining).toBe(2); // not 3

  dt.recordOpen("MSFT", TODAY, "x");
  dt.recordClose("MSFT", TODAY, "x");
  dt.recordOpen("NVDA", TODAY, "x");
  dt.recordClose("NVDA", TODAY, "x");
  const after = dt.dayTradeStatus(a, TODAY);
  expect(after.used).toBe(3);
  expect(dt.mayOpen(after).allowed).toBe(false); // entries stop, count cannot rise
});
// #endregion
