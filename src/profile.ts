export const SOURCE_INTERVAL_MS = 15 * 60_000;
export const UTC_DAY_MS = 24 * 60 * 60_000;
export const PROFILE_BINS = 48;
export const utcDayStart = (timestamp: number) =>
  Math.floor(timestamp / UTC_DAY_MS) * UTC_DAY_MS;

export interface ProfileCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ValueAreaProfile {
  start: number;
  end: number;
  low: number;
  high: number;
  bins: number[];
  totalVolume: number;
  valueVolume: number;
  pocIndex: number;
  valIndex: number;
  vahIndex: number;
  poc: number;
  val: number;
  vah: number;
}

export function validateCandle(candle: ProfileCandle) {
  if (
    ![
      candle.timestamp,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ].every(Number.isFinite) ||
    !Number.isSafeInteger(candle.timestamp) ||
    candle.timestamp < 0 ||
    candle.timestamp % SOURCE_INTERVAL_MS !== 0 ||
    candle.low <= 0 ||
    candle.high < candle.low ||
    candle.volume < 0 ||
    candle.open < candle.low ||
    candle.open > candle.high ||
    candle.close < candle.low ||
    candle.close > candle.high
  ) {
    throw new Error("Invalid closed 15m OHLCV candle");
  }
}

/** Requires every 15m opening timestamp in the completed half-open UTC window. */
export function buildValueAreaProfile(
  candles: readonly ProfileCandle[],
  end: number,
  days: number,
  fraction: number,
): ValueAreaProfile | null {
  if (
    !Number.isSafeInteger(end) ||
    end % UTC_DAY_MS !== 0 ||
    !Number.isInteger(days) ||
    days < 2 ||
    days > 14 ||
    !(fraction > 0 && fraction <= 1)
  ) {
    throw new Error("Invalid profile window or value fraction");
  }
  const start = end - days * UTC_DAY_MS;
  const rows = candles.filter((c) => c.timestamp >= start && c.timestamp < end);
  if (rows.length !== days * 96) return null;
  let low = Infinity;
  let high = -Infinity;
  let totalVolume = 0;
  for (let i = 0; i < rows.length; i++) {
    const candle = rows[i];
    validateCandle(candle);
    if (candle.timestamp !== start + i * SOURCE_INTERVAL_MS) return null;
    low = Math.min(low, candle.low);
    high = Math.max(high, candle.high);
    totalVolume += candle.volume;
  }
  if (!(totalVolume > 0) || !Number.isFinite(totalVolume)) return null;
  const width = (high - low) / PROFILE_BINS;
  const bins = Array<number>(PROFILE_BINS).fill(0);
  const bucket = (price: number) =>
    Math.min(PROFILE_BINS - 1, Math.max(0, Math.floor((price - low) / width)));
  for (const candle of rows) {
    if (width === 0 || candle.high === candle.low) {
      bins[width === 0 ? 0 : bucket(candle.low)] += candle.volume;
      continue;
    }
    const first = bucket(candle.low);
    const last = Math.min(
      PROFILE_BINS - 1,
      Math.max(first, Math.ceil((candle.high - low) / width) - 1),
    );
    let allocated = 0;
    for (let i = first; i <= last; i++) {
      const overlap = Math.max(
        0,
        Math.min(candle.high, low + (i + 1) * width) -
          Math.max(candle.low, low + i * width),
      );
      // The final intersecting bin absorbs floating point allocation residue.
      const volume =
        i === last
          ? candle.volume - allocated
          : Math.min(
              candle.volume - allocated,
              (candle.volume * overlap) / (candle.high - candle.low),
            );
      bins[i] += volume;
      allocated += volume;
    }
  }
  let pocIndex = 0;
  for (let i = 1; i < bins.length; i++)
    if (bins[i] > bins[pocIndex]) pocIndex = i;
  let valIndex = pocIndex;
  let vahIndex = pocIndex;
  let valueVolume = bins[pocIndex];
  while (
    valueVolume < totalVolume * fraction &&
    (valIndex > 0 || vahIndex < PROFILE_BINS - 1)
  ) {
    const lower = valIndex > 0 ? bins[valIndex - 1] : -Infinity;
    const upper = vahIndex < PROFILE_BINS - 1 ? bins[vahIndex + 1] : -Infinity;
    if (lower >= upper) valueVolume += bins[--valIndex];
    else valueVolume += bins[++vahIndex];
  }
  return {
    start,
    end,
    low,
    high,
    bins,
    totalVolume,
    valueVolume,
    pocIndex,
    valIndex,
    vahIndex,
    poc: width === 0 ? low : low + (pocIndex + 0.5) * width,
    val: low + valIndex * width,
    vah: width === 0 ? high : low + (vahIndex + 1) * width,
  };
}
