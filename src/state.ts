// #region state
// Tiny JSON-file persistence for day-level tracking: the day's opening equity
// (for the daily loss cap), a halt flag, and an equity history for the
// "line go up" dashboard.
import { mkdirSync } from "node:fs";
import type { Signal } from "./strategy";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
const STATE_PATH = `${DATA_DIR}state.json`;
const SIGNALS_PATH = `${DATA_DIR}signals.json`;
const NEWS_CACHE_PATH = `${DATA_DIR}news-cache.json`;

export interface BotState {
  tradingDay: string; // YYYY-MM-DD in US/Eastern
  dayOpenEquity: number;
  haltedForDay: boolean;
  // Benchmark scoring: equity and benchmark price captured at first run.
  inceptionEquity: number;
  benchmarkInceptionPrice: number;
  // Per-day activity counters, reset by rollDayIfNeeded, for the market-close
  // summary push. buys/sells = orders placed today; realizedPlToday = summed $
  // P/L of positions closed today.
  buysToday: number;
  sellsToday: number;
  realizedPlToday: number;
  // The trading day whose close summary has already been sent, so the summary
  // fires exactly once after the market closes (not on every closed cycle).
  closeSummarySentDay: string;
}

const DEFAULT_STATE: BotState = {
  tradingDay: "",
  dayOpenEquity: 0,
  haltedForDay: false,
  inceptionEquity: 0,
  benchmarkInceptionPrice: 0,
  buysToday: 0,
  sellsToday: 0,
  realizedPlToday: 0,
  closeSummarySentDay: "",
};

export async function loadState(): Promise<BotState> {
  try {
    const f = Bun.file(STATE_PATH);
    if (!(await f.exists())) return { ...DEFAULT_STATE };
    // Merge onto defaults so a state file written by an older build (missing the
    // newer counter/flag fields) still loads with sane zeros instead of undefined.
    return { ...DEFAULT_STATE, ...((await f.json()) as Partial<BotState>) } as BotState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(state: BotState): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2));
}

// #region signals snapshot
// The most recent per-symbol strategy evaluation, written by the bot each
// cycle and read by the dashboard so the watchlist can show, live, how every
// name measures up against the buy criteria. Purely for observability; the
// bot never reads it back.
export interface SignalsSnapshot {
  t: string; // ISO timestamp of the cycle that produced it
  signals: Signal[];
}

export async function saveSignals(t: string, signals: Signal[]): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await Bun.write(SIGNALS_PATH, JSON.stringify({ t, signals } satisfies SignalsSnapshot, null, 2));
}

export async function loadSignals(): Promise<SignalsSnapshot | null> {
  try {
    const f = Bun.file(SIGNALS_PATH);
    if (!(await f.exists())) return null;
    return (await f.json()) as SignalsSnapshot;
  } catch {
    return null;
  }
}
// #endregion

// #region news cache
// Per-symbol news summary for the watchlist. Kept cheap: near-buy names refresh
// their headlines every cycle, everything else once per trading day, and the AI
// sentiment is only re-run when the headline set changes (see `sig`). See the
// news block in index.ts.
export interface NewsCacheEntry {
  count: number;
  latest: string | null;
  headlines?: string[]; // top few headlines, for the watchlist news card
  sentiment?: "great" | "positive" | "neutral" | "negative" | "terrible";
  day: string; // ET trading day headlines were last fetched
  sig: string; // signature of the headlines the sentiment was classified from
}
export type NewsCache = Record<string, NewsCacheEntry>;

export async function loadNewsCache(): Promise<NewsCache> {
  try {
    const f = Bun.file(NEWS_CACHE_PATH);
    if (!(await f.exists())) return {};
    return (await f.json()) as NewsCache;
  } catch {
    return {};
  }
}

export async function saveNewsCache(cache: NewsCache): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  await Bun.write(NEWS_CACHE_PATH, JSON.stringify(cache, null, 2));
}
// #endregion

// Roll the trading day: reset the loss cap and halt flag when a new US
// trading day begins. `today` and `nowIso` are passed in so this stays pure
// of wall-clock reads (see scheduler in index.ts).
export function rollDayIfNeeded(
  state: BotState,
  today: string,
  equity: number,
): BotState {
  if (state.tradingDay === today) return state;
  return {
    ...state,
    tradingDay: today,
    dayOpenEquity: equity,
    haltedForDay: false,
    // Fresh day: zero the activity counters the close summary reports on.
    buysToday: 0,
    sellsToday: 0,
    realizedPlToday: 0,
  };
}
// #endregion
