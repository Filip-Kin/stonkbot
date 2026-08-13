// #region engine
// One experiment cycle: fetch the shared market data once, then advance all 40
// virtual books. For each arm, in the same order the live bot uses: mechanical
// exits (stop/TP/trailing/ATR) -> discretionary momentum exit -> ranked buys
// under that arm's rails. Equity + closed trades + the book are persisted to
// SQLite so the dashboard can rank the arms and the engine can resume on restart.
import { config } from "../config";
import { getLatestPrice } from "../alpaca";
import {
  appendBenchmark, appendArmEquity, appendArmTrade, loadArmBook, saveArmBook,
  upsertArm, getMeta, setMeta,
} from "../db";
import { ARMS } from "./params";
import { POOLS } from "./pools";
import { fetchMarketData } from "./marketdata";
import { entrySignal, momentumExit } from "./policy";
import { allowedBuyUsd, sectorAtCap, alreadyHolding, dailyLossBreached, equityOf } from "./rails";
import {
  newBook, rollDay, markToMarket, mechanicalExit, closeAt, openAt, type Fill,
} from "./sim";
import type { Book } from "./types";

// US/Eastern trading-day string (matches index.ts).
function usTradingDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Register every arm's definition once (idempotent), for the dashboard + record.
export function registerArms(now: Date): void {
  for (const a of ARMS) {
    upsertArm({
      id: a.id,
      name: a.name,
      hypothesis: a.hypothesis,
      paramsJson: JSON.stringify({ pool: a.pool, strategy: a.strategy, rails: a.rails }),
      createdAt: now.toISOString(),
    });
  }
}

function recordFill(armId: number, fill: Fill, now: Date): void {
  appendArmTrade({ armId, ...fill, closedAt: now.toISOString() });
}

export interface CycleResult { arms: number; buys: number; sells: number; }

export async function runExperimentCycle(now: Date): Promise<CycleResult> {
  const md = await fetchMarketData(now);

  // Sample the benchmark once for the whole experiment (shared with the live
  // bot's benchmark_history), and stamp the experiment's inception references.
  try {
    const bench = await getLatestPrice(config.benchmark);
    if (bench) {
      appendBenchmark({ t: now.toISOString(), price: bench });
      if (!getMeta("exp_bench_inception_price")) setMeta("exp_bench_inception_price", String(bench));
    }
  } catch { /* benchmark sample is observability-only */ }
  if (!getMeta("exp_started_at")) setMeta("exp_started_at", now.toISOString());

  const day = usTradingDay(now);
  let buys = 0;
  let sells = 0;

  for (const arm of ARMS) {
    const raw = loadArmBook(arm.id);
    const book: Book = raw ? (JSON.parse(raw) as Book) : newBook(day);

    // Mark the book, then roll the day (resets loss-cap baseline + halt flag).
    markToMarket(book, md);
    rollDay(book, day, equityOf(book));
    if (dailyLossBreached(book, arm.rails)) book.haltedForDay = true;

    // 1) Mechanical exits: stop-loss / take-profit / trailing / ATR.
    for (const pos of [...book.positions]) {
      const reason = mechanicalExit(pos, arm.strategy, md.get(pos.symbol)?.atr ?? null);
      if (reason) { recordFill(arm.id, closeAt(book, pos, reason), now); sells++; }
    }

    // 2) Discretionary momentum exit (RSI hot, gated by breakeven + min-hold).
    for (const pos of [...book.positions]) {
      const d = md.get(pos.symbol);
      if (!d) continue;
      const reason = momentumExit(d, arm.strategy, pos, now);
      if (reason) { recordFill(arm.id, closeAt(book, pos, reason), now); sells++; }
    }

    // 3) Buys: rank this arm's pool by conviction, fill up to maxBuysPerCycle,
    // re-checking the rails (budget / cash / sector cap / max positions) after
    // each fill against the mutated book — the live bot's simulated-book pattern.
    const candidates = POOLS[arm.pool]
      .map((sym) => md.get(sym))
      .flatMap((d) => (d ? [{ d, sig: entrySignal(d, arm.strategy) }] : []))
      .flatMap((x) => (x.sig ? [{ d: x.d, sig: x.sig }] : []))
      .sort((a, b) => b.sig.score - a.sig.score);

    for (let filled = 0; filled < arm.rails.maxBuysPerCycle; filled++) {
      const budget = allowedBuyUsd(book, arm.rails);
      if (budget <= 0) break;
      const pick = candidates.find(
        (c) => !alreadyHolding(book, c.d.symbol) && !sectorAtCap(book, c.d.sector, arm.rails),
      );
      if (!pick) break;
      const spend = Math.min(budget, book.cash);
      if (spend < arm.rails.minOrderUsd) break;
      openAt(book, pick.d, spend, now);
      buys++;
    }

    // Persist the arm's equity point + book snapshot.
    appendArmEquity(arm.id, now.toISOString(), equityOf(book));
    saveArmBook(arm.id, JSON.stringify(book), now.toISOString());
  }

  return { arms: ARMS.length, buys, sells };
}
// #endregion
