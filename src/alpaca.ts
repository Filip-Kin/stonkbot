// #region alpaca client
// Minimal typed Alpaca REST client covering what the bot needs:
// account, positions, orders, clock, and historical bars.
import { config } from "./config";

export interface Account {
  equity: number;
  cash: number;
  buying_power: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_plpc: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filled_avg_price: number | null;
  status: string;
}

export interface Bar {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

function tradingHeaders(): HeadersInit {
  return {
    "APCA-API-KEY-ID": config.alpaca.keyId,
    "APCA-API-SECRET-KEY": config.alpaca.secretKey,
    "Content-Type": "application/json",
  };
}

// Bun's fetch has NO default timeout, so a slow/hung Alpaca connection would
// block a caller forever. That's fatal for the dashboard (its render's
// Promise.allSettled can't degrade if the fetches never settle → Bun.serve
// kills the request at idleTimeout → blank page) and can stall the bot cycle.
// Cap every Alpaca call so a slow upstream fails fast and degrades gracefully.
const ALPACA_TIMEOUT_MS = 8000;
const BATCH_RETRIES = 2;

async function trading<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.alpaca.tradingUrl}${path}`, {
    ...init,
    headers: { ...tradingHeaders(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(ALPACA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca trading ${path} ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

async function data<T>(path: string, timeoutMs: number = ALPACA_TIMEOUT_MS): Promise<T> {
  const res = await fetch(`${config.alpaca.dataUrl}${path}`, {
    headers: tradingHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca data ${path} ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

// #region raw response coercion
interface RawAccount {
  equity: string; cash: string; buying_power: string;
}
interface RawPosition {
  symbol: string; qty: string; avg_entry_price: string; current_price: string;
  market_value: string; unrealized_pl: string; unrealized_plpc: string;
}
interface RawOrder {
  id: string; symbol: string; side: "buy" | "sell"; qty: string;
  filled_avg_price: string | null; status: string;
}
// #endregion

export async function getAccount(): Promise<Account> {
  const a = await trading<RawAccount>("/v2/account");
  return {
    equity: Number(a.equity),
    cash: Number(a.cash),
    buying_power: Number(a.buying_power),
  };
}

export async function getPositions(): Promise<Position[]> {
  const rows = await trading<RawPosition[]>("/v2/positions");
  return rows.map((p) => ({
    symbol: p.symbol,
    qty: Number(p.qty),
    avg_entry_price: Number(p.avg_entry_price),
    current_price: Number(p.current_price),
    market_value: Number(p.market_value),
    unrealized_pl: Number(p.unrealized_pl),
    unrealized_plpc: Number(p.unrealized_plpc),
  }));
}

export async function getClock(): Promise<Clock> {
  return trading<Clock>("/v2/clock");
}

// Buy-only by design. Opening or increasing a SHORT is the only way to lose
// more than you invested, so this path physically cannot place a sell.
// Every exit goes through closePosition(), which can only sell shares you
// already hold and therefore can never go short.
export async function submitBuy(params: {
  symbol: string;
  notional?: number; // dollar amount (fractional)
  qty?: number;
  type?: "market" | "limit";
  limit_price?: number;
  time_in_force?: "day" | "gtc";
}): Promise<Order> {
  if ((params.notional ?? 0) <= 0 && (params.qty ?? 0) <= 0) {
    throw new Error("submitBuy: must specify a positive notional or qty");
  }
  const body = {
    symbol: params.symbol,
    side: "buy" as const,
    type: params.type ?? "market",
    time_in_force: params.time_in_force ?? "day",
    ...(params.notional !== undefined ? { notional: params.notional } : {}),
    ...(params.qty !== undefined ? { qty: params.qty } : {}),
    ...(params.limit_price !== undefined ? { limit_price: params.limit_price } : {}),
  };
  const o = await trading<RawOrder>("/v2/orders", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    qty: Number(o.qty),
    filled_avg_price: o.filled_avg_price === null ? null : Number(o.filled_avg_price),
    status: o.status,
  };
}

export async function closePosition(symbol: string): Promise<void> {
  await trading(`/v2/positions/${symbol}`, { method: "DELETE" });
}

export async function getBars(
  symbol: string,
  timeframe: string,
  limit: number,
  start?: string, // ISO time; REQUIRED to get history back — without it the
  // bars endpoint returns only the current session (1 daily bar), which starves
  // any multi-day indicator (e.g. the 50-day trend SMA).
): Promise<Bar[]> {
  const params = new URLSearchParams({
    timeframe,
    limit: String(limit),
    adjustment: "raw",
    feed: "iex", // free data feed; upgrade to "sip" if you have the subscription
  });
  if (start) params.set("start", start);
  const resp = await data<{ bars: Bar[] | null }>(
    `/v2/stocks/${symbol}/bars?${params.toString()}`,
  );
  return resp.bars ?? [];
}

// Latest trade price for a symbol (IEX feed). Used for benchmark scoring.
export async function getLatestPrice(symbol: string): Promise<number | null> {
  const resp = await data<{ trade?: { p: number } }>(
    `/v2/stocks/${symbol}/trades/latest?feed=iex`,
  );
  return resp.trade?.p ?? null;
}

// #endregion
