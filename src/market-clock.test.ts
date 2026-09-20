// #region market clock tests
// minutesSinceOpen decides when indicator-driven trades are allowed to start, so
// it has to be right across the DST boundary and around midnight UTC. All cases
// are stated in UTC, which is what the container's clock actually hands it.
import { test, expect } from "bun:test";
import { minutesSinceOpen } from "./market-clock";

const at = (iso: string) => minutesSinceOpen(new Date(iso));

test("EDT: the open is zero, and the warm-up line falls where expected", () => {
  expect(at("2026-09-21T13:30:00Z")).toBe(0);    // 09:30 ET
  expect(at("2026-09-21T13:59:00Z")).toBe(29);   // still cold at the default 30
  expect(at("2026-09-21T14:00:00Z")).toBe(30);   // warm
  expect(at("2026-09-21T20:00:00Z")).toBe(390);  // 16:00 ET close
});

test("EST: the same wall-clock open, an hour later in UTC", () => {
  expect(at("2026-12-07T14:30:00Z")).toBe(0);    // 09:30 ET, DST over
  expect(at("2026-12-07T15:00:00Z")).toBe(30);
});

test("pre-open is negative, so a cold check can never read as warm", () => {
  expect(at("2026-09-21T13:00:00Z")).toBe(-30);  // 09:00 ET
  expect(at("2026-09-21T11:30:00Z")).toBe(-120); // 07:30 ET
});

test("midnight ET does not wrap to a huge positive number", () => {
  // Some ICU builds emit hour "24" at midnight with hour12:false; that would
  // read as 870 minutes past the open and let a 00:00 cycle trade.
  expect(at("2026-09-21T04:00:00Z")).toBe(-570); // 00:00 ET
  expect(at("2026-09-21T04:30:00Z")).toBe(-540); // 00:30 ET
});
// #endregion
