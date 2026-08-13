// #region news
// Defensive news layer via Alpaca's free news API (Benzinga-powered).
// We do NOT try to predict earnings or trade on sentiment direction; the
// evidence says that's a coin flip for retail. We use news only to AVOID
// catching a falling knife: a dip that's really a repricing on genuinely bad
// news.
//
// The judgement is made by Claude, reached through a host-side shim
// (stonkbot-classifier.service) that runs `claude --print` under Filip's
// subscription — so no API key lives in this container. Given the recent
// headlines for a name that just dipped, Claude decides whether there's a real
// adverse catalyst (guidance cut, failed trial, fraud, regulatory action, big
// downgrade, ...) or just routine coverage. This replaces the old "3+ headlines
// in 24h = skip" count, which permanently vetoed always-in-the-news mega-caps
// (AAPL, GOOGL, NVDA) regardless of what the headlines said. With no classifier
// configured, or on any error reaching it, we fall back to that count heuristic.
import { config } from "./config";

interface RawNews {
  headline: string;
  created_at: string;
  symbols: string[];
}

export interface NewsSummary {
  symbol: string;
  recentCount: number; // headlines in the lookback window
  headlines: string[]; // the headline texts considered
  blockBuy: boolean; // true => a real adverse catalyst, skip the dip buy
  reason: string; // short human-readable verdict, for logs/alerts
}

// How many headlines within this window we consider.
const WINDOW_HOURS = 24;

// `now` is passed in so this stays free of wall-clock reads at call sites that
// want determinism; the scheduler supplies real time.
export async function getRecentNews(symbol: string, now: Date): Promise<NewsSummary> {
  const headlines = await getHeadlines(symbol, now);

  // No news at all => nothing to avoid, let the buy proceed.
  if (headlines.length === 0) {
    return { symbol, recentCount: 0, headlines, blockBuy: false, reason: "no recent news" };
  }

  // Classifier not configured => degrade to the old count heuristic.
  if (!config.classifier.url || !config.classifier.token) {
    return countFallback(symbol, headlines, "no classifier configured");
  }

  // Ask Claude (via the host shim) whether the headlines are a real catalyst.
  try {
    const verdict = await classify(symbol, headlines);
    return {
      symbol,
      recentCount: headlines.length,
      headlines,
      blockBuy: verdict.materialNegative,
      reason: verdict.reason,
    };
  } catch (err) {
    // Classifier unreachable/failed: fall back to the count heuristic rather
    // than trading blind. Surface the error so it isn't swallowed.
    console.error(`[news] classifier failed for ${symbol}:`, err instanceof Error ? err.message : err);
    return countFallback(symbol, headlines, "AI error");
  }
}

function countFallback(symbol: string, headlines: string[], why: string): NewsSummary {
  const block = headlines.length >= config.strategy.newsCatalystThreshold;
  return {
    symbol,
    recentCount: headlines.length,
    headlines,
    blockBuy: block,
    reason: `${headlines.length} headlines/24h (count fallback: ${why})`,
  };
}

// Five-level tone scale. The middle three match the original vocabulary (so old
// cached values still validate); "great" and "terrible" are the new extremes for
// standout bullish / genuinely alarming coverage.
export type Sentiment = "great" | "positive" | "neutral" | "negative" | "terrible";
const SENTIMENTS: readonly Sentiment[] = ["great", "positive", "neutral", "negative", "terrible"];

// Batch news sentiment for the dashboard watchlist. One shim call tags every
// symbol's recent headlines good/neutral/bad, so we don't run the classifier
// per symbol. Returns a symbol -> sentiment map; empty on any failure (the
// watchlist just omits the tag). Reaches the shim's /sentiment endpoint,
// derived from the /classify URL.
export async function getNewsSentiments(
  items: { symbol: string; headlines: string[] }[],
): Promise<Map<string, Sentiment>> {
  const out = new Map<string, Sentiment>();
  if (!config.classifier.url || !config.classifier.token || items.length === 0) return out;
  const url = config.classifier.url.replace(/\/classify$/, "/sentiment");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.classifier.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ items }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sentiment ${res.status}`);
    const body = (await res.json()) as { results?: { symbol: string; sentiment: Sentiment }[] };
    for (const r of body.results ?? []) {
      if (r && SENTIMENTS.includes(r.sentiment)) {
        out.set(r.symbol, r.sentiment);
      }
    }
  } catch (err) {
    console.error("[news] sentiment batch failed:", err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

export async function getHeadlines(symbol: string, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    symbols: symbol,
    start: since,
    limit: "10",
    sort: "desc",
  });
  try {
    const res = await fetch(`${config.alpaca.dataUrl}/v1beta1/news?${params.toString()}`, {
      headers: {
        "APCA-API-KEY-ID": config.alpaca.keyId,
        "APCA-API-SECRET-KEY": config.alpaca.secretKey,
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { news?: RawNews[] };
    return (body.news ?? []).map((n) => n.headline).filter(Boolean);
  } catch {
    return [];
  }
}

interface Verdict {
  materialNegative: boolean;
  reason: string;
}

async function classify(symbol: string, headlines: string[]): Promise<Verdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100_000);
  try {
    const res = await fetch(config.classifier.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.classifier.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbol, headlines }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`classifier ${res.status}: ${detail.slice(0, 200)}`);
    }
    const v = (await res.json()) as Verdict;
    if (typeof v.materialNegative !== "boolean") throw new Error("verdict missing materialNegative");
    return { materialNegative: v.materialNegative, reason: String(v.reason ?? "") };
  } finally {
    clearTimeout(timer);
  }
}
// #endregion
