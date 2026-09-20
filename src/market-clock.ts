// #region market clock
// Session timing, in one side-effect-free module. This is deliberately NOT in
// index.ts: that file calls main() at the bottom, so anything importing it to
// reach a helper would start the trading loop. A test doing so would place real
// orders during market hours.
//
// US equity regular hours always begin 09:30 ET. Early-close days shorten the
// end of the session, not the start, so the open needs no calendar lookup.
const OPEN_MINUTES = 9 * 60 + 30;

function etParts(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const num = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: num("hour") % 24, minute: num("minute") }; // some ICU builds emit 24 at midnight
}

// The US/Eastern trading day, e.g. "2026-09-21". A day trade is an open and a
// close inside one of these, so every caller must agree on where the boundary
// falls - hence one definition, shared by the bot and the dashboard.
export function usTradingDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Minutes since the 09:30 ET open, negative before it.
export function minutesSinceOpen(now: Date): number {
  const { hour, minute } = etParts(now);
  return hour * 60 + minute - OPEN_MINUTES;
}
// #endregion
