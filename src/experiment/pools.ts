// #region pools
// Universe pools for the multi-arm experiment. Each arm trades ONE pool; the
// pool is itself an experimental factor (Filip's idea): a mean-reversion dip
// buyer has more uncorrelated setups in a bigger or more volatile universe.
//
//   P0  current 34 large-caps (the live bot's watchlist)  — the control pool
//   P1  ~100 liquid S&P-100 names                          — broader, same quality
//   P2  high-beta / high-volatility (semis + growth)       — bigger, more frequent dips
//   P3  low-vol / dividend blue-chips                       — closer to SCHD's world
//   P4  tech-only                                           — isolate one sector
//   P5  sector-SPDR ETFs                                    — no single-stock catalyst risk
//
// Sector tags drive the per-sector position cap. ETFs are each their own sector
// (they are already diversified, so the sector cap should never bind on them).
import { config } from "../config";

export type PoolId = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

// Master sector map for every symbol used across all pools. The 34 baseline
// names inherit their tags from config.sectors; the rest are added here.
const EXTRA_SECTORS: Record<string, string> = {
  // Tech
  ORCL: "Tech", CSCO: "Tech", ACN: "Tech", IBM: "Tech", INTC: "Tech",
  TXN: "Tech", NOW: "Tech", INTU: "Tech", AMAT: "Tech", MU: "Tech",
  MRVL: "Tech", LRCX: "Tech", KLAC: "Tech", ON: "Tech", ANET: "Tech",
  PLTR: "Tech", SNOW: "Tech", CRWD: "Tech", NET: "Tech", DDOG: "Tech",
  PANW: "Tech", SMCI: "Tech",
  // Communications
  NFLX: "Communications", CMCSA: "Communications", DIS: "Communications",
  T: "Communications", VZ: "Communications", TMUS: "Communications",
  CHTR: "Communications",
  // Healthcare
  ABT: "Healthcare", DHR: "Healthcare", BMY: "Healthcare", GILD: "Healthcare",
  CVS: "Healthcare", CI: "Healthcare", ELV: "Healthcare", MRNA: "Healthcare",
  // Financials
  WFC: "Financials", GS: "Financials", MS: "Financials", AXP: "Financials",
  C: "Financials", BLK: "Financials", SCHW: "Financials", SPGI: "Financials",
  BX: "Financials", COIN: "Financials",
  // Consumer (discretionary + staples share the "Consumer" tag, as in config)
  MCD: "Consumer", NKE: "Consumer", SBUX: "Consumer", LOW: "Consumer",
  TGT: "Consumer", BKNG: "Consumer", TSLA: "Consumer", PEP: "Consumer",
  MDLZ: "Consumer", CL: "Consumer", MO: "Consumer", PM: "Consumer",
  KMB: "Consumer", GIS: "Consumer", ABNB: "Consumer", UBER: "Consumer",
  SHOP: "Consumer",
  // Industrials
  GE: "Industrials", BA: "Industrials", UPS: "Industrials", RTX: "Industrials",
  DE: "Industrials", LMT: "Industrials", MMM: "Industrials", UNP: "Industrials",
  // Energy
  COP: "Energy", SLB: "Energy", EOG: "Energy",
  // Materials
  LIN: "Materials", SHW: "Materials", FCX: "Materials",
  // Utilities
  NEE: "Utilities", DUK: "Utilities", SO: "Utilities", D: "Utilities",
  // Real estate
  AMT: "RealEstate", PLD: "RealEstate",
  // Sector ETFs — each its own sector so the per-sector cap never binds.
  XLK: "ETF-XLK", XLF: "ETF-XLF", XLE: "ETF-XLE", XLV: "ETF-XLV",
  XLI: "ETF-XLI", XLP: "ETF-XLP", XLY: "ETF-XLY", XLU: "ETF-XLU",
  XLB: "ETF-XLB", XLRE: "ETF-XLRE", XLC: "ETF-XLC",
};

// Sector for a symbol: config's 34 first, then the extended map, else "Other".
export function sectorOf(symbol: string): string {
  return config.sectors[symbol] ?? EXTRA_SECTORS[symbol] ?? "Other";
}

const P0 = [...config.watchlist];

const P1 = [
  ...P0,
  "GOOG", "ORCL", "CSCO", "ACN", "IBM", "INTC", "TXN", "NOW", "INTU", "AMAT",
  "NFLX", "CMCSA", "DIS", "T", "VZ", "TMUS", "CHTR",
  "ABT", "DHR", "BMY", "GILD", "CVS", "CI", "ELV",
  "WFC", "GS", "MS", "AXP", "C", "BLK", "SCHW", "SPGI", "BX",
  "MCD", "NKE", "SBUX", "LOW", "TGT", "BKNG", "TSLA",
  "PEP", "MDLZ", "CL", "MO", "PM", "KMB", "GIS",
  "GE", "BA", "UPS", "RTX", "DE", "LMT", "MMM", "UNP",
  "COP", "SLB", "EOG",
  "LIN", "SHW", "FCX",
  "NEE", "DUK", "SO",
  "AMT", "PLD",
];

const P2 = [
  "NVDA", "AMD", "AVGO", "MU", "MRVL", "SMCI", "QCOM", "INTC", "LRCX", "KLAC",
  "ON", "ANET", "TSLA", "META", "NFLX", "PLTR", "COIN", "SHOP", "SNOW", "CRWD",
  "NET", "DDOG", "PANW", "ABNB", "UBER", "MRNA",
];

const P3 = [
  "KO", "PG", "JNJ", "PEP", "WMT", "MRK", "ABBV", "VZ", "T", "KMB",
  "CL", "MO", "PM", "MCD", "MDLZ", "GIS", "DUK", "SO", "NEE", "D",
];

const P4 = [
  "AAPL", "MSFT", "NVDA", "AMD", "GOOGL", "META", "AVGO", "CRM", "ADBE",
  "QCOM", "ORCL", "CSCO", "INTC", "TXN", "NOW", "INTU", "AMAT", "MU",
];

const P5 = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLP", "XLY", "XLU", "XLB", "XLRE", "XLC"];

// De-duped pool membership (P1 concatenates P0, which can repeat names).
export const POOLS: Record<PoolId, string[]> = {
  P0: [...new Set(P0)],
  P1: [...new Set(P1)],
  P2: [...new Set(P2)],
  P3: [...new Set(P3)],
  P4: [...new Set(P4)],
  P5: [...new Set(P5)],
};

// Every distinct symbol across all pools, so the engine can fetch bars/news
// once for the union and fan the shared data out to whichever arms use it.
export const ALL_SYMBOLS: string[] = [
  ...new Set(Object.values(POOLS).flat()),
];
// #endregion
