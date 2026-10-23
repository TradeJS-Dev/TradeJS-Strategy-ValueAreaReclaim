import type { Direction } from "@tradejs/types";
import {
  configKey,
  parseConfig,
  type ValueAreaReclaimConfig,
} from "./config.js";
import {
  buildValueAreaProfile,
  UTC_DAY_MS,
  utcDayStart,
  validateCandle,
  type ProfileCandle,
  type ValueAreaProfile,
} from "./profile.js";

export const executionIntervalMs = (config: ValueAreaReclaimConfig) =>
  Number(config.INTERVAL) * 60_000;

export interface ReclaimCandidate {
  direction: Direction;
  timestamp: number;
  excursionStart: number;
  extreme: number;
  atr: number;
  profile: ValueAreaProfile;
}
export interface EngineResult {
  code: string;
  candidate: ReclaimCandidate | null;
}
export interface EngineState {
  schema: "value-area-reclaim/v1";
  configKey: string;
  candles: ProfileCandle[];
  trueRanges: number[];
  lastTimestamp: number | null;
  previousClose: number | null;
  profileDay: number | null;
  profile: ValueAreaProfile | null;
  rebuilds: number;
  pending: { direction: Direction; started: number; extreme: number } | null;
  lastResult: EngineResult;
}

export const createEngineState = (
  config: ValueAreaReclaimConfig,
): EngineState => ({
  schema: "value-area-reclaim/v1",
  configKey: configKey(config),
  candles: [],
  trueRanges: [],
  lastTimestamp: null,
  previousClose: null,
  profileDay: null,
  profile: null,
  rebuilds: 0,
  pending: null,
  lastResult: { code: "VAR_WARMUP", candidate: null },
});

/** Deterministic in-place transition over closed source candles, with no IO. */
export function advanceEngine(
  state: EngineState,
  config: ValueAreaReclaimConfig,
  input: ProfileCandle,
  sourceProfile?: ValueAreaProfile | null,
): EngineResult {
  validateCandle(input);
  const step = executionIntervalMs(config);
  if (input.timestamp % step !== 0)
    throw new Error("Misaligned execution candle");
  if (state.lastTimestamp === input.timestamp) return state.lastResult;
  if (state.lastTimestamp != null && input.timestamp < state.lastTimestamp)
    throw new Error("Non-monotonic execution history");
  const day = utcDayStart(input.timestamp);
  if (config.INTERVAL === "60" && day !== state.profileDay) {
    if (sourceProfile === undefined)
      throw new Error("1h execution requires an explicit closed 15m profile");
    if (
      sourceProfile &&
      (sourceProfile.end !== day ||
        sourceProfile.start !== day - config.VAR_PROFILE_DAYS * UTC_DAY_MS)
    ) {
      throw new Error("15m profile does not match the execution UTC day");
    }
  }
  const candle: ProfileCandle = {
    timestamp: input.timestamp,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume,
  };
  const gap =
    state.lastTimestamp != null &&
    input.timestamp !== state.lastTimestamp + step;
  if (gap) {
    state.pending = null;
    state.trueRanges = [];
    state.previousClose = null;
  }
  const previousClose = state.previousClose;
  const tr =
    previousClose == null
      ? candle.high - candle.low
      : Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previousClose),
          Math.abs(candle.low - previousClose),
        );
  state.trueRanges.push(tr);
  if (state.trueRanges.length > config.VAR_ATR_PERIOD) state.trueRanges.shift();
  const atr =
    state.trueRanges.length === config.VAR_ATR_PERIOD
      ? state.trueRanges.reduce((a, b) => a + b, 0) / config.VAR_ATR_PERIOD
      : null;
  if (day !== state.profileDay) {
    state.profileDay = day;
    state.pending = null;
    if (config.INTERVAL === "60") {
      state.profile = sourceProfile ? structuredClone(sourceProfile) : null;
    } else {
      state.profile = buildValueAreaProfile(
        state.candles,
        day,
        config.VAR_PROFILE_DAYS,
        config.VAR_VALUE_FRACTION,
      );
    }
    state.rebuilds++;
  }
  // Hourly execution candles must never enter the source profile history.
  if (config.INTERVAL === "15") state.candles.push(candle);
  const maxCandles = (config.VAR_PROFILE_DAYS + 1) * 96;
  if (state.candles.length > maxCandles)
    state.candles.splice(0, state.candles.length - maxCandles);
  state.previousClose = candle.close;
  state.lastTimestamp = candle.timestamp;
  const done = (code: string, candidate: ReclaimCandidate | null = null) =>
    (state.lastResult = { code, candidate });
  const profile = state.profile;
  if (!profile || profile.vah <= profile.val)
    return done("VAR_WAIT_COMPLETE_UTC_PROFILE");
  const inside = (price: number) => price > profile.val && price < profile.vah;
  // An OHLC candle crossing both boundaries has no observable excursion order.
  if (candle.low < profile.val && candle.high > profile.vah) {
    state.pending = null;
    return done("VAR_AMBIGUOUS_BOTH_BOUNDARIES");
  }
  if (
    state.pending &&
    candle.timestamp - state.pending.started > config.VAR_RECLAIM_BARS * step
  ) {
    state.pending = null;
    return done("VAR_RECLAIM_EXPIRED");
  }
  if (!state.pending && previousClose != null && inside(previousClose)) {
    if (candle.low < profile.val)
      state.pending = {
        direction: "LONG",
        started: candle.timestamp,
        extreme: candle.low,
      };
    else if (candle.high > profile.vah)
      state.pending = {
        direction: "SHORT",
        started: candle.timestamp,
        extreme: candle.high,
      };
  }
  const pending = state.pending;
  if (!pending) return done("VAR_WAIT_EXCURSION");
  pending.extreme =
    pending.direction === "LONG"
      ? Math.min(pending.extreme, candle.low)
      : Math.max(pending.extreme, candle.high);
  const oppositeExit =
    pending.direction === "LONG"
      ? candle.close >= profile.vah
      : candle.close <= profile.val;
  if (oppositeExit) {
    state.pending = null;
    return done("VAR_CROSSED_OPPOSITE_BOUNDARY");
  }
  if (!inside(candle.close)) return done("VAR_WAIT_RECLAIM");
  state.pending = null;
  if (atr == null || !Number.isFinite(atr) || atr <= 0)
    return done("VAR_WAIT_ATR");
  return done("VAR_RECLAIM", {
    direction: pending.direction,
    timestamp: candle.timestamp,
    excursionStart: pending.started,
    extreme: pending.extreme,
    atr,
    profile,
  });
}

export function createValueAreaReclaimEngine(
  options: {
    config?: Partial<ValueAreaReclaimConfig>;
    initialCandles?: readonly ProfileCandle[];
    checkpoint?: EngineState;
    /** Required on 1h day transitions, including historical preload. Pure, no IO. */
    profileForDay?: (day: number) => ValueAreaProfile | null;
  } = {},
) {
  const config = parseConfig(options.config ?? {});
  if (options.checkpoint && options.initialCandles?.length)
    throw new Error("Use checkpoint or initialCandles");
  const state = options.checkpoint
    ? structuredClone(options.checkpoint)
    : createEngineState(config);
  if (
    state.schema !== "value-area-reclaim/v1" ||
    state.configKey !== configKey(config) ||
    state.candles.length > (config.VAR_PROFILE_DAYS + 1) * 96 ||
    state.trueRanges.length > config.VAR_ATR_PERIOD
  ) {
    throw new Error("Incompatible ValueAreaReclaim checkpoint");
  }
  for (const candle of options.initialCandles ?? [])
    advanceEngine(
      state,
      config,
      candle,
      state.profileDay !== utcDayStart(candle.timestamp)
        ? options.profileForDay?.(utcDayStart(candle.timestamp))
        : undefined,
    );
  return {
    next: (candle: ProfileCandle) =>
      structuredClone(
        advanceEngine(
          state,
          config,
          candle,
          state.profileDay !== utcDayStart(candle.timestamp)
            ? options.profileForDay?.(utcDayStart(candle.timestamp))
            : undefined,
        ),
      ),
    getState: () => structuredClone(state),
  };
}
