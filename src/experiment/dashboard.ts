// #region experiment dashboard — "the arena"
// A dedicated, server-rendered page for the 40-arm experiment: a live race of
// competing algorithms. Champion hero, a 4-week countdown, a diverging "tug of
// war" standings bar per arm (colored by experiment block), a multi-line equity
// chart of the top arms vs SCHD, and a full sortable metrics table. Reads only
// SQLite + one SCHD price, so it never rate-limits the live bot.
import { config } from "../config";
import { getLatestPrice } from "../alpaca";
import {
  loadArmLeaderboard, loadArmEquitySeries, loadBenchmarkHistory, getMeta,
  type ArmLeaderboardRow,
} from "../db";
import { ARMS, BASE_STRATEGY, BASE_RAILS, type Arm } from "./params";
import { POOLS } from "./pools";

// #region helpers
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const signed = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const cls = (n: number) => (n >= 0 ? "up" : "down");
const EXP_DAYS = 28; // 4-week run

// Which experiment block an arm belongs to, for color-coding the field. Derived
// from the pre-registered id ranges (see params.ts).
interface Block { key: string; label: string; color: string; }
const BLOCKS: Record<string, Block> = {
  control: { key: "control", label: "Control", color: "#c7ccd6" },
  exit: { key: "exit", label: "Exit (H1)", color: "#16c784" },
  entry: { key: "entry", label: "Entry (H2)", color: "#5b9dff" },
  sizing: { key: "sizing", label: "Sizing (H3)", color: "#a97bff" },
  universe: { key: "universe", label: "Universe", color: "#f0b90b" },
  combo: { key: "combo", label: "Combination", color: "#ff6ac1" },
};
function blockOf(id: number): Block {
  if (id === 1) return BLOCKS.control!;
  if (id <= 11) return BLOCKS.exit!;
  if (id <= 18) return BLOCKS.entry!;
  if (id <= 26) return BLOCKS.sizing!;
  if (id <= 31) return BLOCKS.universe!;
  return BLOCKS.combo!;
}
const armMeta = new Map(ARMS.map((a) => [a.id, a]));
function poolOf(id: number): string { return armMeta.get(id)?.pool ?? "P0"; }

// A short human label for each universe pool (id -> what it is + how many names).
const POOL_DESC: Record<string, string> = {
  P0: "34 large-caps (control watchlist)",
  P1: "~100 liquid S&P-100 names",
  P2: "high-beta semis + growth",
  P3: "low-vol / dividend blue-chips",
  P4: "tech-only",
  P5: "sector-SPDR ETFs",
};
function poolLabel(id: string): string {
  return `${id} · ${POOL_DESC[id] ?? id} (${(POOLS as Record<string, string[]>)[id]?.length ?? "?"})`;
}
// #endregion

// #region strategy recipe (concrete param diffs vs the Control)
// Turns an arm's parameters into a plain-language list of exactly what it changed
// from the baseline (the Control's config). Derived from the live params, so the
// on-page explanation can never drift out of sync with what the arm actually runs.
const pct = (f: number) => `${+(f * 100).toFixed(2)}%`;

function paramChips(a: Arm): string[] {
  const s = a.strategy, rs = a.rails;
  const B = BASE_STRATEGY, R = BASE_RAILS;
  const out: string[] = [];

  // Universe first — the biggest structural difference.
  if (a.pool !== "P0") out.push(`pool ${poolLabel(a.pool)}`);

  // Entry gates.
  if (s.rsiOversold !== B.rsiOversold) out.push(`buy dip at RSI ≤ ${s.rsiOversold} (base ${B.rsiOversold})`);
  if (s.maxDipFraction !== B.maxDipFraction) out.push(`skip dips deeper than ${pct(s.maxDipFraction)} (base ${pct(B.maxDipFraction)})`);
  if (s.trendSmaPeriodDays !== B.trendSmaPeriodDays) out.push(`uptrend gate = ${s.trendSmaPeriodDays}-day SMA (base ${B.trendSmaPeriodDays})`);
  if (s.newsVeto !== B.newsVeto) out.push(s.newsVeto ? "AI news veto ON" : "AI news veto OFF");

  // Exits.
  if (s.atrStopMult !== null) out.push(`stop = ${s.atrStopMult}× ATR (volatility-scaled)`);
  else if (s.stopLossFraction !== B.stopLossFraction) out.push(`stop-loss ${pct(s.stopLossFraction)} (base ${pct(B.stopLossFraction)})`);

  if (s.atrTakeProfitMult !== null) out.push(`take-profit = ${s.atrTakeProfitMult}× ATR`);
  else if (s.takeProfitFraction !== B.takeProfitFraction) {
    out.push(s.takeProfitFraction === null ? "no fixed take-profit" : `take-profit ${pct(s.takeProfitFraction)} (base ${pct(B.takeProfitFraction!)})`);
  }

  if (s.trailingStopFraction !== B.trailingStopFraction && s.trailingStopFraction !== null) {
    out.push(`trailing stop ${pct(s.trailingStopFraction)} below the high`);
  }
  if (s.rsiOverbought !== B.rsiOverbought) {
    out.push(s.rsiOverbought === null ? "RSI momentum exit OFF (let winners run)" : `RSI momentum exit at ${s.rsiOverbought}`);
  }
  if (s.minHoldMinutes !== B.minHoldMinutes) out.push(`min hold ${s.minHoldMinutes}m before a discretionary exit`);

  // Sizing & rails.
  if (rs.maxPositionFraction !== R.maxPositionFraction) out.push(`position size ${pct(rs.maxPositionFraction)} of equity (base ${pct(R.maxPositionFraction)})`);
  if (rs.maxOpenPositions !== R.maxOpenPositions) out.push(`max ${rs.maxOpenPositions} open positions (base ${R.maxOpenPositions})`);
  if (rs.maxPerSector !== R.maxPerSector) out.push(Number.isFinite(rs.maxPerSector) ? `max ${rs.maxPerSector} per sector (base ${R.maxPerSector})` : "no per-sector cap");
  if (rs.cashBufferFraction !== R.cashBufferFraction) out.push(`cash buffer ${pct(rs.cashBufferFraction)} (base ${pct(R.cashBufferFraction)})`);
  if (rs.dailyLossCapFraction !== R.dailyLossCapFraction) out.push(`daily loss halt at ${pct(rs.dailyLossCapFraction)} (base ${pct(R.dailyLossCapFraction)})`);
  if (rs.maxBuysPerCycle !== R.maxBuysPerCycle) out.push(`${rs.maxBuysPerCycle} buys per cycle (base ${R.maxBuysPerCycle})`);

  if (out.length === 0) out.push("exact baseline config — the untouched yardstick");
  return out;
}

// One-line joined recipe, for hover tooltips.
function strategyText(a: Arm): string {
  return paramChips(a).join(" · ");
}
// #endregion

type SortKey = "return" | "expectancy" | "pf" | "winrate" | "drawdown" | "trades";

export async function renderExperiment(sort: SortKey = "return"): Promise<string> {
  const board = loadArmLeaderboard(); // already sorted by return desc
  const started = getMeta("exp_started_at");
  const benchInception = Number(getMeta("exp_bench_inception_price") ?? "0");

  let schdReturn: number | null = null;
  try {
    const now = await getLatestPrice(config.benchmark);
    if (now && benchInception > 0) schdReturn = ((now - benchInception) / benchInception) * 100;
  } catch { /* benchmark line is best-effort */ }

  if (board.length === 0) {
    return shell(`<div class="empty">🏟️ The arena is set. ${ARMS.length} algorithms are entering the ring —
      standings appear after the first market-hours cycle.</div>`);
  }

  const beating = schdReturn !== null ? board.filter((r) => r.returnPct > schdReturn!).length : null;
  const champ = board[0]!;

  // Countdown.
  let dayLine = "warming up";
  let progress = 0;
  if (started) {
    const elapsedMs = Date.now() - new Date(started).getTime();
    const elapsedDays = Math.max(0, elapsedMs / (24 * 60 * 60 * 1000));
    progress = Math.min(1, elapsedDays / EXP_DAYS);
    const dayNo = Math.min(EXP_DAYS, Math.floor(elapsedDays) + 1);
    dayLine = `Day ${dayNo} of ${EXP_DAYS} · ${Math.max(0, EXP_DAYS - elapsedDays).toFixed(0)} days left`;
  }

  return shell(`
    ${renderHero(champ, schdReturn, beating, board.length)}
    ${renderCountdown(dayLine, progress)}
    ${renderRace(board, schdReturn)}
    ${renderChart(board, schdReturn)}
    ${renderTable(board, sort, schdReturn)}
    ${renderPlaybook()}
    ${renderLegend()}
  `, board.length);
}

// #region hero
function renderHero(champ: ArmLeaderboardRow, schd: number | null, beating: number | null, field: number): string {
  const b = blockOf(champ.armId);
  const name = champ.name || `Arm ${champ.armId}`;
  const beatLine = beating !== null
    ? `<b class="${beating > field / 2 ? "up" : "down"}">${beating}/${field}</b> arms beating SCHD (${schd === null ? "—" : signed(schd) + "%"})`
    : "SCHD warming up";
  const arm = armMeta.get(champ.armId);
  const chips = arm ? paramChips(arm).map((c) => `<span class="chip">${esc(c)}</span>`).join("") : "";
  return `<div class="hero">
    <div class="crown">👑 CURRENT CHAMPION</div>
    <div class="champ">
      <span class="cname" style="border-color:${b.color}">${esc(name)}</span>
      <span class="cret ${cls(champ.returnPct)}">${signed(champ.returnPct)}%</span>
    </div>
    <div class="chyp">${esc(champ.hypothesis)}</div>
    ${chips ? `<div class="chips herochips">${chips}</div>` : ""}
    <div class="csub">${beatLine} · ${field} algorithms · $1,000 each · winner trades real money 💵</div>
  </div>`;
}
// #endregion

// #region countdown
function renderCountdown(line: string, progress: number): string {
  return `<div class="count">
    <div class="cbar"><i style="width:${(progress * 100).toFixed(1)}%"></i></div>
    <div class="cline">${line}</div>
  </div>`;
}
// #endregion

// #region race (diverging standings bars)
function renderRace(board: ArmLeaderboardRow[], schd: number | null): string {
  const maxAbs = Math.max(1, ...board.map((r) => Math.abs(r.returnPct)), schd ? Math.abs(schd) : 0);
  const medals = ["🥇", "🥈", "🥉"];
  const rows = board.map((r, i) => {
    const b = blockOf(r.armId);
    const name = r.name || `Arm ${r.armId}`;
    const pos = r.returnPct >= 0;
    const w = (Math.abs(r.returnPct) / maxAbs) * 50; // half-width max (diverging)
    const bar = pos
      ? `<i class="pos" style="left:50%;width:${w.toFixed(1)}%;background:${b.color}"></i>`
      : `<i class="neg" style="right:50%;width:${w.toFixed(1)}%;background:${b.color}"></i>`;
    const medal = medals[i] ?? `<span class="rank">${i + 1}</span>`;
    const arm = armMeta.get(r.armId);
    const tip = arm ? `${r.hypothesis}\n\nStrategy: ${strategyText(arm)}` : r.hypothesis;
    return `<div class="rrow" title="${esc(tip)}">
      <span class="rmedal">${medal}</span>
      <span class="rname"><span class="dot" style="background:${b.color}"></span>${esc(name)}</span>
      <span class="rtrack"><span class="mid"></span>${bar}</span>
      <span class="rret ${cls(r.returnPct)}">${signed(r.returnPct)}%</span>
      <span class="rmeta">${r.trades}t</span>
    </div>`;
  }).join("");

  const schdMark = schd !== null
    ? `<div class="schdrow"><span class="rmedal">🛡️</span><span class="rname">SCHD benchmark</span>
        <span class="rtrack"><span class="mid"></span><i class="${schd >= 0 ? "pos" : "neg"}" style="${schd >= 0 ? "left:50%" : "right:50%"};width:${((Math.abs(schd) / maxAbs) * 50).toFixed(1)}%;background:#f0b90b;opacity:.55"></i></span>
        <span class="rret ${cls(schd)}">${signed(schd)}%</span><span class="rmeta">bench</span></div>`
    : "";

  return `<h2>🏁 The Standings</h2>${schdMark}<div class="race">${rows}</div>`;
}
// #endregion

// #region multi-line equity chart (top arms vs SCHD)
function renderChart(board: ArmLeaderboardRow[], schdLive: number | null): string {
  const CONTROL_ID = 1;      // "The Control" — the yardstick, always shown
  const NCOMP = 5;           // how many competitor arms to plot besides Control
  // Distinct hues (not the repeating block palette) so 5 arms are each their own
  // colour. Amber/grey are reserved below for the SCHD/Control reference lines.
  const PALETTE = ["#5b9dff", "#ff5c8a", "#2ee6a6", "#ff9d3c", "#b98bff"];
  const short = (s: string, n = 15) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const compRows = board.filter((r) => r.armId !== CONTROL_ID).slice(0, NCOMP);
  const controlRow = board.find((r) => r.armId === CONTROL_ID);
  const armRows = [...compRows, ...(controlRow ? [controlRow] : [])];
  const rawById = new Map(armRows.map((r) => [r.armId, loadArmEquitySeries(r.armId).map((p) => ({ t: p.t, v: p.equity }))]));

  if (!compRows.some((r) => (rawById.get(r.armId)?.length ?? 0) >= 2)) {
    return `<h2>📈 Equity Race <span class="sub">top ${NCOMP} + Control vs SCHD</span></h2>
      <p class="muted">Curves populate as equity samples accrue…</p>`;
  }

  // Anchor EVERY line to one shared t0 = the experiment start, so all curves
  // begin at 0% at the same x. The arms began ~2 days after SCHD's backfilled
  // history, so the old per-series rebase put SCHD's 0% two days left of the
  // arms' 0% — the lines started at different points and couldn't be compared.
  // (This matches the t0 the hero/standings already use for the SCHD number.)
  const t0 = Math.min(...armRows.flatMap((r) => (rawById.get(r.armId) ?? []).map((p) => new Date(p.t).getTime())));

  type Line = { name: string; color: string; dash: string | null; width: number; ref: boolean; pts: { t: number; r: number }[] };
  const series: Line[] = [];
  compRows.forEach((r, i) => {
    const pts = rebaseFrom(rawById.get(r.armId) ?? [], t0);
    if (pts.length < 2) return;
    series.push({ name: r.name || `Arm ${r.armId}`, color: PALETTE[i % PALETTE.length]!, dash: null, width: i === 0 ? 3 : 2, ref: false, pts });
  });
  const controlPts = controlRow ? rebaseFrom(rawById.get(CONTROL_ID) ?? [], t0) : [];
  if (controlPts.length >= 2) series.push({ name: "Control", color: "#aab2c0", dash: "1 5", width: 2, ref: true, pts: controlPts });
  const bench = rebaseFrom(loadBenchmarkHistory().filter((p) => inRegularHours(p.t)).map((p) => ({ t: p.t, v: p.price })), t0);
  if (bench.length >= 2) series.push({ name: "SCHD", color: "#f0b90b", dash: "6 4", width: 2, ref: true, pts: bench });

  const W = 1120, H = 300, padL = 60, padR = 132, padT = 16, padB = 30;
  const plotW = W - padL - padR;
  const allPts = series.flatMap((s) => s.pts);
  const rMin = Math.min(0, ...allPts.map((p) => p.r));
  const rMax = Math.max(0, ...allPts.map((p) => p.r));
  const rRange = rMax - rMin || 1;

  // Shared compressed-time x-axis (collapse overnight/weekend gaps to slivers).
  const GAP_CAP = 20 * 60 * 1000;
  const times = Array.from(new Set(allPts.map((p) => p.t))).sort((a, b) => a - b);
  const cxOf = new Map<number, number>();
  let cx = 0;
  cxOf.set(times[0]!, 0);
  for (let i = 1; i < times.length; i++) {
    cx += Math.min(times[i]! - times[i - 1]!, GAP_CAP);
    cxOf.set(times[i]!, cx);
  }
  const cxTotal = cx || 1;
  const x = (t: number) => padL + ((cxOf.get(t) ?? 0) / cxTotal) * plotW;
  const y = (r: number) => padT + (1 - (r - rMin) / rRange) * (H - padT - padB);
  const pathOf = (pts: { t: number; r: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.r).toFixed(1)}`).join(" ");

  // Y grid: nice % ticks, with a solid, labeled 0% baseline.
  const yGrid = niceTicks(rMin, rMax, 5).map((v) => {
    const yy = y(v).toFixed(1);
    const zero = Math.abs(v) < 1e-9;
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--border)" stroke-width="1"${zero ? "" : ` stroke-dasharray="2 5" opacity=".45"`}/>
      <text x="${padL - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle" class="axlbl">${zero ? "0" : v.toFixed(Math.abs(v) < 1 ? 2 : 1)}%</text>`;
  }).join("");

  // X ticks: an ADAPTIVE ET time scale on the compressed axis. While the whole
  // race fits in a day or two, tick the clock (9:30, 11:00, 13:00 …) so you can
  // read time-of-day; once it spans more days, fall back to one date tick per
  // day (thinned so a 4-week run doesn't crowd). Each day's first tick carries
  // the date, later intraday ticks show just the time.
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: false });
  const etDay = (t: number) => dayFmt.format(new Date(t));
  const etClock = (t: number) => clockFmt.format(new Date(t)).replace(/^24:/, "0:");
  const etMinutes = (t: number) => { const [h, m] = etClock(t).split(":"); return Number(h) * 60 + Number(m); };

  const dayCount = new Set(times.map(etDay)).size;
  const stepMin = dayCount <= 1 ? 60 : dayCount <= 3 ? 120 : 0; // 0 => one tick per day
  const dayEvery = Math.max(1, Math.ceil(dayCount / 8));
  const hhmm = (mins: number) => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  const xTick = (t: number, label: string) => {
    const xx = x(t).toFixed(1);
    return `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 5" opacity=".35"/>
      <text x="${xx}" y="${H - padB + 15}" text-anchor="middle" class="axlbl">${label}</text>`;
  };
  let lastDay = "", lastSlot = -1, dayIdx = -1;
  const xGrid = times.map((t) => {
    const d = etDay(t);
    if (d !== lastDay) {
      lastDay = d; dayIdx++;
      lastSlot = stepMin ? Math.floor(etMinutes(t) / stepMin) : -1;
      if (stepMin) return xTick(t, `${d} ${etClock(t)}`); // day's first tick = the open, exact
      return dayIdx % dayEvery === 0 ? xTick(t, d) : "";
    }
    if (!stepMin) return "";
    const slot = Math.floor(etMinutes(t) / stepMin);
    if (slot === lastSlot) return "";
    lastSlot = slot;
    return xTick(t, hhmm(slot * stepMin)); // label the round boundary (11:00), not the 11:01 sample
  }).join("");

  // Direct end-of-line labels (so you don't have to match legend colours). Push
  // labels apart vertically so they never overlap, then keep them on-canvas.
  const rawY = series.map((s) => y(s.pts[s.pts.length - 1]!.r));
  const order = series.map((_, i) => i).sort((a, b) => rawY[a]! - rawY[b]!);
  const labelY: number[] = [];
  const MIN = 15;
  let prev = -Infinity;
  for (const i of order) { const yv = Math.max(rawY[i]!, prev + MIN); labelY[i] = yv; prev = yv; }
  const overflow = (labelY[order[order.length - 1]!] ?? 0) - (H - 6);
  if (overflow > 0) for (const i of order) labelY[i]! -= overflow;
  const topClip = (padT + 4) - (labelY[order[0]!] ?? padT);
  if (topClip > 0) for (const i of order) labelY[i]! += topClip;

  const labelX = W - padR + 12;
  const groups = series.map((s, i) => {
    const d = pathOf(s.pts);
    const last = s.pts[s.pts.length - 1]!;
    const ex = x(last.t).toFixed(1), ey = y(last.r).toFixed(1);
    const ly = labelY[i]!.toFixed(1);
    const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : "";
    return `<g class="ser${s.ref ? " ref" : ""}">
      <path d="${d}" fill="none" stroke="transparent" stroke-width="13"/>
      <path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}"${dash} stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${ex}" cy="${ey}" r="2.6" fill="${s.color}"/>
      <line x1="${ex}" y1="${ey}" x2="${(labelX - 4).toFixed(1)}" y2="${ly}" stroke="${s.color}" stroke-width="1" opacity=".35"/>
      <text x="${labelX}" y="${ly}" dominant-baseline="middle" class="endlbl" fill="${s.color}">${esc(short(s.name))}${s.ref ? " ·ref" : ""}</text>
    </g>`;
  });
  // Draw references first (underneath), then competitors, leader last (on top).
  const drawn = [
    ...groups.filter((_, i) => series[i]!.ref),
    ...groups.filter((_, i) => !series[i]!.ref).reverse(),
  ].join("");

  const legend = series.map((s) => {
    const lastR = s.pts[s.pts.length - 1]!.r;
    const val = s.name === "SCHD" && schdLive !== null ? schdLive : lastR;
    const sw = s.ref
      ? `<span class="swatch dash" style="--c:${s.color}"></span>`
      : `<span class="swatch" style="background:${s.color}"></span>`;
    return `<span class="k">${sw}${esc(s.name)} <b class="${cls(val)}">${signed(val)}%</b></span>`;
  }).join("");

  return `<h2>📈 Equity Race <span class="sub">top ${NCOMP} + Control vs SCHD · % return since experiment start</span></h2>
    <div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cumulative % return of the top arms, the Control, and SCHD since the experiment started. Hover a line to isolate it.">
      ${yGrid}${xGrid}${drawn}
    </svg><div class="legend">${legend}</div>
    <p class="chartnote">Source: Alpaca (IEX free feed), sampled every 5 min during US market hours; times ET.
      Arms are paper-simulated $1,000 books (fills at the last trade price, no slippage or fees).
      SCHD is the live ETF price rebased to the same start. Each line is cumulative % return from ${dayFmt.format(new Date(t0))}.</p>
    </div>`;
}
// #endregion

// #region metrics table (server-side sortable via ?sort=)
function renderTable(board: ArmLeaderboardRow[], sort: SortKey, schd: number | null): string {
  const sorted = [...board].sort((a, b) => {
    switch (sort) {
      case "expectancy": return b.expectancy - a.expectancy;
      case "pf": return (b.profitFactor ?? -1) - (a.profitFactor ?? -1);
      case "winrate": return b.winRatePct - a.winRatePct;
      case "drawdown": return a.maxDrawdownPct - b.maxDrawdownPct; // lower is better
      case "trades": return b.trades - a.trades;
      default: return b.returnPct - a.returnPct;
    }
  });

  const th = (key: SortKey, label: string) =>
    `<th class="sortable ${sort === key ? "active" : ""}"><a href="/experiment?sort=${key}">${label}${sort === key ? " ▾" : ""}</a></th>`;

  const rows = sorted.map((r, i) => {
    const b = blockOf(r.armId);
    const name = r.name || `Arm ${r.armId}`;
    const pf = r.profitFactor === null ? "—" : r.profitFactor.toFixed(2);
    const inconclusive = r.trades < 30;
    const beatSchd = schd !== null && r.returnPct > schd;
    const arm = armMeta.get(r.armId);
    const tip = arm ? `${r.hypothesis}\n\nStrategy: ${strategyText(arm)}` : r.hypothesis;
    return `<tr>
      <td class="muted">${i + 1}</td>
      <td title="${esc(tip)}"><span class="dot" style="background:${b.color}"></span><b>${esc(name)}</b>
        <span class="btag" style="color:${b.color}">${b.label}</span>
        <span class="pooltag">${poolOf(r.armId)}</span>${beatSchd ? ` <span class="beat">▲SCHD</span>` : ""}</td>
      <td class="${cls(r.returnPct)}"><b>${signed(r.returnPct)}%</b></td>
      <td class="${cls(r.expectancy)}">${signed(r.expectancy)}</td>
      <td>${pf}</td>
      <td>${r.winRatePct.toFixed(0)}%</td>
      <td class="down">-${r.maxDrawdownPct.toFixed(1)}%</td>
      <td class="${inconclusive ? "muted" : ""}">${r.trades}${inconclusive ? "*" : ""}</td>
      <td class="muted">${r.openPositions}</td>
    </tr>`;
  }).join("");

  return `<h2>🔬 Full Metrics <span class="sub">click a column to rank · * = &lt;30 trades, inconclusive</span></h2>
    <div class="scroll"><table>
      <tr><th>#</th><th>Algorithm</th>${th("return", "Return")}${th("expectancy", "Expectancy $")}${th("pf", "Profit factor")}${th("winrate", "Win rate")}${th("drawdown", "Max DD")}${th("trades", "Trades")}<th>Open</th></tr>
      ${rows}
    </table></div>`;
}
// #endregion

// #region playbook (what every arm actually does)
// A browsable reference of all 40 strategies in pre-registered order: the exact
// knob changes each arm makes vs the Control (as chips) plus its thesis. This is
// the "what is each bot doing" answer, always in sync with the live params.
function renderPlaybook(): string {
  let lastBlock = "";
  const rows = ARMS.map((a) => {
    const b = blockOf(a.id);
    const name = a.name || `Arm ${a.id}`;
    const chips = paramChips(a).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
    let header = "";
    if (b.label !== lastBlock) {
      lastBlock = b.label;
      header = `<tr class="blockhead"><td colspan="3"><span class="dot" style="background:${b.color}"></span>${b.label}</td></tr>`;
    }
    return `${header}<tr>
      <td class="pbname"><b>${esc(name)}</b>
        <span class="pbid muted">#${a.id}</span>
        <span class="pooltag">${a.pool}</span></td>
      <td class="pbchips"><div class="chips">${chips}</div></td>
      <td class="pbwhy muted">${esc(a.hypothesis)}</td>
    </tr>`;
  }).join("");

  return `<h2>📖 The Playbook <span class="sub">what each algorithm changes vs the Control, and why</span></h2>
    <div class="scroll"><table class="playbook">
      <tr><th>Algorithm</th><th>What it does differently</th><th>Thesis</th></tr>
      ${rows}
    </table></div>`;
}
// #endregion

function renderLegend(): string {
  const items = Object.values(BLOCKS)
    .map((b) => `<span class="k"><span class="dot" style="background:${b.color}"></span>${b.label}</span>`).join("");
  return `<div class="blocklegend">${items}</div>`;
}

// #region shared chart utils (mirrors the main dashboard)
function inRegularHours(iso: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 570 && mins <= 960;
}
function rebase(pts: { t: string; v: number }[]): { t: number; r: number }[] {
  if (!pts.length) return [];
  const base = pts[0]!.v || 1;
  return pts.map((p) => ({ t: new Date(p.t).getTime(), r: (p.v / base - 1) * 100 }));
}

// Rebase to % return from a SHARED epoch t0: drop anything before t0, then
// measure each series off its first surviving point. Every line then reads 0%
// at the same instant, so their shapes are directly comparable.
function rebaseFrom(pts: { t: string; v: number }[], t0: number): { t: number; r: number }[] {
  const kept = pts
    .map((p) => ({ t: new Date(p.t).getTime(), v: p.v }))
    .filter((p) => p.t >= t0)
    .sort((a, b) => a.t - b.t);
  if (!kept.length) return [];
  const base = kept[0]!.v || 1;
  return kept.map((p) => ({ t: p.t, r: (p.v / base - 1) * 100 }));
}

// "Nice" round axis ticks (…, 1, 2, 5, 10, …) spanning [min,max], always
// including 0 when the range straddles it.
function niceTicks(min: number, max: number, target = 5): number[] {
  const span = (max - min) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / target)));
  const norm = span / target / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks: number[] = [];
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(6)));
  if (!ticks.some((t) => Math.abs(t) < 1e-9) && min <= 0 && max >= 0) ticks.push(0);
  return ticks;
}
// #endregion

// #region page shell
function shell(body: string, field = ARMS.length): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <meta name="color-scheme" content="dark">
  <title>stonkbot arena ⚔️</title>
  <style>
    :root{--bg:#0a0b0d;--panel:#14161b;--panel2:#181b21;--border:#252932;
      --text:#e8eaed;--muted:#8b909a;--green:#16c784;--red:#ea3943;--gold:#f0b90b;--blue:#5b9dff;--violet:#a97bff;}
    *{box-sizing:border-box;}
    body{background:var(--bg);color:var(--text);margin:0;padding:1.5rem;
      font-family:"Inter",system-ui,-apple-system,sans-serif;line-height:1.45;overflow-x:hidden;
      background-image:radial-gradient(1200px 500px at 80% -10%,rgba(255,106,193,.08),transparent),
        radial-gradient(900px 400px at -10% 10%,rgba(91,157,255,.07),transparent);}
    .wrap{max-width:1160px;margin:0 auto;}
    a{color:inherit;text-decoration:none;}
    .up{color:var(--green);} .down{color:var(--red);} .muted{color:var(--muted);}
    h1{font-weight:800;letter-spacing:-.03em;font-size:1.9rem;margin:0;display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;}
    h2{font-weight:700;font-size:1.1rem;margin:2.2rem 0 .5rem;display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;}
    h2 .sub{font-size:.78rem;font-weight:500;color:var(--muted);}
    .topbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem;}
    .navpill{font-size:.8rem;font-weight:700;border:1px solid var(--border);background:var(--panel);
      padding:.3rem .7rem;border-radius:999px;color:var(--muted);}
    .empty{margin:3rem 0;font-size:1.1rem;color:var(--muted);text-align:center;}

    /* hero */
    .hero{margin:1.1rem 0 .4rem;padding:1.3rem 1.4rem;border:1px solid var(--border);border-radius:1rem;
      background:linear-gradient(180deg,rgba(255,106,193,.06),rgba(20,22,27,.4));position:relative;overflow:hidden;}
    .crown{font-size:.72rem;font-weight:800;letter-spacing:.12em;color:var(--gold);text-transform:uppercase;}
    .champ{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;margin:.3rem 0 .2rem;}
    .cname{font-size:2.2rem;font-weight:800;letter-spacing:-.03em;border-bottom:4px solid;padding-bottom:.1rem;}
    .cret{font-size:2.2rem;font-weight:800;letter-spacing:-.03em;}
    .chyp{font-size:.9rem;color:var(--text);opacity:.82;max-width:70ch;}
    .csub{font-size:.82rem;color:var(--muted);margin-top:.4rem;}

    /* countdown */
    .count{margin:1rem 0 .2rem;}
    .cbar{height:8px;border-radius:4px;background:var(--panel2);overflow:hidden;border:1px solid var(--border);}
    .cbar i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--violet));}
    .cline{font-size:.78rem;color:var(--muted);font-weight:600;margin-top:.35rem;}

    /* race */
    .race{display:flex;flex-direction:column;gap:.28rem;}
    .rrow,.schdrow{display:grid;grid-template-columns:1.6rem 12rem 1fr 4.2rem 2.4rem;align-items:center;gap:.5rem;
      padding:.24rem .35rem;border-radius:.4rem;}
    .rrow:hover{background:var(--panel);}
    .schdrow{background:rgba(240,185,11,.05);border:1px dashed rgba(240,185,11,.3);margin-bottom:.3rem;}
    .rmedal{text-align:center;font-size:.95rem;}
    .rank{color:var(--muted);font-size:.8rem;font-weight:700;}
    .rname{font-size:.86rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:.4rem;}
    .dot{width:.6rem;height:.6rem;border-radius:50%;display:inline-block;flex:none;}
    .rtrack{position:relative;height:1.15rem;background:var(--panel2);border-radius:.3rem;overflow:hidden;}
    .rtrack .mid{position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border);}
    .rtrack i{position:absolute;top:0;bottom:0;border-radius:.2rem;opacity:.9;}
    .rret{font-weight:800;font-size:.86rem;text-align:right;}
    .rmeta{font-size:.72rem;color:var(--muted);text-align:right;}
    @media(max-width:640px){.rrow,.schdrow{grid-template-columns:1.4rem 7rem 1fr 3.6rem;}.rmeta{display:none;}}

    /* chart */
    .chartwrap{margin-top:.4rem;overflow-x:auto;}
    /* Box aspect ratio == viewBox (1120:300) so preserveAspectRatio="none"
       scales uniformly and the axis labels are never stretched. min-width keeps
       it legible on phones (scrolls instead of squishing). */
    svg.chart{width:100%;min-width:640px;aspect-ratio:1120 / 300;height:auto;display:block;}
    svg.chart .axlbl{fill:var(--muted);font-size:13px;font-weight:600;}
    svg.chart .endlbl{font-size:12.5px;font-weight:700;}
    /* Reference lines (SCHD, Control) sit quieter than the competitors. */
    svg.chart .ser.ref{opacity:.7;}
    /* Hover any line to isolate it: everything else fades back. */
    svg.chart .ser{transition:opacity .12s ease;}
    svg.chart:hover .ser{opacity:.16;}
    svg.chart:hover .ser:hover{opacity:1;}
    .legend .swatch.dash{width:1rem;height:0;border-top:2px dashed var(--c);border-radius:0;}
    .chartnote{margin:.55rem 0 0;font-size:.72rem;line-height:1.5;color:var(--muted);max-width:70ch;}
    .legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.78rem;font-weight:600;margin-top:.5rem;}
    .legend .k{display:inline-flex;align-items:center;gap:.4rem;}
    .swatch{width:.85rem;height:.28rem;border-radius:2px;display:inline-block;}

    /* table */
    .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:.4rem;border:1px solid var(--border);border-radius:.9rem;}
    table{width:100%;border-collapse:collapse;}
    th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--border);white-space:nowrap;font-size:.84rem;}
    th{color:var(--muted);font-weight:700;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;}
    th.sortable a{color:var(--muted);} th.sortable.active a{color:var(--text);}
    tr:last-child td{border-bottom:none;} tbody tr:hover,table tr:hover{background:var(--panel);}
    .btag{font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-left:.35rem;}
    .pooltag{font-size:.66rem;color:var(--muted);margin-left:.3rem;border:1px solid var(--border);border-radius:.3rem;padding:0 .25rem;}
    .beat{font-size:.66rem;color:var(--green);font-weight:800;}

    /* strategy chips + playbook */
    .chips{display:flex;gap:.35rem;flex-wrap:wrap;}
    .chip{font-size:.72rem;font-weight:600;line-height:1.3;color:var(--text);
      background:var(--panel2);border:1px solid var(--border);border-radius:.4rem;padding:.1rem .45rem;white-space:nowrap;}
    .herochips{margin-top:.6rem;}
    .herochips .chip{background:rgba(255,255,255,.04);}
    table.playbook th,table.playbook td{white-space:normal;vertical-align:top;}
    table.playbook td.pbname{white-space:nowrap;min-width:9rem;}
    table.playbook td.pbchips{min-width:20rem;}
    table.playbook td.pbwhy{font-size:.8rem;max-width:34ch;min-width:16rem;}
    .pbid{font-size:.68rem;margin-left:.3rem;}
    .blockhead td{background:var(--panel);font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);}
    .blockhead .dot{margin-right:.45rem;}

    .blocklegend{display:flex;gap:1.1rem;flex-wrap:wrap;font-size:.76rem;color:var(--muted);font-weight:600;margin-top:1rem;}
    .blocklegend .k{display:inline-flex;align-items:center;gap:.4rem;}
    .foot{color:var(--muted);font-size:.8rem;margin-top:2.4rem;border-top:1px solid var(--border);padding-top:1rem;}
    @media(max-width:640px){body{padding:1rem;}.cname,.cret{font-size:1.6rem;}h1{font-size:1.5rem;}}
  </style></head><body><div class="wrap">
    <div class="topbar">
      <h1>⚔️ stonkbot arena</h1>
      <a class="navpill" href="/">← live bot</a>
    </div>
    <p class="muted" style="margin:.2rem 0 0;font-size:.9rem">${field} algorithms compete on paper for 4 weeks. The winner gets Filip's real money. 🦆</p>
    ${body}
    <div class="foot">Auto-refreshes every 60s · all arms trade the same live market data with isolated virtual books ·
      paper only, <b>not financial advice</b>. May the best duck win.</div>
  </div></body></html>`;
}
// #endregion
// #endregion
