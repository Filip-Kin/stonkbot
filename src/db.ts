// #region db
// SQLite persistence for the append-only / growing data: the equity curve, the
// closed-trade log, and the daily close summaries. Uses Bun's built-in
// `bun:sqlite` (no external dependency, no daemon). The small overwrite-latest
// singletons (state.json, signals.json, news-cache.json) stay as JSON in
// state.ts — SQLite buys us nothing there.
//
// Why SQLite for these three: unbounded, queryable history (the JSON versions
// silently capped at 5000 equity points / 2000 trades and dropped the oldest),
// and WAL-mode atomic reads so the read-only dashboard process can never catch
// a half-written file the writer bot is in the middle of replacing.
//
// The bot container owns writes + the one-time JSON migration; the dashboard
// container opens the same file (shared ./data bind mount) and only reads.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";

// Data dir defaults to ../data relative to the source, but can be overridden via
// STONKBOT_DATA_DIR (used to point verification runs at a throwaway DB instead of
// the production one). A trailing slash is enforced.
const ENV_DATA_DIR = process.env.STONKBOT_DATA_DIR;
const DATA_DIR = ENV_DATA_DIR
  ? (ENV_DATA_DIR.endsWith("/") ? ENV_DATA_DIR : `${ENV_DATA_DIR}/`)
  : new URL("../data/", import.meta.url).pathname;
const DB_PATH = `${DATA_DIR}stonkbot.db`;
const STATE_JSON = `${DATA_DIR}state.json`;
const TRADES_JSON = `${DATA_DIR}trades.json`;

export interface EquityPoint {
  t: string; // ISO timestamp
  equity: number;
}

export interface BenchmarkPoint {
  t: string; // ISO timestamp
  price: number; // benchmark (SCHD) price at that time
}

export interface CompletedTrade {
  symbol: string;
  sector: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  value: number; // market value liquidated at close
  realizedPl: number; // $ P/L
  realizedPlPct: number; // fractional P/L (0.02 = +2%)
  reason: string; // why it sold
  closedAt: string; // ISO timestamp
}

export interface DailySummary {
  tradingDay: string;
  buys: number;
  sells: number;
  dayPl: number;
  dayPlPct: number;
  realizedPl: number;
  equity: number;
  openPositions: number;
  botReturnPct: number | null;
  benchReturnPct: number | null;
  sentAt: string; // ISO timestamp
}

let _db: Database | null = null;

// Open (once) and return the shared connection with the schema ensured. WAL +
// a busy timeout let the bot (writer) and dashboard (reader) share the file.
export function db(): Database {
  if (_db) return _db;
  // All three containers (bot, dashboard, experiment) open this file at once on a
  // cold start, so the first WAL switch can hit SQLITE_BUSY_RECOVERY while another
  // connection is recovering the log — a case busy_timeout doesn't cover. Retry
  // the open briefly instead of crashing out (restart:unless-stopped would too,
  // but a clean retry avoids the flap).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const d = new Database(DB_PATH, { create: true });
      d.exec("PRAGMA busy_timeout = 5000;");
      d.exec("PRAGMA journal_mode = WAL;");
      d.exec(`
    CREATE TABLE IF NOT EXISTS equity_history (
      t TEXT PRIMARY KEY,
      equity REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchmark_history (
      t TEXT PRIMARY KEY,
      price REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      sector TEXT NOT NULL,
      qty REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      value REAL NOT NULL,
      realized_pl REAL NOT NULL,
      realized_pl_pct REAL NOT NULL,
      reason TEXT NOT NULL,
      closed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_summary (
      trading_day TEXT PRIMARY KEY,
      buys INTEGER NOT NULL,
      sells INTEGER NOT NULL,
      day_pl REAL NOT NULL,
      day_pl_pct REAL NOT NULL,
      realized_pl REAL NOT NULL,
      equity REAL NOT NULL,
      open_positions INTEGER NOT NULL,
      bot_return_pct REAL,
      bench_return_pct REAL,
      sent_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- #region experiment (multi-arm) tables
    -- Registry of the arms and their params (for the dashboard + reproducibility).
    CREATE TABLE IF NOT EXISTS arms (
      arm_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      params_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- Each arm's live virtual portfolio (cash + open lots + day tracking) as a
    -- JSON blob, overwritten each cycle so the engine can resume after a restart.
    CREATE TABLE IF NOT EXISTS arm_book (
      arm_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Per-arm equity curve (composite PK: benchmark_history stays shared/global).
    CREATE TABLE IF NOT EXISTS arm_equity (
      arm_id INTEGER NOT NULL,
      t TEXT NOT NULL,
      equity REAL NOT NULL,
      PRIMARY KEY (arm_id, t)
    );
    -- Per-arm closed-trade log (same shape as the trades table, plus arm_id).
    CREATE TABLE IF NOT EXISTS arm_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      sector TEXT NOT NULL,
      qty REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      value REAL NOT NULL,
      realized_pl REAL NOT NULL,
      realized_pl_pct REAL NOT NULL,
      reason TEXT NOT NULL,
      closed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arm_trades_arm ON arm_trades (arm_id);
    -- #endregion
  `);
      _db = d;
      return d;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string })?.code ?? "";
      if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) {
        Bun.sleepSync(250);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// #region meta accessors
export function getMeta(key: string): string | null {
  return db().query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db().query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
// #endregion

// #region migration
// One-time import of the pre-SQLite JSON stores. Bot-only, at startup. Idempotent
// via the `meta` flag, so a restart never re-imports. After a verified import the
// old trades.json is renamed aside (its data now lives in the DB); state.json is
// left in place and loses its stale equityHistory field on the bot's next save
// (BotState no longer carries it).
export function migrateFromJson(): void {
  const d = db();
  const already = d.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'json_migrated'").get();
  if (already) return;

  let equityCount = 0;
  let tradeCount = 0;

  if (existsSync(STATE_JSON)) {
    try {
      const state = JSON.parse(readFileSync(STATE_JSON, "utf8"));
      const pts: EquityPoint[] = Array.isArray(state.equityHistory) ? state.equityHistory : [];
      const ins = d.query("INSERT OR IGNORE INTO equity_history (t, equity) VALUES (?, ?)");
      const tx = d.transaction((rows: EquityPoint[]) => {
        for (const p of rows) if (p?.t) { ins.run(p.t, p.equity); equityCount++; }
      });
      tx(pts);
    } catch (err) {
      console.error("[db] equityHistory migration skipped:", err);
    }
  }

  if (existsSync(TRADES_JSON)) {
    try {
      const trades: CompletedTrade[] = JSON.parse(readFileSync(TRADES_JSON, "utf8"));
      const before = tradeCount;
      const tx = d.transaction((rows: CompletedTrade[]) => {
        for (const t of rows) { insertTrade(t); tradeCount++; }
      });
      tx(Array.isArray(trades) ? trades : []);
      // Only rename the source aside once every row is confirmed in the DB.
      const inDb = d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM trades").get();
      if (inDb && inDb.n >= tradeCount && tradeCount > before) {
        renameSync(TRADES_JSON, `${TRADES_JSON}.migrated`);
      }
    } catch (err) {
      console.error("[db] trades migration skipped:", err);
    }
  }

  d.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_migrated', '1')");
  console.log(`[db] migrated from JSON: ${equityCount} equity points, ${tradeCount} trades`);
}
// #endregion

// #region equity history
export function appendEquity(point: EquityPoint): void {
  db().query("INSERT OR REPLACE INTO equity_history (t, equity) VALUES (?, ?)").run(point.t, point.equity);
}

// Oldest-first equity points. `limit` returns only the most recent N (still
// oldest-first) so a long history can render a bounded sparkline cheaply.
export function loadEquityHistory(limit?: number): EquityPoint[] {
  const d = db();
  if (limit && limit > 0) {
    const rows = d.query<EquityPoint, [number]>(
      "SELECT t, equity FROM equity_history ORDER BY t DESC LIMIT ?",
    ).all(limit);
    return rows.reverse();
  }
  return d.query<EquityPoint, []>("SELECT t, equity FROM equity_history ORDER BY t ASC").all();
}
// #endregion

// #region benchmark history
// Parallel to equity_history: the benchmark (SCHD) price sampled each cycle, so
// the dashboard can draw the bot's equity curve against the benchmark's over the
// same window (both rebased to % return). Written by the bot every cycle.
export function appendBenchmark(point: BenchmarkPoint): void {
  db().query("INSERT OR REPLACE INTO benchmark_history (t, price) VALUES (?, ?)").run(point.t, point.price);
}

export function loadBenchmarkHistory(): BenchmarkPoint[] {
  return db().query<BenchmarkPoint, []>("SELECT t, price FROM benchmark_history ORDER BY t ASC").all();
}

// One-time seed of the benchmark line from historical bars, so the SCHD curve
// isn't empty for the window we already recorded equity over (before we started
// sampling it live). Idempotent via a meta flag; the bot calls this once at
// startup with bars fetched from Alpaca.
export function backfillBenchmark(points: BenchmarkPoint[]): void {
  const d = db();
  if (d.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'benchmark_backfilled'").get()) return;
  const ins = d.query("INSERT OR IGNORE INTO benchmark_history (t, price) VALUES (?, ?)");
  const tx = d.transaction((rows: BenchmarkPoint[]) => {
    for (const p of rows) if (p?.t) ins.run(p.t, p.price);
  });
  tx(points);
  d.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('benchmark_backfilled', '1')");
  console.log(`[db] benchmark backfilled: ${points.length} points`);
}
// #endregion

// #region trades
function insertTrade(t: CompletedTrade): void {
  db().query(
    `INSERT INTO trades
      (symbol, sector, qty, entry_price, exit_price, value, realized_pl, realized_pl_pct, reason, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.symbol, t.sector, t.qty, t.entryPrice, t.exitPrice, t.value,
    t.realizedPl, t.realizedPlPct, t.reason, t.closedAt,
  );
}

export function appendTrade(trade: CompletedTrade): void {
  insertTrade(trade);
}

interface TradeRow {
  symbol: string; sector: string; qty: number; entry_price: number; exit_price: number;
  value: number; realized_pl: number; realized_pl_pct: number; reason: string; closed_at: string;
}

// Oldest-first (the dashboard reverses for newest-first display), matching the
// old append-order semantics of trades.json.
export function loadTrades(): CompletedTrade[] {
  const rows = db().query<TradeRow, []>(
    `SELECT symbol, sector, qty, entry_price, exit_price, value,
            realized_pl, realized_pl_pct, reason, closed_at
     FROM trades ORDER BY id ASC`,
  ).all();
  return rows.map((r) => ({
    symbol: r.symbol, sector: r.sector, qty: r.qty,
    entryPrice: r.entry_price, exitPrice: r.exit_price, value: r.value,
    realizedPl: r.realized_pl, realizedPlPct: r.realized_pl_pct,
    reason: r.reason, closedAt: r.closed_at,
  }));
}
// #endregion

// #region daily summaries
export function recordDailySummary(s: DailySummary): void {
  db().query(
    `INSERT OR REPLACE INTO daily_summary
      (trading_day, buys, sells, day_pl, day_pl_pct, realized_pl, equity,
       open_positions, bot_return_pct, bench_return_pct, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.tradingDay, s.buys, s.sells, s.dayPl, s.dayPlPct, s.realizedPl, s.equity,
    s.openPositions, s.botReturnPct, s.benchReturnPct, s.sentAt,
  );
}
// #endregion

// #region experiment (multi-arm) persistence
export interface ArmTrade {
  armId: number;
  symbol: string;
  sector: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  value: number;
  realizedPl: number;
  realizedPlPct: number;
  reason: string;
  closedAt: string;
}

// Register (or refresh) an arm's definition. Idempotent by arm_id.
export function upsertArm(a: { id: number; name: string; hypothesis: string; paramsJson: string; createdAt: string }): void {
  db().query(
    `INSERT INTO arms (arm_id, name, hypothesis, params_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(arm_id) DO UPDATE SET name = excluded.name,
       hypothesis = excluded.hypothesis, params_json = excluded.params_json`,
  ).run(a.id, a.name, a.hypothesis, a.paramsJson, a.createdAt);
}

// The arm's virtual book (opaque JSON blob owned by the engine).
export function loadArmBook(armId: number): string | null {
  return db().query<{ state_json: string }, [number]>("SELECT state_json FROM arm_book WHERE arm_id = ?").get(armId)?.state_json ?? null;
}

export function saveArmBook(armId: number, stateJson: string, updatedAt: string): void {
  db().query(
    "INSERT OR REPLACE INTO arm_book (arm_id, state_json, updated_at) VALUES (?, ?, ?)",
  ).run(armId, stateJson, updatedAt);
}

export function appendArmEquity(armId: number, t: string, equity: number): void {
  db().query("INSERT OR REPLACE INTO arm_equity (arm_id, t, equity) VALUES (?, ?, ?)").run(armId, t, equity);
}

export function appendArmTrade(t: ArmTrade): void {
  db().query(
    `INSERT INTO arm_trades
      (arm_id, symbol, sector, qty, entry_price, exit_price, value, realized_pl, realized_pl_pct, reason, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.armId, t.symbol, t.sector, t.qty, t.entryPrice, t.exitPrice, t.value,
    t.realizedPl, t.realizedPlPct, t.reason, t.closedAt,
  );
}

// Oldest-first equity curve for one arm (for the overlay chart). `limit` returns
// the most recent N (still oldest-first).
export function loadArmEquitySeries(armId: number, limit?: number): EquityPoint[] {
  const d = db();
  if (limit && limit > 0) {
    return d.query<EquityPoint, [number, number]>(
      "SELECT t, equity FROM arm_equity WHERE arm_id = ? ORDER BY t DESC LIMIT ?",
    ).all(armId, limit).reverse();
  }
  return d.query<EquityPoint, [number]>(
    "SELECT t, equity FROM arm_equity WHERE arm_id = ? ORDER BY t ASC",
  ).all(armId);
}

// A closed-trade row for one arm, newest-first (dashboard drill-in).
export function loadArmTrades(armId: number): CompletedTrade[] {
  const rows = db().query<TradeRow, [number]>(
    `SELECT symbol, sector, qty, entry_price, exit_price, value,
            realized_pl, realized_pl_pct, reason, closed_at
     FROM arm_trades WHERE arm_id = ? ORDER BY id DESC`,
  ).all(armId);
  return rows.map((r) => ({
    symbol: r.symbol, sector: r.sector, qty: r.qty,
    entryPrice: r.entry_price, exitPrice: r.exit_price, value: r.value,
    realizedPl: r.realized_pl, realizedPlPct: r.realized_pl_pct,
    reason: r.reason, closedAt: r.closed_at,
  }));
}

// One row per arm with everything the leaderboard needs. Trade stats come from a
// single grouped query; max drawdown + open-position count are folded in from
// the per-arm equity curve and book. Ranked here by return so callers can render
// directly.
export interface ArmLeaderboardRow {
  armId: number;
  name: string;
  hypothesis: string;
  firstEquity: number;
  lastEquity: number;
  returnPct: number; // vs the arm's own starting equity
  trades: number;
  wins: number;
  winRatePct: number;
  grossWin: number;
  grossLoss: number; // positive magnitude
  profitFactor: number | null; // null when no losses yet
  avgWin: number;
  avgLoss: number; // negative
  expectancy: number; // per-trade $
  maxDrawdownPct: number;
  openPositions: number;
}

interface ArmTradeAgg {
  arm_id: number; n: number; wins: number;
  gross_win: number; gross_loss: number;
}

export function loadArmLeaderboard(): ArmLeaderboardRow[] {
  const d = db();
  const arms = d.query<{ arm_id: number; name: string; hypothesis: string }, []>(
    "SELECT arm_id, name, hypothesis FROM arms ORDER BY arm_id ASC",
  ).all();

  // Trade aggregates in one grouped pass.
  const aggRows = d.query<ArmTradeAgg, []>(
    `SELECT arm_id,
            COUNT(*) AS n,
            SUM(CASE WHEN realized_pl > 0 THEN 1 ELSE 0 END) AS wins,
            COALESCE(SUM(CASE WHEN realized_pl > 0 THEN realized_pl ELSE 0 END), 0) AS gross_win,
            COALESCE(SUM(CASE WHEN realized_pl < 0 THEN -realized_pl ELSE 0 END), 0) AS gross_loss
     FROM arm_trades GROUP BY arm_id`,
  ).all();
  const agg = new Map<number, ArmTradeAgg>(aggRows.map((r) => [r.arm_id, r]));

  const out: ArmLeaderboardRow[] = [];
  for (const a of arms) {
    const series = loadArmEquitySeries(a.arm_id);
    const first = series[0]?.equity ?? 0;
    const last = series[series.length - 1]?.equity ?? first;
    const returnPct = first > 0 ? ((last - first) / first) * 100 : 0;

    // Max drawdown over the equity curve (peak-to-trough, as a %).
    let peak = first;
    let maxDd = 0;
    for (const pt of series) {
      if (pt.equity > peak) peak = pt.equity;
      if (peak > 0) {
        const dd = (peak - pt.equity) / peak;
        if (dd > maxDd) maxDd = dd;
      }
    }

    const t = agg.get(a.arm_id);
    const n = t?.n ?? 0;
    const wins = t?.wins ?? 0;
    const losses = n - wins;
    const grossWin = t?.gross_win ?? 0;
    const grossLoss = t?.gross_loss ?? 0;
    const avgWin = wins > 0 ? grossWin / wins : 0;
    const avgLoss = losses > 0 ? -grossLoss / losses : 0;
    const winRate = n > 0 ? wins / n : 0;
    const expectancy = n > 0 ? (grossWin - grossLoss) / n : 0;

    let openPositions = 0;
    const bookJson = loadArmBook(a.arm_id);
    if (bookJson) {
      try { openPositions = (JSON.parse(bookJson).positions ?? []).length; } catch { /* ignore */ }
    }

    out.push({
      armId: a.arm_id,
      name: a.name,
      hypothesis: a.hypothesis,
      firstEquity: first,
      lastEquity: last,
      returnPct,
      trades: n,
      wins,
      winRatePct: winRate * 100,
      grossWin,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgWin,
      avgLoss,
      expectancy,
      maxDrawdownPct: maxDd * 100,
      openPositions,
    });
  }

  return out.sort((x, y) => y.returnPct - x.returnPct);
}
// #endregion
// #endregion
