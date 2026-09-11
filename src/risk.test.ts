// #region risk tests
// The order floor is the rail that decides whether a shrinking book keeps
// trading or freezes. It froze the $200 book below ~$167 of equity once; these
// cases pin the fix.
import { test, expect } from "bun:test";
import { effectiveMinOrderUsd } from "./risk";
import { config } from "./config";

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
