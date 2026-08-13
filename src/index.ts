// #region main
// One trading cycle: sync account/positions, run forced exits, evaluate the
// watchlist, place the single best allowed buy. Loops on an interval during
// US market hours. Long-only, paper by default.
import { config } from "./config";
import {
  getAccount, getPositions, getClock, submitBuy, closePosition, getLatestPrice, type Position,
} from "./alpaca";
import { evaluateSymbol } from "./strategy";
import { getHeadlines, getNewsSentiments } from "./news";
import {
  forcedExits, allowedBuyUsd, alreadyHolding, dailyLossBreached, sectorAtCap, type RiskContext,
} from "./risk";
import {
  loadState, saveState, rollDayIfNeeded, saveSignals, loadNewsCache, saveNewsCache,
  type BotState,
} from "./state";
import {
  appendEquity, appendBenchmark, backfillBenchmark, loadEquityHistory,
  appendTrade, recordDailySummary, migrateFromJson,
} from "./db";
import { getBars } from "./alpaca";
import { notify } from "./notify";

// US/Eastern trading-day string, e.g. "2026-08-08".
function usTradingDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Stable signature of a headline set, so the AI sentiment only re-runs when the
// headlines actually change (djb2 hash, dependency-free).
function sigOf(headlines: string[]): string {
  const s = headlines.join("");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// Record a closed position: append it to the trade history. `pos` is the
// pre-close snapshot, so its unrealized P/L is the realized result of the
// market close.
async function recordSell(pos: Position, reason: string, now: Date, state: BotState): Promise<void> {
  const pl = pos.unrealized_pl;
  const plPct = pos.unrealized_plpc;
  // Tally into the day's counters for the market-close summary push.
  state.sellsToday += 1;
  state.realizedPlToday += pl;
  appendTrade({
    symbol: pos.symbol,
    sector: config.sectors[pos.symbol] ?? "",
    qty: pos.qty,
    entryPrice: pos.avg_entry_price,
    exitPrice: pos.current_price,
    value: pos.market_value,
    realizedPl: pl,
    realizedPlPct: plPct,
    reason,
    closedAt: now.toISOString(),
  });
  // Per-trade SELL push intentionally omitted: Filip only wants the daily
  // close summary, not a buzz on every fill. The sell is still recorded to
  // trades + shown live on the dashboard.
}

async function runCycle(now: Date): Promise<void> {
  const account = await getAccount();
  const positions = await getPositions();

  let state = await loadState();
  state = rollDayIfNeeded(state, usTradingDay(now), account.equity);

  // Capture inception equity + benchmark price once, for SCHD scoring.
  if (state.inceptionEquity <= 0) {
    state.inceptionEquity = account.equity;
    const benchPrice = await getLatestPrice(config.benchmark);
    if (benchPrice) state.benchmarkInceptionPrice = benchPrice;
    console.log(`[inception] equity=$${account.equity.toFixed(2)} ${config.benchmark}=$${benchPrice ?? "?"}`);
  }

  // Record equity for the dashboard line (SQLite: unbounded, queryable).
  appendEquity({ t: now.toISOString(), equity: account.equity });

  // Sample the benchmark alongside it, so the dashboard can plot the bot's curve
  // against SCHD's over the same window. Cheap (one latest-price call/cycle);
  // best-effort, never blocks trading.
  try {
    const benchNow = await getLatestPrice(config.benchmark);
    if (benchNow) appendBenchmark({ t: now.toISOString(), price: benchNow });
  } catch { /* benchmark sample is observability-only */ }

  const ctx: RiskContext = { account, positions, state };

  // 0) SHORT SAFETY SWEEP. A short position has unbounded downside and is the
  // only way to lose more than you invested. We never open one, but if the
  // account somehow shows a negative quantity, flatten it immediately.
  for (const p of positions) {
    if (p.qty < 0) {
      console.error(`[SAFETY] short position detected: ${p.symbol} qty=${p.qty}. Flattening.`);
      await closePosition(p.symbol);
      await notify("SAFETY: short flattened", `${p.symbol} qty ${p.qty} force-closed. Shorting must never happen.`);
    }
  }

  // 1) Forced risk exits first (stop-loss / take-profit).
  for (const exit of forcedExits(positions)) {
    console.log(`[exit] ${exit.symbol}: ${exit.reason}`);
    await closePosition(exit.symbol);
    const pos = positions.find((p) => p.symbol === exit.symbol);
    if (pos) await recordSell(pos, exit.reason, now, state);
  }

  // 2) Daily loss cap check.
  if (dailyLossBreached(ctx) && !state.haltedForDay) {
    state.haltedForDay = true;
    await notify("Daily loss cap hit", `Trading halted for ${state.tradingDay}. Equity $${account.equity.toFixed(2)}.`);
  }

  // 3) Strategy signals across the watchlist.
  const signals = await Promise.all(
    config.watchlist.map((sym) => {
      // Pass the held position's unrealized P/L (null if unheld) so the momentum
      // exit can gate on cost basis (only sell into strength when in profit).
      const held = positions.find((p) => p.symbol === sym && p.qty > 0);
      return evaluateSymbol(sym, held ? held.unrealized_plpc : null, now);
    }),
  );

  // News for the watchlist, kept cheap:
  //  - refresh a symbol's headlines when it's near-buy (all gates green, so news
  //    matters for the trade) OR once per trading day for everything else;
  //  - only re-run the AI sentiment when the headline set actually changed
  //    (compared via a signature), so static news never re-bills.
  const day = usTradingDay(now);
  const newsCache = await loadNewsCache();
  const nearBuy = (sig: (typeof signals)[number]) =>
    !!sig.metrics && sig.metrics.trendUp && sig.metrics.rsi !== null &&
    sig.metrics.rsi <= config.strategy.rsiOversold && (sig.metrics.dip ?? 0) > 0;

  const refresh = signals.filter((sig) => nearBuy(sig) || newsCache[sig.symbol]?.day !== day);
  const fresh = new Map<string, string[]>();
  await Promise.all(refresh.map(async (sig) => {
    fresh.set(sig.symbol, await getHeadlines(sig.symbol, now));
  }));

  // Only symbols whose headlines changed since last classified go to the AI.
  const changed: { symbol: string; headlines: string[] }[] = [];
  for (const [symbol, headlines] of fresh) {
    if (headlines.length > 0 && sigOf(headlines) !== newsCache[symbol]?.sig) {
      changed.push({ symbol, headlines });
    }
  }
  const sentiments = await getNewsSentiments(changed);

  for (const [symbol, headlines] of fresh) {
    const prev = newsCache[symbol];
    const s = sigOf(headlines);
    const reran = changed.some((c) => c.symbol === symbol);
    newsCache[symbol] = {
      count: headlines.length,
      latest: headlines[0] ?? null,
      // Keep the top few headlines for the watchlist news card (not just latest).
      headlines: headlines.slice(0, 3),
      // Re-classified this cycle → new sentiment; otherwise keep the cached one.
      sentiment: reran ? sentiments.get(symbol) : prev?.sentiment,
      day,
      sig: s,
    };
  }
  await saveNewsCache(newsCache);

  for (const sig of signals) {
    const c = newsCache[sig.symbol];
    if (c) sig.news = { count: c.count, latest: c.latest, headlines: c.headlines, sentiment: c.sentiment };
  }

  // Snapshot every symbol's reading for the dashboard watchlist (observability
  // only; the bot never reads this back).
  await saveSignals(now.toISOString(), signals);

  // Strategy-driven sells (momentum exits).
  for (const sig of signals) {
    if (sig.action === "sell" && alreadyHolding(positions, sig.symbol)) {
      console.log(`[sell] ${sig.symbol}: ${sig.reason}`);
      await closePosition(sig.symbol);
      const pos = positions.find((p) => p.symbol === sig.symbol);
      if (pos) await recordSell(pos, sig.reason, now, state);
    }
  }

  // 4) Up to maxBuysPerCycle best buys per cycle. Every rail is re-checked
  // against a simulated post-buy book after each fill, so a second buy only
  // happens if it independently clears budget, cash buffer, sector cap and
  // max-positions — it just lets the bot fill more than one qualified dip in
  // the same cycle instead of deferring the runner-up 5 minutes.
  const simPositions = [...positions];
  let simCash = account.cash;
  for (let filled = 0; filled < config.risk.maxBuysPerCycle; filled++) {
    const simCtx: RiskContext = { account: { ...account, cash: simCash }, positions: simPositions, state };
    const budget = allowedBuyUsd(simCtx);
    if (budget <= 0) break;

    const pick = signals
      .filter((s) => s.action === "buy"
        && !alreadyHolding(simPositions, s.symbol)
        && !sectorAtCap(simPositions, s.symbol)) // skip if this sector is already full
      .sort((a, b) => b.score - a.score)[0];
    if (!pick) break;

    // NO-LEVERAGE HARD CAP: never spend more than settled cash on hand, so a
    // long can never lose more than the cash placed in it. Uses cash, never
    // the 4x margin buying power.
    const spend = Math.min(budget, simCash);
    if (spend < config.risk.minOrderUsd) break;

    console.log(`[buy] ${pick.symbol} $${spend.toFixed(2)}: ${pick.reason}`);
    await submitBuy({ symbol: pick.symbol, notional: spend, type: "market" });
    state.buysToday += 1;
    // Per-trade BUY push intentionally omitted: Filip only wants the daily
    // close summary. Fill is still counted (buysToday) + shown on the dashboard.

    // Simulate the fill so the next iteration's rails see the consumed cash and
    // the new position (cash → shares leaves equity unchanged).
    simCash -= spend;
    simPositions.push({
      symbol: pick.symbol, qty: spend / (pick.price || 1), avg_entry_price: pick.price || 0,
      current_price: pick.price || 0, market_value: spend, unrealized_pl: 0, unrealized_plpc: 0,
    });
  }

  await saveState(state);
  console.log(`[cycle] equity=$${account.equity.toFixed(2)} cash=$${account.cash.toFixed(2)} positions=${positions.length}`);
}

// Once the market closes, push a single end-of-day summary: buys/sells placed,
// the day's P/L and equity, realized P/L on positions closed today, open book,
// and the running bot-vs-SCHD scoreboard. Guarded by closeSummarySentDay so it
// fires exactly once per trading day (not on every closed cycle overnight).
async function sendDailySummary(): Promise<void> {
  const state = await loadState();
  if (!state.tradingDay || state.closeSummarySentDay === state.tradingDay) return;

  const account = await getAccount();
  const positions = await getPositions();

  const dayOpen = state.dayOpenEquity;
  const dayPl = dayOpen > 0 ? account.equity - dayOpen : 0;
  const dayPlPct = dayOpen > 0 ? (dayPl / dayOpen) * 100 : 0;
  const openUnreal = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const s = (n: number) => (n >= 0 ? "+" : "");

  let botReturnPct: number | null = null;
  let benchReturnPct: number | null = null;

  const lines = [
    `Buys ${state.buysToday} · Sells ${state.sellsToday}`,
    `Day P/L ${s(dayPl)}$${dayPl.toFixed(2)} (${s(dayPlPct)}${dayPlPct.toFixed(2)}%)`,
    `Realized today ${s(state.realizedPlToday)}$${state.realizedPlToday.toFixed(2)}`,
    `Equity $${account.equity.toFixed(2)} · ${positions.length} open (unreal ${s(openUnreal)}$${openUnreal.toFixed(2)})`,
  ];

  // Running scoreboard vs the SCHD benchmark, since inception.
  if (state.inceptionEquity > 0 && state.benchmarkInceptionPrice > 0) {
    const benchNow = await getLatestPrice(config.benchmark);
    if (benchNow) {
      const botRet = ((account.equity - state.inceptionEquity) / state.inceptionEquity) * 100;
      const schdRet = ((benchNow - state.benchmarkInceptionPrice) / state.benchmarkInceptionPrice) * 100;
      const edge = botRet - schdRet;
      botReturnPct = botRet;
      benchReturnPct = schdRet;
      lines.push(
        `vs ${config.benchmark}: bot ${s(botRet)}${botRet.toFixed(2)}% / ${config.benchmark} ` +
          `${s(schdRet)}${schdRet.toFixed(2)}% → ${s(edge)}${edge.toFixed(2)}% ${edge >= 0 ? "ahead" : "behind"}`,
      );
    }
  }

  await notify(`Market close · ${state.tradingDay}`, lines.join("\n"), { tags: ["bar_chart"], priority: 3 });

  // Persist the summary as a queryable row (day-over-day history).
  recordDailySummary({
    tradingDay: state.tradingDay,
    buys: state.buysToday,
    sells: state.sellsToday,
    dayPl,
    dayPlPct,
    realizedPl: state.realizedPlToday,
    equity: account.equity,
    openPositions: positions.length,
    botReturnPct,
    benchReturnPct,
    sentAt: new Date().toISOString(),
  });

  state.closeSummarySentDay = state.tradingDay;
  await saveState(state);
  console.log(`[summary] sent daily summary for ${state.tradingDay}`);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  console.log(`stonkbot starting: mode=${config.mode} tradingEnabled=${config.tradingEnabled} once=${once}`);

  if (!config.alpaca.keyId || !config.alpaca.secretKey) {
    console.error("No Alpaca keys set. Copy .env.example to .env and fill in ALPACA_KEY_ID / ALPACA_SECRET_KEY.");
    process.exit(1);
  }

  // One-time import of the old JSON equity/trade history into SQLite (idempotent).
  migrateFromJson();

  // One-time seed of the benchmark line over the window we already have equity
  // for (before we started sampling SCHD live). Idempotent via a meta flag.
  try {
    const hist = loadEquityHistory();
    const start = hist[0]?.t ?? new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const bars = await getBars(config.benchmark, "1Hour", 500, start);
    backfillBenchmark(bars.map((b) => ({ t: b.t, price: b.c })));
  } catch (err) {
    console.error("[benchmark] backfill skipped:", err instanceof Error ? err.message : err);
  }

  const CYCLE_MS = 5 * 60 * 1000; // evaluate every 5 minutes

  do {
    try {
      const clock = await getClock();
      if (clock.is_open) {
        await runCycle(new Date());
      } else {
        console.log(`[cycle] market closed. Next open ${clock.next_open}.`);
        await sendDailySummary();
      }
    } catch (err) {
      console.error("[cycle] error:", err);
      await notify("Error", String(err instanceof Error ? err.message : err));
    }
    if (!once) await Bun.sleep(CYCLE_MS);
  } while (!once);
}

main();
// #endregion
