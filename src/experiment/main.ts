// #region experiment main
// Scheduler for the multi-arm experiment. Same 5-minute cadence as the live bot,
// but instead of trading a real paper account it advances 40 virtual books
// against shared market data. Runs as its own container alongside the live bot;
// they share ./data (one SQLite file) and the news classifier shim.
//
// On each market-closed tick it pushes a once-a-day leaderboard check-in, so
// Filip gets a regular read on which algorithm is winning over the 4-week run.
import { config } from "../config";
import { getClock, getLatestPrice } from "../alpaca";
import { loadArmLeaderboard, getMeta, setMeta } from "../db";
import { notify } from "../notify";
import { ARMS, armLabel } from "./params";
import { registerArms, runExperimentCycle } from "./engine";

const CYCLE_MS = 5 * 60 * 1000;

function usTradingDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

const nameById = new Map(ARMS.map((a) => [a.id, armLabel(a)]));

// Once-a-day market-close check-in: the current standings, top and bottom few,
// and where the field sits vs SCHD. Guarded to fire exactly once per trading day.
async function sendExperimentSummary(now: Date): Promise<void> {
  const day = usTradingDay(now);
  if (getMeta("exp_summary_day") === day) return;

  const board = loadArmLeaderboard();
  if (board.length === 0 || board.every((r) => r.trades === 0 && r.returnPct === 0)) return;

  // SCHD return since the experiment's inception, for the field-vs-benchmark line.
  let schdLine = "";
  const inceptionStr = getMeta("exp_bench_inception_price");
  if (inceptionStr) {
    try {
      const now2 = await getLatestPrice(config.benchmark);
      const inception = Number(inceptionStr);
      if (now2 && inception > 0) {
        const schdRet = ((now2 - inception) / inception) * 100;
        const beating = board.filter((r) => r.returnPct > schdRet).length;
        const s = (n: number) => (n >= 0 ? "+" : "");
        schdLine = `SCHD ${s(schdRet)}${schdRet.toFixed(2)}% · ${beating}/${board.length} arms beating it`;
      }
    } catch { /* benchmark line is best-effort */ }
  }

  const fmt = (r: (typeof board)[number]) => {
    const s = r.returnPct >= 0 ? "+" : "";
    return `${nameById.get(r.armId) ?? `Arm ${r.armId}`} ${s}${r.returnPct.toFixed(2)}% (${r.trades}t)`;
  };
  const top = board.slice(0, 3).map((r, i) => `${i + 1}. ${fmt(r)}`);
  const worst = board[board.length - 1];

  const lines = [
    `Leader: ${fmt(board[0]!)}`,
    ...top.slice(1),
    worst ? `Last: ${fmt(worst)}` : "",
    schdLine,
  ].filter(Boolean);

  await notify(`Experiment · ${day}`, lines.join("\n"), { tags: ["chart_with_upwards_trend"], priority: 3 });
  setMeta("exp_summary_day", day);
  console.log(`[exp] daily check-in sent for ${day}`);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  console.log(`stonkbot-experiment starting: ${ARMS.length} arms once=${once}`);

  if (!config.alpaca.keyId || !config.alpaca.secretKey) {
    console.error("No Alpaca keys set. The experiment needs data-feed access.");
    process.exit(1);
  }

  registerArms(new Date());

  // --once forces exactly one cycle regardless of market state, for testing /
  // verification (bars are available even when the market is closed).
  if (once) {
    const r = await runExperimentCycle(new Date());
    console.log(`[exp] --once cycle: ${r.arms} arms, ${r.buys} buys, ${r.sells} sells`);
    return;
  }

  for (;;) {
    try {
      const clock = await getClock();
      if (clock.is_open) {
        const r = await runExperimentCycle(new Date());
        console.log(`[exp] cycle: ${r.arms} arms, ${r.buys} buys, ${r.sells} sells`);
      } else {
        console.log(`[exp] market closed. Next open ${clock.next_open}.`);
        await sendExperimentSummary(new Date());
      }
    } catch (err) {
      console.error("[exp] cycle error:", err);
      await notify("Experiment error", String(err instanceof Error ? err.message : err));
    }
    await Bun.sleep(CYCLE_MS);
  }
}

main();
// #endregion
