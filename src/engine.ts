import type { Direction } from "@tradejs/types";
import {
  configKey,
  parseConfig,
  entryModeFor,
  needsPreviousDayRange,
  type EntryMode,
  type ValueAreaReclaimConfig,
} from "./config.js";
import {
  buildValueAreaProfile,
  buildPreviousDayRange,
  type PreviousDayRange,
  UTC_DAY_MS,
  utcDayStart,
  validateCandle,
  type ProfileCandle,
  type ValueAreaProfile,
} from "./profile.js";
import { cutlerRsi14 } from "./rsi.js";

export const executionIntervalMs = (config: ValueAreaReclaimConfig) =>
  Number(config.INTERVAL) * 60_000;
export interface AcceptedClose {
  timestamp: number;
  close: number;
}
export interface OutsideBar extends AcceptedClose {
  high: number;
  low: number;
}
export interface AcceptedReturn {
  profileEnd: number;
  priorCloses: AcceptedClose[];
  outsideBar: OutsideBar;
  returnTimestamp: number;
}
export interface CompletedExcursion {
  previousClose: AcceptedClose;
  returnClose: number;
  profileEnd: number;
  outsideBar: OutsideBar;
  returnTimestamp: number;
  extremeTimestamp: number;
  extremePrice: number;
  extremeRsi: number;
}
export interface PriorDayTrap {
  previousDayRange: PreviousDayRange;
  previousClose: AcceptedClose;
  outsideBar: OutsideBar;
  returnTimestamp: number;
}
export interface ReclaimCandidate {
  direction: Direction;
  timestamp: number;
  excursionStart: number;
  extreme: number;
  atr: number;
  profile: ValueAreaProfile;
  entryMode: EntryMode;
  acceptedReturn?: AcceptedReturn;
  rsiDoubleTrap?: { prior: CompletedExcursion; current: CompletedExcursion };
  priorDayTrap?: PriorDayTrap;
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
  rsiChanges: number[];
  lastTimestamp: number | null;
  previousClose: number | null;
  profileDay: number | null;
  profile: ValueAreaProfile | null;
  previousDayRange: PreviousDayRange | null;
  acceptedCloses: AcceptedClose[];
  completedExcursions: Record<Direction, CompletedExcursion | null>;
  rebuilds: number;
  pending: {
    direction: Direction;
    started: number;
    extreme: number;
    mode: EntryMode;
    firstOutside?: OutsideBar;
    acceptedCloses?: AcceptedClose[];
    extremeTimestamp?: number;
    extremeRsi?: number | null;
    previousClose?: AcceptedClose;
    previousDayRange?: PreviousDayRange;
  } | null;
  lastResult: EngineResult;
}
export const createEngineState = (
  config: ValueAreaReclaimConfig,
): EngineState => ({
  schema: "value-area-reclaim/v1",
  configKey: configKey(config),
  candles: [],
  trueRanges: [],
  rsiChanges: [],
  lastTimestamp: null,
  previousClose: null,
  profileDay: null,
  profile: null,
  previousDayRange: null,
  acceptedCloses: [],
  completedExcursions: { LONG: null, SHORT: null },
  rebuilds: 0,
  pending: null,
  lastResult: { code: "VAR_WARMUP", candidate: null },
});

/** One causal closed execution bar. Daily profiles and ranges always use15m source. */
export function advanceEngine(
  state: EngineState,
  config: ValueAreaReclaimConfig,
  input: ProfileCandle,
  sourceProfile?: ValueAreaProfile | null,
  sourceRange?: PreviousDayRange | null,
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
    )
      throw new Error("15m profile does not match the execution UTC day");
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
    candle.timestamp !== state.lastTimestamp + step;
  if (gap) {
    state.pending = null;
    state.trueRanges = [];
    state.previousClose = null;
    state.acceptedCloses = [];
    state.rsiChanges = [];
    state.completedExcursions = { LONG: null, SHORT: null };
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
  if (previousClose != null) {
    state.rsiChanges.push(candle.close - previousClose);
    if (state.rsiChanges.length > 14) state.rsiChanges.shift();
  }
  const rsi = cutlerRsi14(state.rsiChanges);
  if (day !== state.profileDay) {
    state.profileDay = day;
    state.pending = null;
    state.acceptedCloses = [];
    state.completedExcursions = { LONG: null, SHORT: null };
    state.profile =
      config.INTERVAL === "60"
        ? sourceProfile
          ? structuredClone(sourceProfile)
          : null
        : buildValueAreaProfile(
            state.candles,
            day,
            config.VAR_PROFILE_DAYS,
            config.VAR_VALUE_FRACTION,
          );
    state.previousDayRange = needsPreviousDayRange(config)
      ? config.INTERVAL === "60"
        ? sourceRange
          ? structuredClone(sourceRange)
          : null
        : buildPreviousDayRange(state.candles, day)
      : null;
    if (
      state.previousDayRange &&
      (state.previousDayRange.end !== day ||
        state.previousDayRange.start !== day - UTC_DAY_MS)
    )
      throw new Error("15m prior-day range does not match execution UTC day");
    state.rebuilds++;
  }
  if (config.INTERVAL === "15") state.candles.push(candle);
  const maxCandles = (config.VAR_PROFILE_DAYS + 1) * 96;
  if (state.candles.length > maxCandles)
    state.candles.splice(0, state.candles.length - maxCandles);
  state.previousClose = candle.close;
  state.lastTimestamp = candle.timestamp;
  const done = (code: string, candidate: ReclaimCandidate | null = null) =>
    (state.lastResult = { code, candidate });
  const profile = state.profile;
  if (!profile || profile.vah <= profile.val) {
    state.acceptedCloses = [];
    state.completedExcursions = { LONG: null, SHORT: null };
    return done("VAR_WAIT_COMPLETE_UTC_PROFILE");
  }
  const inside = (price: number) => price > profile.val && price < profile.vah;
  const range = state.previousDayRange;
  const inRange = (price: number) =>
    range != null && price > range.low && price < range.high;
  if (candle.low < profile.val && candle.high > profile.vah) {
    state.pending = null;
    state.acceptedCloses = [];
    return done("VAR_AMBIGUOUS_BOTH_BOUNDARIES");
  }
  if (
    needsPreviousDayRange(config) &&
    range &&
    candle.low < range.low &&
    candle.high > range.high
  ) {
    state.pending = null;
    state.acceptedCloses = [];
    return done("VAR_AMBIGUOUS_DAY_RANGE");
  }
  // Snapshot BEFORE this candle; this exact R3 acceptance branch stays unchanged.
  const acceptedBefore = state.acceptedCloses;
  state.acceptedCloses = inside(candle.close)
    ? [
        ...acceptedBefore,
        { timestamp: candle.timestamp, close: candle.close },
      ].slice(-4)
    : [];
  if (
    state.pending &&
    candle.timestamp - state.pending.started > config.VAR_RECLAIM_BARS * step
  ) {
    state.pending = null;
    return done("VAR_RECLAIM_EXPIRED");
  }
  if (!state.pending && previousClose != null && inside(previousClose)) {
    const longMode = entryModeFor(config, "LONG"),
      shortMode = entryModeFor(config, "SHORT");
    const direction = (
      longMode === "legacy"
        ? candle.low < profile.val
        : candle.close < profile.val
    )
      ? "LONG"
      : (
            shortMode === "legacy"
              ? candle.high > profile.vah
              : candle.close > profile.vah
          )
        ? "SHORT"
        : null;
    if (direction) {
      const mode = entryModeFor(config, direction);
      if (mode === "accepted-return" && acceptedBefore.length !== 4)
        return done("VAR_WAIT_VALUE_ACCEPTANCE");
      if (
        mode === "prior-day-trap" &&
        (!inRange(previousClose) ||
          !(direction === "LONG"
            ? candle.close < range!.low
            : candle.close > range!.high))
      )
        return done("VAR_WAIT_DUAL_OUTSIDE");
      state.pending = {
        direction,
        started: candle.timestamp,
        extreme: direction === "LONG" ? candle.low : candle.high,
        mode,
        ...(mode !== "legacy"
          ? {
              firstOutside: {
                timestamp: candle.timestamp,
                high: candle.high,
                low: candle.low,
                close: candle.close,
              },
            }
          : {}),
        ...(mode === "accepted-return"
          ? { acceptedCloses: structuredClone(acceptedBefore) }
          : {}),
        ...(mode === "rsi-double-trap"
          ? {
              extremeTimestamp: candle.timestamp,
              extremeRsi: rsi,
              previousClose: {
                timestamp: candle.timestamp - step,
                close: previousClose,
              },
            }
          : {}),
        ...(mode === "prior-day-trap"
          ? {
              previousClose: {
                timestamp: candle.timestamp - step,
                close: previousClose,
              },
              previousDayRange: structuredClone(range!),
            }
          : {}),
      };
    }
  }
  const pending = state.pending;
  if (!pending) return done("VAR_WAIT_EXCURSION");
  const newExtreme =
    pending.direction === "LONG"
      ? candle.low < pending.extreme
      : candle.high > pending.extreme;
  if (newExtreme) {
    pending.extreme = pending.direction === "LONG" ? candle.low : candle.high;
    if (pending.mode === "rsi-double-trap") {
      pending.extremeTimestamp = candle.timestamp;
      pending.extremeRsi = rsi;
    }
  }
  // Strict equal-price ties retain the first extreme candle and its closed RSI.
  const oppositeExit =
    (pending.mode !== "legacy" &&
      (pending.direction === "LONG"
        ? candle.high > profile.vah
        : candle.low < profile.val)) ||
    (pending.direction === "LONG"
      ? candle.close >= profile.vah
      : candle.close <= profile.val) ||
    (pending.mode === "prior-day-trap" &&
      (pending.direction === "LONG"
        ? candle.high > pending.previousDayRange!.high ||
          candle.close >= pending.previousDayRange!.high
        : candle.low < pending.previousDayRange!.low ||
          candle.close <= pending.previousDayRange!.low));
  if (oppositeExit) {
    state.pending = null;
    return done("VAR_CROSSED_OPPOSITE_BOUNDARY");
  }
  if (!inside(candle.close)) return done("VAR_WAIT_RECLAIM");
  state.pending = null;
  if (pending.mode === "prior-day-trap" && !inRange(candle.close))
    return done("VAR_DAY_RANGE_RETURN_REJECTED");
  let rsiDoubleTrap: ReclaimCandidate["rsiDoubleTrap"];
  if (pending.mode === "rsi-double-trap") {
    if (pending.extremeRsi == null) return done("VAR_WAIT_RSI");
    const current: CompletedExcursion = {
      previousClose: { ...pending.previousClose! },
      returnClose: candle.close,
      profileEnd: profile.end,
      outsideBar: { ...pending.firstOutside! },
      returnTimestamp: candle.timestamp,
      extremeTimestamp: pending.extremeTimestamp!,
      extremePrice: pending.extreme,
      extremeRsi: pending.extremeRsi,
    };
    const prior = state.completedExcursions[pending.direction];
    // Store every valid completion, even while position/cooldown/RR later blocks an entry.
    state.completedExcursions[pending.direction] = current;
    if (
      !prior ||
      prior.returnTimestamp >= pending.started ||
      pending.started - prior.returnTimestamp > config.VAR_MAX_HOLD_BARS * step
    )
      return done("VAR_WAIT_SECOND_EXCURSION");
    if (
      !(pending.direction === "LONG"
        ? current.extremePrice < prior.extremePrice &&
          current.extremeRsi > prior.extremeRsi
        : current.extremePrice > prior.extremePrice &&
          current.extremeRsi < prior.extremeRsi)
    )
      return done("VAR_RSI_DIVERGENCE_REJECTED");
    rsiDoubleTrap = {
      prior: structuredClone(prior),
      current: structuredClone(current),
    };
  }
  if (atr == null || !Number.isFinite(atr) || atr <= 0)
    return done("VAR_WAIT_ATR");
  return done("VAR_RECLAIM", {
    direction: pending.direction,
    timestamp: candle.timestamp,
    excursionStart: pending.started,
    extreme: pending.extreme,
    atr,
    profile,
    entryMode: pending.mode,
    ...(pending.mode === "accepted-return"
      ? {
          acceptedReturn: {
            profileEnd: profile.end,
            priorCloses: structuredClone(pending.acceptedCloses!),
            outsideBar: { ...pending.firstOutside! },
            returnTimestamp: candle.timestamp,
          },
        }
      : {}),
    ...(rsiDoubleTrap ? { rsiDoubleTrap } : {}),
    ...(pending.mode === "prior-day-trap"
      ? {
          priorDayTrap: {
            previousDayRange: { ...pending.previousDayRange! },
            previousClose: { ...pending.previousClose! },
            outsideBar: { ...pending.firstOutside! },
            returnTimestamp: candle.timestamp,
          },
        }
      : {}),
  });
}
export function createValueAreaReclaimEngine(
  options: {
    config?: Partial<ValueAreaReclaimConfig>;
    initialCandles?: readonly ProfileCandle[];
    checkpoint?: EngineState;
    profileForDay?: (day: number) => ValueAreaProfile | null;
    previousDayRangeForDay?: (day: number) => PreviousDayRange | null;
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
    state.trueRanges.length > config.VAR_ATR_PERIOD ||
    !Array.isArray(state.acceptedCloses) ||
    state.acceptedCloses.length > 4 ||
    !Array.isArray(state.rsiChanges) ||
    state.rsiChanges.length > 14 ||
    !state.completedExcursions
  )
    throw new Error("Incompatible ValueAreaReclaim checkpoint");
  const next = (candle: ProfileCandle) =>
    advanceEngine(
      state,
      config,
      candle,
      state.profileDay !== utcDayStart(candle.timestamp)
        ? options.profileForDay?.(utcDayStart(candle.timestamp))
        : undefined,
      state.profileDay !== utcDayStart(candle.timestamp)
        ? options.previousDayRangeForDay?.(utcDayStart(candle.timestamp))
        : undefined,
    );
  for (const candle of options.initialCandles ?? []) next(candle);
  return {
    next: (candle: ProfileCandle) => structuredClone(next(candle)),
    getState: () => structuredClone(state),
  };
}
