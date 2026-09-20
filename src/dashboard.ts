// #region dashboard
// The public stonkbot dashboard. Server-rendered, no build step, no external
// deps — a single dark HTML page with a bit of r/wallstreetbets energy 🚀.
// Shows: live equity + day P/L, the bot-vs-SCHD scoreboard and a dual-line
// growth chart, KPI tiles, open holdings, a watchlist of cards (each with buy
// gates + a five-level news read and recent headlines), and the closed-trade
// log with the reason each position was sold.
import { config } from "./config";
import { dayTradeStatus, usTradingDay, type DayTradeStatus } from "./daytrades";
import { loadState, loadSignals } from "./state";
import { loadEquityHistory, loadBenchmarkHistory, loadTrades } from "./db";
import { getAccount, getPositions, getLatestPrice, getClock, type Position } from "./alpaca";
import type { Signal } from "./strategy";
import { renderExperiment, renderArmDetail, armExists } from "./experiment/dashboard";

function page(html: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// #region small helpers
function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function truncate(str: string, n: number): string {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const pctCls = (n: number) => (n >= 0 ? "up" : "down");

const etTime = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).format(new Date(iso));
// #endregion

// #region wsb flavor
// A performance-driven hype line. Pure fun; the numbers above it are the truth.
function moodLine(dayChange: number, edge: number | null): string {
  let base: string;
  if (dayChange >= 1.5) base = "🚀🚀 TO THE MOON — tendies secured";
  else if (dayChange >= 0.4) base = "📈 stonks only go up";
  else if (dayChange > -0.4) base = "🦍 apes just holding, nothing to see here";
  else if (dayChange > -1.5) base = "📉 it's not a loss until you sell (buying the dip)";
  else base = "💀 GUH. it's fine. this is fine. 🔥";

  if (edge === null) return base;
  const vs = edge >= 0
    ? ` · 💎🙌 outpacing SCHD by ${signed(edge)} pts, basically Buffett`
    : ` · 🐻 an ETF is beating a robot by ${signed(-edge)} pts, embarrassing`;
  return base + vs;
}
// #endregion

async function render(): Promise<string> {
  const state = await loadState();

  // Pull everything we can in parallel; degrade gracefully on any failure.
  const [acctRes, posRes, benchRes, clockRes] = await Promise.allSettled([
    getAccount(), getPositions(), getLatestPrice(config.benchmark), getClock(),
  ]);

  const acct = acctRes.status === "fulfilled" ? acctRes.value : null;
  const positions = posRes.status === "fulfilled" ? posRes.value : [];
  const benchNow = benchRes.status === "fulfilled" ? benchRes.value : null;
  const clock = clockRes.status === "fulfilled" ? clockRes.value : null;

  const equity = acct?.equity ?? state.dayOpenEquity;
  const cash = acct?.cash ?? 0;
  const posMap = new Map<string, Position>();
  for (const p of positions) posMap.set(p.symbol, p);

  const dayChange = state.dayOpenEquity > 0 ? ((equity - state.dayOpenEquity) / state.dayOpenEquity) * 100 : 0;

  // Scoreboard math.
  const botReturn = state.inceptionEquity > 0 ? ((equity - state.inceptionEquity) / state.inceptionEquity) * 100 : null;
  const benchReturn = benchNow && state.benchmarkInceptionPrice > 0
    ? ((benchNow - state.benchmarkInceptionPrice) / state.benchmarkInceptionPrice) * 100 : null;
  const edge = botReturn !== null && benchReturn !== null ? botReturn - benchReturn : null;

  // Day-trade budget. Read-only here: syncOpens belongs to the bot process, which
  // owns the ledger. Null when the account call failed, so the tile just hides.
  const dayTrades = acct ? dayTradeStatus(acct, usTradingDay(new Date())) : null;

  const marketStatus = renderMarketStatus(clock);
  const scoreboard = renderScoreboard(botReturn, benchReturn, edge);
  const chart = renderChart();
  const tiles = renderTiles({ equity, cash, positions, dayTrades });
  const holdings = renderHoldings(positions);
  const watchlist = await renderWatchlist(posMap);
  const trades = renderTrades();

  const eqCount = loadEquityHistory(1).length ? loadEquityHistory().length : 0;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <meta name="color-scheme" content="dark">
  <title>stonkbot 🚀</title>
  <style>
    :root{
      --bg:#0a0b0d; --panel:#14161b; --panel2:#181b21; --border:#252932;
      --text:#e8eaed; --muted:#8b909a; --green:#16c784; --red:#ea3943;
      --gold:#f0b90b; --blue:#5b9dff; --violet:#a97bff;
    }
    *{box-sizing:border-box;}
    body{background:var(--bg);color:var(--text);margin:0;padding:1.5rem;
      font-family:"Inter",system-ui,-apple-system,sans-serif;line-height:1.45;overflow-x:hidden;
      background-image:radial-gradient(1200px 500px at 80% -10%,rgba(22,199,132,.07),transparent),
        radial-gradient(900px 400px at -10% 10%,rgba(169,123,255,.06),transparent);}
    .wrap{max-width:1140px;margin:0 auto;}
    a{color:inherit;}
    .up{color:var(--green);} .down{color:var(--red);} .warn{color:var(--gold);}
    .muted{color:var(--muted);}
    h1{font-weight:800;letter-spacing:-.03em;font-size:1.9rem;margin:0;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;}
    h2{font-weight:700;font-size:1.05rem;letter-spacing:-.01em;margin:2.2rem 0 .4rem;display:flex;align-items:center;gap:.5rem;}
    .badge{display:inline-block;padding:.15rem .55rem;border-radius:.5rem;background:#20242c;
      font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);}
    .pill{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .7rem;border-radius:999px;
      font-size:.8rem;font-weight:700;border:1px solid var(--border);background:var(--panel);}
    .pill.open{color:var(--green);border-color:rgba(22,199,132,.4);}
    .pill.closed{color:var(--muted);}
    .topbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;}

    .hero{margin:1.2rem 0 .3rem;}
    .equity{font-size:3.2rem;font-weight:800;letter-spacing:-.03em;line-height:1;}
    .daychg{font-size:1.15rem;font-weight:700;margin-left:.4rem;}
    .mood{margin:.5rem 0 0;font-size:.95rem;font-weight:600;color:var(--text);opacity:.9;}
    .submeta{color:var(--muted);font-size:.85rem;margin-top:.35rem;}

    .card{background:var(--panel);border:1px solid var(--border);border-radius:.9rem;padding:1rem 1.15rem;}
    .grid{display:grid;gap:.8rem;}

    /* scoreboard */
    .score{display:grid;grid-template-columns:1fr 1fr auto;gap:1rem;align-items:center;margin-top:1rem;}
    .score .col .lbl{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;}
    .score .col .val{font-size:1.8rem;font-weight:800;letter-spacing:-.02em;}
    .verdict{justify-self:end;text-align:right;}
    .verdict .tag{font-size:.95rem;padding:.35rem .8rem;}
    @media(max-width:560px){.score{grid-template-columns:1fr 1fr;}.verdict{grid-column:1/-1;justify-self:start;text-align:left;}}

    /* chart */
    .chartwrap{margin-top:1rem;}
    svg.chart{width:100%;height:230px;display:block;}
    .legend{display:flex;gap:1.2rem;flex-wrap:wrap;font-size:.82rem;font-weight:600;margin-top:.5rem;}
    .legend .k{display:inline-flex;align-items:center;gap:.4rem;}
    .swatch{width:.85rem;height:.28rem;border-radius:2px;display:inline-block;}

    /* KPI tiles */
    .tiles{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:1rem;}
    .tile .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;}
    .tile .v{font-size:1.5rem;font-weight:800;letter-spacing:-.02em;margin-top:.15rem;}
    .tile .s{font-size:.78rem;color:var(--muted);margin-top:.1rem;}

    /* holdings + watchlist cards */
    .cards{grid-template-columns:repeat(auto-fill,minmax(240px,1fr));}
    .hcard .top{display:flex;justify-content:space-between;align-items:baseline;}
    .ticker{font-size:1.15rem;font-weight:800;letter-spacing:-.02em;}
    .sector{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;}
    .hcard .plpc{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;margin:.35rem 0 .1rem;}
    .hcard .sub{font-size:.8rem;color:var(--muted);}

    .wcard{display:flex;flex-direction:column;gap:.6rem;border-left:3px solid var(--border);}
    .wcard.buy{border-left-color:var(--green);} .wcard.sell{border-left-color:var(--gold);}
    .sig{font-size:.78rem;font-weight:800;padding:.2rem .55rem;border-radius:.45rem;letter-spacing:.03em;}
    .sig.buy{background:rgba(22,199,132,.16);color:var(--green);}
    .sig.sell{background:rgba(240,185,11,.16);color:var(--gold);}
    .sig.hold{background:#20242c;color:var(--muted);}
    .price{font-size:1.05rem;font-weight:700;}
    .gates{display:flex;flex-wrap:wrap;gap:.35rem;}
    .gate{font-size:.72rem;font-weight:600;padding:.18rem .45rem;border-radius:.4rem;background:var(--panel2);
      border:1px solid var(--border);color:var(--muted);white-space:nowrap;}
    .gate.ok{color:var(--green);border-color:rgba(22,199,132,.35);}
    .rsibar{height:6px;border-radius:3px;background:var(--panel2);overflow:hidden;position:relative;}
    .rsibar i{position:absolute;top:0;bottom:0;left:0;display:block;}
    .news{border-top:1px solid var(--border);padding-top:.55rem;}
    .tag{display:inline-block;padding:.12rem .5rem;border-radius:.4rem;font-size:.72rem;font-weight:800;letter-spacing:.02em;}
    .tag.great{background:rgba(22,199,132,.22);color:#3be8a8;}
    .tag.good{background:rgba(22,199,132,.14);color:var(--green);}
    .tag.neu{background:#20242c;color:var(--muted);}
    .tag.bad{background:rgba(234,57,67,.14);color:#ff6b73;}
    .tag.terrible{background:rgba(234,57,67,.26);color:#ff7a80;}
    .tag.up{background:rgba(22,199,132,.16);color:var(--green);}
    .tag.down{background:rgba(234,57,67,.16);color:#ff6b73;}
    .heads{list-style:none;margin:.4rem 0 0;padding:0;}
    .heads li{font-size:.78rem;color:var(--muted);padding-left:.85rem;position:relative;margin-top:.2rem;}
    .heads li:before{content:"›";position:absolute;left:0;color:var(--muted);}
    .held{font-size:.76rem;font-weight:700;}

    /* table */
    .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:.6rem;border:1px solid var(--border);border-radius:.9rem;}
    table{width:100%;border-collapse:collapse;}
    th,td{text-align:left;padding:.55rem .8rem;border-bottom:1px solid var(--border);white-space:nowrap;font-size:.86rem;}
    th{color:var(--muted);font-weight:700;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;}
    tr:last-child td{border-bottom:none;}
    .foot{color:var(--muted);font-size:.8rem;margin-top:2.4rem;border-top:1px solid var(--border);padding-top:1rem;}

    @media(max-width:640px){
      body{padding:1rem;}
      .equity{font-size:2.4rem;} h1{font-size:1.5rem;}
      .hide-sm{display:none;}
    }
  </style></head><body><div class="wrap">
    <div class="topbar">
      <h1>🚀 stonkbot <span class="badge">${config.mode === "live" ? "💵 real money" : "🎩 monopoly money"}</span></h1>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <a class="pill" href="/experiment" style="color:var(--violet);border-color:rgba(169,123,255,.4)">⚔️ arena · final results</a>
        ${marketStatus}
      </div>
    </div>

    <div class="hero">
      <div><span class="equity">${money(equity)}</span><span class="daychg ${pctCls(dayChange)}">${signed(dayChange)}% today</span></div>
      <div class="mood">${esc(moodLine(dayChange, edge))}</div>
      <div class="submeta">cash ${money(cash)} · day open ${money(state.dayOpenEquity)} · ${state.haltedForDay ? "<span class='down'>⛔ HALTED (daily loss cap)</span>" : "🟢 active"}</div>
    </div>

    <div class="card">${scoreboard}${chart}</div>

    <div class="grid tiles">${tiles}</div>

    <h2>💼 Open positions</h2>
    ${holdings}

    <h2>👀 Watchlist</h2>
    ${watchlist}

    <h2>🧾 Closed positions</h2>
    ${trades}

    <div class="foot">
      Auto-refreshes every 60s · ${eqCount} equity samples on record · ${config.mode === "live" ? "real money" : "paper trading"}, <b>not financial advice</b>,
      this bot has diamond hands and reads the news so you don't have to. 🦆
    </div>
  </div></body></html>`;
}

// #region market status
function renderMarketStatus(clock: { is_open: boolean; next_open: string; next_close: string } | null): string {
  if (!clock) return `<span class="pill closed">⚪ market status unknown</span>`;
  if (clock.is_open) {
    const closes = etTime(clock.next_close, { hour: "numeric", minute: "2-digit" });
    return `<span class="pill open">🟢 MARKET OPEN · closes ${closes} ET</span>`;
  }
  const opens = etTime(clock.next_open, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return `<span class="pill closed">🔴 MARKET CLOSED · opens ${opens} ET</span>`;
}
// #endregion

// #region scoreboard
function renderScoreboard(botReturn: number | null, benchReturn: number | null, edge: number | null): string {
  const beating = edge !== null && edge >= 0;
  const botStr = botReturn === null ? "—" : `${signed(botReturn)}%`;
  const schdStr = benchReturn === null ? "—" : `${signed(benchReturn)}%`;
  const verdict = edge === null ? `<span class="tag neu">warming up</span>`
    : beating ? `<span class="tag up">💎 BEATING SCHD BY ${signed(edge)} PTS</span>`
      : `<span class="tag down">🐻 BEHIND SCHD BY ${signed(-edge)} PTS</span>`;
  return `<div class="score">
    <div class="col"><div class="lbl">🤖 stonkbot</div><div class="val ${botReturn !== null ? pctCls(botReturn) : ""}">${botStr}</div></div>
    <div class="col"><div class="lbl">🛡️ SCHD (the boomer ETF)</div><div class="val ${benchReturn !== null ? pctCls(benchReturn) : ""}">${schdStr}</div></div>
    <div class="verdict">${verdict}</div>
  </div>`;
}
// #endregion

// #region chart: bot equity vs benchmark, both rebased to % return
function renderChart(): string {
  const eq = loadEquityHistory();
  const bench = loadBenchmarkHistory();
  // Equity is sampled only during regular trading hours; clip the benchmark to
  // the same window so a couple of sparse pre/post-market bars (from the historical
  // backfill) don't fragment the one overnight gap into several stair-steps.
  // benchmark_history is shared with the Arena page and reaches back further than
  // the live book does after an account reset. Both series rebase to their own
  // first point, so clip the benchmark to the bot's own start or SCHD would be
  // measured from a date the bot never traded.
  const botFirst = eq.find((p) => inRegularHours(p.t))?.t ?? "";
  const botSeries = rebase(eq.filter((p) => inRegularHours(p.t)).map((p) => ({ t: p.t, v: p.equity })));
  const benchSeries = rebase(
    bench.filter((p) => inRegularHours(p.t) && p.t >= botFirst).map((p) => ({ t: p.t, v: p.price })),
  );
  if (botSeries.length < 2) return `<p class="muted" style="margin-top:1rem">📊 Chart populates as equity samples accrue…</p>`;

  const W = 1120, H = 230, padL = 8, padR = 8, padT = 14, padB = 18;
  const all = [...botSeries, ...benchSeries];
  const rMin = Math.min(0, ...all.map((p) => p.r)), rMax = Math.max(0, ...all.map((p) => p.r));
  const rRange = rMax - rMin || 1;

  // #region compressed-time x-axis
  // Equity is only sampled during market hours, so a linear time axis would draw
  // the ~17h overnight (and weekend) gaps as huge empty stretches. Instead we lay
  // points out on "trading time": any gap longer than GAP_CAP (market was closed)
  // collapses to a thin sliver, keeping all intraday spacing exact. Both series
  // share this transform, so they stay aligned. `breaks` marks each collapsed gap
  // (mid-sliver) so we can draw a faint session-break line.
  const GAP_CAP = 20 * 60 * 1000; // 20 min; longer gaps = a session break
  const times = Array.from(new Set(all.map((p) => p.t))).sort((a, b) => a - b);
  const cxOf = new Map<number, number>();
  const breaks: number[] = [];
  let cx = 0;
  cxOf.set(times[0]!, 0);
  for (let i = 1; i < times.length; i++) {
    const real = times[i]! - times[i - 1]!;
    const step = Math.min(real, GAP_CAP);
    if (real > GAP_CAP) breaks.push(cx + step / 2);
    cx += step;
    cxOf.set(times[i]!, cx);
  }
  const cxTotal = cx || 1;
  // #endregion

  const x = (t: number) => padL + ((cxOf.get(t) ?? 0) / cxTotal) * (W - padL - padR);
  const y = (r: number) => padT + (1 - (r - rMin) / rRange) * (H - padT - padB);

  const path = (s: { t: number; r: number }[]) =>
    s.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");

  const breakLines = breaks
    .map((b) => `<line x1="${(padL + (b / cxTotal) * (W - padL - padR)).toFixed(1)}" y1="${padT}" x2="${(padL + (b / cxTotal) * (W - padL - padR)).toFixed(1)}" y2="${H - padB}" stroke="var(--border)" stroke-width="1" stroke-dasharray="1 5" opacity=".7"/>`)
    .join("");

  const botLast = botSeries[botSeries.length - 1]!.r;
  const botColor = botLast >= 0 ? "var(--green)" : "var(--red)";
  const zeroY = y(0).toFixed(1);

  const area = botSeries.length
    ? `M${x(botSeries[0]!.t).toFixed(1)} ${zeroY} ${path(botSeries).replace(/^M/, "L")} L${x(botSeries[botSeries.length - 1]!.t).toFixed(1)} ${zeroY} Z`
    : "";

  const benchPath = benchSeries.length >= 2
    ? `<path d="${path(benchSeries)}" fill="none" stroke="var(--gold)" stroke-width="2" stroke-dasharray="5 4" opacity=".85"/>` : "";

  const botLbl = `${signed(botLast)}%`;
  const benchLbl = benchSeries.length ? `${signed(benchSeries[benchSeries.length - 1]!.r)}%` : "—";

  return `<div class="chartwrap">
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="equity vs SCHD">
      <defs><linearGradient id="botfill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${botColor}" stop-opacity=".22"/>
        <stop offset="1" stop-color="${botColor}" stop-opacity="0"/>
      </linearGradient></defs>
      ${breakLines}
      <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4"/>
      ${area ? `<path d="${area}" fill="url(#botfill)"/>` : ""}
      ${benchPath}
      <path d="${path(botSeries)}" fill="none" stroke="${botColor}" stroke-width="2.5"/>
    </svg>
    <div class="legend">
      <span class="k"><span class="swatch" style="background:${botColor}"></span>stonkbot <b class="${pctCls(botLast)}">${botLbl}</b></span>
      <span class="k"><span class="swatch" style="background:var(--gold)"></span>SCHD <b>${benchLbl}</b></span>
      <span class="k muted">since inception, rebased to 0% · market-hours only (closed sessions collapsed ┊)</span>
    </div>
  </div>`;
}

// True if an ISO timestamp falls within US regular trading hours (Mon-Fri,
// 9:30am-4:00pm ET). Uses ET wall time so it's DST-correct year-round.
function inRegularHours(iso: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 570 && mins <= 960; // 9:30 .. 16:00 ET
}

// Rebase a value series to % change from its first point.
function rebase(pts: { t: string; v: number }[]): { t: number; r: number }[] {
  if (!pts.length) return [];
  const base = pts[0]!.v || 1;
  return pts.map((p) => ({ t: new Date(p.t).getTime(), r: (p.v / base - 1) * 100 }));
}
// #endregion

// #region KPI tiles
function renderTiles(
  o: { equity: number; cash: number; positions: Position[]; dayTrades: DayTradeStatus | null },
): string {
  const trades = loadTrades();
  const realized = trades.reduce((a, t) => a + t.realizedPl, 0);
  const wins = trades.filter((t) => t.realizedPl >= 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const best = trades.reduce<null | typeof trades[number]>((b, t) => (!b || t.realizedPl > b.realizedPl ? t : b), null);
  const worst = trades.reduce<null | typeof trades[number]>((b, t) => (!b || t.realizedPl < b.realizedPl ? t : b), null);
  const openUnreal = o.positions.reduce((a, p) => a + p.unrealized_pl, 0);
  const deployed = o.positions.reduce((a, p) => a + p.market_value, 0);

  const tile = (k: string, v: string, s: string, cls = "") =>
    `<div class="card tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;

  // The day-trade budget only exists below the $25k PDT line, so the tile only
  // exists there too. It is the binding constraint on a small book: when it hits
  // zero the bot stops opening positions entirely.
  const dt = o.dayTrades;
  const dtTile = dt?.applies
    ? tile(
        "⚖️ Day trades",
        `${dt.used}<span class="s" style="font-weight:400"> / ${dt.max}</span>`,
        dt.remaining === 0 ? "<span class='down'>budget spent · no new entries</span>" : "5-session window",
        dt.remaining === 0 ? "down" : "",
      )
    : "";

  return [
    dtTile,
    tile("💰 Realized P/L", `<span class="${pctCls(realized)}">${signed(realized)}$</span>`.replace("$", ""), `${trades.length} trades closed`),
    tile("🎯 Win rate", `${winRate.toFixed(0)}%`, `${wins}W / ${losses}L`, winRate >= 50 ? "up" : "down"),
    tile("📊 Open positions", `${o.positions.length}<span class="s" style="font-weight:400"> / ${config.risk.maxOpenPositions}</span>`, `unreal <span class="${pctCls(openUnreal)}">${signed(openUnreal)}</span>`),
    tile("🧊 Dry powder", money(o.cash), `${money(deployed)} deployed`),
    tile("🏆 Best trade", best ? `<span class="up">${signed(best.realizedPl)}</span>` : "—", best ? `${best.symbol} ${signed(best.realizedPlPct * 100)}%` : "no trades yet"),
    tile("💥 Worst trade", worst ? `<span class="down">${signed(worst.realizedPl)}</span>` : "—", worst ? `${worst.symbol} ${signed(worst.realizedPlPct * 100)}%` : "no trades yet"),
  ].join("");
}
// #endregion

// #region holdings cards
function renderHoldings(positions: Position[]): string {
  if (!positions.length) return `<p class="muted">🫥 Flat. No open positions — all tendies, no risk.</p>`;
  const totalValue = positions.reduce((a, p) => a + p.market_value, 0);
  const totalPl = positions.reduce((a, p) => a + p.unrealized_pl, 0);
  const cards = [...positions].sort((a, b) => b.unrealized_plpc - a.unrealized_plpc).map((p) => {
    const cls = pctCls(p.unrealized_pl);
    const emoji = p.unrealized_pl >= 0 ? "🟢" : "🔴";
    return `<div class="card hcard">
      <div class="top"><span class="ticker">${p.symbol}</span><span class="sector">${config.sectors[p.symbol] ?? ""}</span></div>
      <div class="plpc ${cls}">${emoji} ${signed(p.unrealized_plpc * 100)}%</div>
      <div class="sub">${money(p.market_value)} · <span class="${cls}">${signed(p.unrealized_pl)}$</span></div>
      <div class="sub hide-sm">${p.qty.toFixed(2)} sh · ${money(p.avg_entry_price)} → ${money(p.current_price)}</div>
    </div>`;
  }).join("");
  const tcls = pctCls(totalPl);
  return `<div class="grid cards">${cards}</div>
    <p class="muted" style="margin-top:.7rem">Book value <b>${money(totalValue)}</b> · unrealized <b class="${tcls}">${signed(totalPl)}$</b></p>`;
}
// #endregion

// #region watchlist cards
const SENT: Record<string, { cls: string; label: string }> = {
  great: { cls: "great", label: "🔥 GREAT" },
  positive: { cls: "good", label: "🟢 GOOD" },
  neutral: { cls: "neu", label: "😐 MEH" },
  negative: { cls: "bad", label: "🔻 BAD" },
  terrible: { cls: "terrible", label: "💀 TERRIBLE" },
};

async function renderWatchlist(posMap: Map<string, Position>): Promise<string> {
  const snap = await loadSignals();
  if (!snap || !snap.signals.length) {
    return `<p class="muted">No scan recorded yet. Populates on the next market-hours cycle. 🦧</p>`;
  }
  const s = config.strategy;
  const rank = (a: Signal) => (a.action === "buy" ? 0 : a.action === "sell" ? 1 : 2);
  const rows = [...snap.signals].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.metrics?.rsi ?? Infinity) - (b.metrics?.rsi ?? Infinity);
  });

  const sigLabel = (a: Signal["action"]) => a === "buy" ? "🚀 BUY" : a === "sell" ? "💰 SELL" : "✋ HOLD";

  const cards = rows.map((sig) => {
    const m = sig.metrics;
    const pos = posMap.get(sig.symbol);

    // Buy gates as pills.
    let gates = "";
    if (m) {
      const trendPct = m.trendSma ? ((sig.price - m.trendSma) / m.trendSma) * 100 : 0;
      const rsiOk = m.rsi !== null && m.rsi <= s.rsiOversold;
      const dipOk = (m.dip ?? 0) > 0;
      gates = `
        <span class="gate ${m.trendUp ? "ok" : ""}">📈 Trend ${signed(trendPct, 1)}%</span>
        <span class="gate ${rsiOk ? "ok" : ""}">RSI ${m.rsi !== null ? m.rsi.toFixed(0) : "—"}</span>
        <span class="gate ${dipOk ? "ok" : ""}">${dipOk ? `Dip -${((m.dip ?? 0) * 100).toFixed(1)}%` : "above SMA"}</span>`;
    }

    // RSI meter (0-100), oversold≤35 green-ish, overbought≥65 red-ish.
    let meter = "";
    if (m && m.rsi !== null) {
      const r = Math.max(0, Math.min(100, m.rsi));
      const c = r <= s.rsiOversold ? "var(--green)" : r >= s.rsiOverbought ? "var(--red)" : "var(--gold)";
      meter = `<div class="rsibar"><i style="width:${r}%;background:${c}"></i></div>`;
    }

    // News: five-level tag + up to 3 recent headlines.
    let news = `<div class="news"><span class="tag neu">no news</span></div>`;
    const nw = sig.news;
    if (nw && nw.count > 0) {
      const blocked = sig.reason.startsWith("dip on bad news");
      const key = blocked ? "terrible" : (nw.sentiment ?? "neutral");
      const meta = SENT[key] ?? { cls: "neu", label: "😐 MEH" };
      const heads = (nw.headlines && nw.headlines.length ? nw.headlines : nw.latest ? [nw.latest] : [])
        .slice(0, 3).map((h) => `<li title="${esc(h)}">${esc(truncate(h, 90))}</li>`).join("");
      news = `<div class="news">
        <span class="tag ${meta.cls}">${meta.label}</span>
        <span class="muted" style="font-size:.74rem;margin-left:.4rem">${nw.count} headline${nw.count === 1 ? "" : "s"}/24h${blocked ? " · ⚠ buy blocked" : ""}</span>
        <ul class="heads">${heads}</ul>
      </div>`;
    }

    let held = "";
    if (pos) {
      const cls = pctCls(pos.unrealized_pl);
      held = `<div class="held">💎 holding ${pos.qty.toFixed(2)} sh · <span class="${cls}">${signed(pos.unrealized_plpc * 100)}%</span></div>`;
    }

    return `<div class="card wcard ${sig.action}">
      <div class="top" style="display:flex;justify-content:space-between;align-items:center">
        <span><span class="ticker">${sig.symbol}</span> <span class="sector">${config.sectors[sig.symbol] ?? ""}</span></span>
        <span class="sig ${sig.action}" title="${esc(sig.reason)}">${sigLabel(sig.action)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="price">${sig.price > 0 ? money(sig.price) : "—"}</span>${held}
      </div>
      ${meter}
      <div class="gates">${gates}</div>
      ${news}
    </div>`;
  }).join("");

  const when = etTime(snap.t, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `<p class="muted">Scanned ${when} ET · a 🚀 BUY needs all three gates green: uptrend, RSI ≤ ${s.rsiOversold}, below SMA${s.smaPeriod} — and a clean news read.</p>
    <div class="grid cards">${cards}</div>`;
}
// #endregion

// #region closed positions table
function renderTrades(): string {
  const trades = loadTrades();
  if (!trades.length) return `<p class="muted">No closed positions yet. The bot is being patient (or asleep). 😴</p>`;
  const realized = trades.reduce((a, t) => a + t.realizedPl, 0);
  const wins = trades.filter((t) => t.realizedPl >= 0).length;
  const rows = [...trades].reverse().map((t) => {
    const cls = pctCls(t.realizedPl);
    const emoji = t.realizedPl >= 0 ? "🟩" : "🟥";
    return `<tr>
      <td>${emoji} <b>${t.symbol}</b> <span class="sector">${t.sector}</span></td>
      <td class="hide-sm">${t.qty.toFixed(2)}</td>
      <td class="hide-sm">${money(t.entryPrice)}</td>
      <td>${money(t.exitPrice)}</td>
      <td class="hide-sm">${money(t.value)}</td>
      <td class="${cls}">${signed(t.realizedPl)}$ (${signed(t.realizedPlPct * 100)}%)</td>
      <td class="hide-sm muted">${etTime(t.closedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
      <td class="muted">${esc(truncate(t.reason, 46))}</td>
    </tr>`;
  }).join("");
  const rcls = pctCls(realized);
  return `<p class="muted">${trades.length} closed · ${wins} 🟩 / ${trades.length - wins} 🟥 · realized
      <b class="${rcls}">${signed(realized)}$</b></p>
    <div class="scroll"><table>
      <tr><th>Symbol</th><th class="hide-sm">Qty</th><th class="hide-sm">Entry</th><th>Exit</th><th class="hide-sm">Value</th><th>P/L</th><th class="hide-sm">Closed</th><th>Why it sold</th></tr>
      ${rows}
    </table></div>`;
}
// #endregion

// #region render cache
// The page is public, and every render makes a handful of Alpaca calls with the
// SAME keys the bot trades on. Caching the rendered HTML for a few seconds bounds
// dashboard-driven Alpaca traffic to ~a call-batch every CACHE_MS regardless of
// how many people load it, so public views can never rate-limit the bot. 15s is
// invisible against the 60s auto-refresh.
const CACHE_MS = 15_000;
let cached: { html: string; at: number } | null = null;

async function renderCached(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.html;
  try {
    const html = await render();
    cached = { html, at: now };
    return html;
  } catch (err) {
    // A render failure (e.g. Alpaca down) should not blank the public page.
    // Serve the last good render if we have one; otherwise rethrow to the
    // route handler's error page.
    if (cached) return cached.html;
    throw err;
  }
}
// #endregion

// #region JSON state endpoint
// A compact, public, read-only snapshot for external widgets (the n.filipkin.com
// homepage banner card). Shares the same Alpaca keys the bot trades on, so it gets
// its own CACHE_MS cache to bound dashboard-driven Alpaca traffic exactly like the
// HTML page — many widget viewers can never rate-limit the bot.
type StateJson = {
  equity: number;
  dayChange: number;
  botReturn: number | null;
  benchReturn: number | null;
  edge: number | null;
  openPositions: number;
  maxPositions: number;
  cash: number;
  marketOpen: boolean | null;
  mode: string;
  at: number;
};

async function computeStateJson(): Promise<StateJson> {
  const state = await loadState();
  const [acctRes, benchRes, posRes, clockRes] = await Promise.allSettled([
    getAccount(), getLatestPrice(config.benchmark), getPositions(), getClock(),
  ]);
  const acct = acctRes.status === "fulfilled" ? acctRes.value : null;
  const benchNow = benchRes.status === "fulfilled" ? benchRes.value : null;
  const positions = posRes.status === "fulfilled" ? posRes.value : [];
  const clock = clockRes.status === "fulfilled" ? clockRes.value : null;

  const equity = acct?.equity ?? state.dayOpenEquity;
  const dayChange = state.dayOpenEquity > 0 ? ((equity - state.dayOpenEquity) / state.dayOpenEquity) * 100 : 0;
  const botReturn = state.inceptionEquity > 0 ? ((equity - state.inceptionEquity) / state.inceptionEquity) * 100 : null;
  const benchReturn = benchNow && state.benchmarkInceptionPrice > 0
    ? ((benchNow - state.benchmarkInceptionPrice) / state.benchmarkInceptionPrice) * 100 : null;
  const edge = botReturn !== null && benchReturn !== null ? botReturn - benchReturn : null;

  return {
    equity,
    dayChange,
    botReturn,
    benchReturn,
    edge,
    openPositions: positions.length,
    maxPositions: config.risk.maxOpenPositions,
    cash: acct?.cash ?? 0,
    marketOpen: clock ? clock.is_open : null,
    mode: config.mode,
    at: Date.now(),
  };
}

let stateCache: { data: StateJson; at: number } | null = null;
async function stateCached(): Promise<StateJson> {
  const now = Date.now();
  if (stateCache && now - stateCache.at < CACHE_MS) return stateCache.data;
  const data = await computeStateJson();
  stateCache = { data, at: now };
  return data;
}
// #endregion

// #region experiment page cache
// The arena page reads SQLite + one SCHD price; cache it per sort key so many
// public viewers can't multiply the single benchmark call.
type ExpSort = "return" | "expectancy" | "pf" | "winrate" | "drawdown" | "trades";
const EXP_SORTS: ExpSort[] = ["return", "expectancy", "pf", "winrate", "drawdown", "trades"];
const expCache = new Map<ExpSort, { html: string; at: number }>();

async function experimentCached(sort: ExpSort): Promise<string> {
  const now = Date.now();
  const hit = expCache.get(sort);
  if (hit && now - hit.at < CACHE_MS) return hit.html;
  const html = await renderExperiment(sort);
  expCache.set(sort, { html, at: now });
  return html;
}

// One arm's live-bot-style detail page. Keyed by arm id; reads SQLite + the same
// single shared SCHD price, so it gets the same short cache as the arena page to
// keep public views from multiplying that benchmark call.
const armCache = new Map<number, { html: string; at: number }>();
async function armDetailCached(id: number): Promise<string> {
  const now = Date.now();
  const hit = armCache.get(id);
  if (hit && now - hit.at < CACHE_MS) return hit.html;
  const html = await renderArmDetail(id);
  armCache.set(id, { html, at: now });
  return html;
}
// #endregion

const server = Bun.serve({
  port: config.dashboardPort,
  // Default is 10s. A cold render fans out several Alpaca calls (each capped at
  // 8s); give the request enough headroom to finish and serve rather than being
  // reaped mid-render.
  idleTimeout: 30,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/api/state") {
      const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
      try {
        return Response.json(await stateCached(), { headers: cors });
      } catch (err) {
        return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502, headers: cors });
      }
    }
    if (pathname === "/experiment/arm") {
      try {
        const id = Number(searchParams.get("id"));
        // Reject non-arms BEFORE the cache write: the endpoint is public and
        // enumerable, so caching arbitrary ids would grow armCache without bound.
        if (!Number.isInteger(id) || id <= 0 || !armExists(id)) {
          return new Response("no such arm", { status: 404 });
        }
        return page(await armDetailCached(id));
      } catch (err) {
        return page(`<body style="background:#0a0b0d;color:#ea3943;font-family:system-ui;padding:2rem">
          <h1>arm view hiccup 🫠</h1><pre>${esc(String(err instanceof Error ? err.stack ?? err.message : err))}</pre></body>`);
      }
    }
    if (pathname === "/experiment") {
      try {
        const raw = searchParams.get("sort") as ExpSort | null;
        const sort: ExpSort = raw && EXP_SORTS.includes(raw) ? raw : "return";
        return page(await experimentCached(sort));
      } catch (err) {
        return page(`<body style="background:#0a0b0d;color:#ea3943;font-family:system-ui;padding:2rem">
          <h1>arena hiccup 🫠</h1><pre>${esc(String(err instanceof Error ? err.stack ?? err.message : err))}</pre></body>`);
      }
    }
    try {
      return page(await renderCached());
    } catch (err) {
      return page(`<body style="background:#0a0b0d;color:#ea3943;font-family:system-ui;padding:2rem">
        <h1>stonkbot dashboard hiccup 🫠</h1><pre>${esc(String(err instanceof Error ? err.stack ?? err.message : err))}</pre></body>`);
    }
  },
});
console.log(`dashboard on http://0.0.0.0:${server.port}`);
// #endregion
