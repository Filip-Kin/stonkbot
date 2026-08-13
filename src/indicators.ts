// #region indicators
// Small, dependency-free technical indicators. All pure functions.

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder's RSI.
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Distance of last price below its SMA as a positive fraction (0 if above).
export function dipFraction(closes: number[], period: number): number | null {
  const avg = sma(closes, period);
  if (avg === null) return null;
  const last = closes[closes.length - 1]!;
  return last < avg ? (avg - last) / avg : 0;
}

// Average True Range: the mean of the true range over `period` bars, expressed
// in price units. True range = max(high-low, |high-prevClose|, |low-prevClose|),
// which captures gaps the plain high-low range misses. Used by the volatility-
// aware arms to scale stops/targets to each name's own noise (a 2% stop is
// noise for a semiconductor but a real move for a utility). Needs period+1 bars.
export function atr(
  bars: { h: number; l: number; c: number }[],
  period: number,
): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}
// #endregion
