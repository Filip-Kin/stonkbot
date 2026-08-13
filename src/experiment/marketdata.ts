// #region marketdata
// Fetch every shared input ONCE per cycle and fan it out to all 40 arms. This
// is the whole trick that keeps the data + Claude budget flat no matter how many
// arms run: batched multi-symbol bars (a few calls for the entire union instead
// of two per symbol per arm), and one adverse-catalyst news verdict per dip
// candidate, reused by every arm that looks at that name.
import { getBarsBatch, type Bar } from "../alpaca";
import { getRecentNews } from "../news";
import { rsi, sma, dipFraction, atr } from "../indicators";
import { ALL_SYMBOLS, sectorOf } from "./pools";
import type { MarketData, NewsVerdict, SymbolData } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

// Loose gates used ONLY to decide which symbols are worth a news-classifier call
// this cycle. Deliberately looser than any arm's entry (RSI<=40, dip<=8%), so a
// name that could trigger a dip-buy for ANY arm gets its verdict; everything
// else skips the classifier (keeps Claude usage the same as the live bot).
const CANDIDATE_RSI = 40;
const CANDIDATE_MAX_DIP = 0.08;
const TREND_DAYS = 50; // default uptrend gate for candidate detection
const NO_NEWS: NewsVerdict = { blockBuy: false, reason: "not evaluated", count: 0 };

function isDipCandidate(intradayCloses: number[], dailyCloses: number[], price: number): boolean {
  if (intradayCloses.length < 21 || dailyCloses.length < TREND_DAYS) return false;
  const trendSma = sma(dailyCloses, TREND_DAYS);
  const r = rsi(intradayCloses, 14);
  const dip = dipFraction(intradayCloses, 20);
  if (trendSma === null || r === null || dip === null) return false;
  return price > trendSma && r <= CANDIDATE_RSI && dip > 0 && dip <= CANDIDATE_MAX_DIP;
}

export async function fetchMarketData(now: Date): Promise<MarketData> {
  // Windows: daily must cover the deepest trend lookback (100d) with slack;
  // intraday a few calendar days comfortably covers the ~60-bar lookback while
  // spanning a weekend.
  const dailyStart = new Date(now.getTime() - (100 * 2 + 20) * DAY_MS).toISOString();
  const intradayStart = new Date(now.getTime() - 4 * DAY_MS).toISOString();

  const [intraday, daily] = await Promise.all([
    getBarsBatch(ALL_SYMBOLS, "5Min", 10000, intradayStart),
    getBarsBatch(ALL_SYMBOLS, "1Day", 10000, dailyStart),
  ]);

  // First pass: assemble bars + indicators, and flag dip candidates.
  const md: MarketData = new Map();
  const candidates: string[] = [];
  for (const symbol of ALL_SYMBOLS) {
    const intradayBars = intraday[symbol] ?? [];
    const dailyBars = daily[symbol] ?? [];
    if (intradayBars.length === 0 || dailyBars.length === 0) continue;
    const intradayCloses = intradayBars.map((b) => b.c);
    const dailyCloses = dailyBars.map((b) => b.c);
    const price = intradayCloses[intradayCloses.length - 1]!;
    const data: SymbolData = {
      symbol,
      sector: sectorOf(symbol),
      price,
      intradayCloses,
      dailyCloses,
      atr: atr(dailyBars, 14),
      news: NO_NEWS,
    };
    md.set(symbol, data);
    if (isDipCandidate(intradayCloses, dailyCloses, price)) candidates.push(symbol);
  }

  // Second pass: one news verdict per dip candidate, shared across all arms.
  await Promise.all(
    candidates.map(async (symbol) => {
      try {
        const n = await getRecentNews(symbol, now);
        const data = md.get(symbol);
        if (data) data.news = { blockBuy: n.blockBuy, reason: n.reason, count: n.recentCount };
      } catch {
        /* leave NO_NEWS; the news veto simply won't block this cycle */
      }
    }),
  );

  return md;
}

export type { Bar };
// #endregion
