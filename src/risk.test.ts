// #region risk tests
// The order floor is the rail that decides whether a shrinking book keeps
// trading or freezes. It froze the $200 book below ~$167 of equity once; these
// cases pin the fix.
import { test, expect } from "bun:test";
import { effectiveMinOrderUsd, allowedBuyUsd, type RiskContext } from "./risk";
import { config } from "./config";
import type { Account, Position } from "./alpaca";
import type { BotState } from "./state";

const cap = (equity: number) => equity * config.risk.maxPositionFraction;

test("a big book keeps the flat $20 dust floor", () => {
  expect(effectiveMinOrderUsd(1000)).toBe(20); // cap $120, 80% of it is $96 > $20
  expect(effectiveMinOrderUsd(10_000)).toBe(20);
});

test("the floor never blocks a full-size position on a small book", () => {
  for (const equity of [200, 167, 150, 100, 50, 20]) {
    expect(effectiveMinOrderUsd(equity)).toBeLessThanOrEqual(cap(equity));
  }
});

test("the $167 freeze is gone: a 12% position still clears the floor", () => {
  const equity = 150; // cap $18, under the old flat $20 floor
  expect(cap(equity)).toBeLessThan(config.risk.minOrderUsd);
  expect(effectiveMinOrderUsd(equity)).toBeCloseTo(14.4, 5);
});

test("the floor never drops below Alpaca's fractional notional minimum", () => {
  expect(effectiveMinOrderUsd(1)).toBe(config.risk.absoluteMinOrderUsd);
  expect(effectiveMinOrderUsd(0)).toBe(config.risk.absoluteMinOrderUsd);
});
// #endregion

// #region buy budget
// A funded $200 book must produce a real budget. The first live cutover pinned it
// to $0 because the rail capped on non_marginable_buying_power, which Alpaca
// reports as 0 on a multiplier-1 account even with the full balance available.
const acct = (over: Partial<Account> = {}): Account => ({
  equity: 200, cash: 200, buying_power: 200, ...over,
});
const state = (over: Partial<BotState> = {}): BotState => ({
  tradingDay: "2026-09-21", dayOpenEquity: 200, haltedForDay: false,
  inceptionEquity: 200, benchmarkInceptionPrice: 34, buysToday: 0, sellsToday: 0,
  realizedPlToday: 0, closeSummarySentDay: "", highWater: {}, ...over,
} as BotState);
const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  account: acct(), positions: [] as Position[], state: state(), ...over,
});

test("a funded $200 book budgets a full 12% position", () => {
  expect(allowedBuyUsd(ctx())).toBeCloseTo(24, 2);
});

test("the cash buffer, not the broker's buying-power fields, is what throttles", () => {
  // 7 positions open leaves $32 cash. The 10% buffer reserves $20, so $12 is
  // spendable - under the $19.20 order floor, so the 8th position is refused.
  // This is the state the live book sat in all last week.
  expect(allowedBuyUsd(ctx({ account: acct({ cash: 32 }) }))).toBe(0);
  // $45 clears it: $25 spendable, capped back down to the 12% position size.
  expect(allowedBuyUsd(ctx({ account: acct({ cash: 45 }) }))).toBeCloseTo(24, 2);
});

test("a spent day-trade budget blocks the buy outright", () => {
  expect(allowedBuyUsd(ctx({ entriesBlocked: true }))).toBe(0);
});

test("a halted day blocks the buy outright", () => {
  expect(allowedBuyUsd(ctx({ state: state({ haltedForDay: true }) }))).toBe(0);
});
// #endregion

// #region context inheritance
// The buy loop re-derives a context per fill (simulated cash, simulated book).
// It once rebuilt that object literally, which dropped entriesBlocked and made
// both the PDT entry block and the open-delay gate no-ops on real money. Any
// derived context must inherit the gates.
test("a derived buy context keeps the gates from its parent", () => {
  const parent = ctx({ entriesBlocked: true });
  const derived: RiskContext = { ...parent, account: acct({ cash: 176 }), positions: [] };
  expect(derived.entriesBlocked).toBe(true);
  expect(allowedBuyUsd(derived)).toBe(0);
});

test("rebuilding a derived context from parts loses them - the shape of the bug", () => {
  const parent = ctx({ entriesBlocked: true });
  const rebuilt: RiskContext = {
    account: parent.account, positions: parent.positions, state: parent.state,
  };
  expect(rebuilt.entriesBlocked).toBeUndefined();
  expect(allowedBuyUsd(rebuilt)).toBeCloseTo(24, 2); // would have bought
});
// #endregion
