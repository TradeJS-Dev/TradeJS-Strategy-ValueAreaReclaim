import type {
  CreateStrategyCore,
  Direction,
  StrategyDecision,
} from "@tradejs/types";
import {
  configKey,
  parseConfig,
  type ValueAreaReclaimConfig,
} from "./config.js";
import {
  advanceEngine,
  createEngineState,
  type EngineState,
  executionIntervalMs,
} from "./engine.js";
import { buildFigures } from "./figures.js";
import {
  buildValueAreaProfile,
  UTC_DAY_MS,
  utcDayStart,
  type ValueAreaProfile,
} from "./profile.js";

export interface CoreState {
  engine: EngineState;
  seeded: boolean;
  processedTimestamp: number | null;
  budgetDay: number | null;
  entries: Record<Direction, number>;
  lastAttempt: number | null;
  holding: { direction: Direction; since: number } | null;
  profileReadCode: string | null;
}

export const createValueAreaReclaimCore: CreateStrategyCore<
  ValueAreaReclaimConfig
> = async ({ config: rawConfig, data, strategyApi }) => {
  // Shared runtime injects execution-only fields after registry validation.
  // They are not user strategy settings and must not loosen the public parser.
  const strategyConfig = { ...rawConfig };
  for (const key of ["ENV", "MAKE_ORDERS", "CLOSE_OPPOSITE_POSITIONS", "JEV"]) {
    delete strategyConfig[key];
  }
  const config = parseConfig(strategyConfig);
  const step = executionIntervalMs(config);
  const controller = strategyApi.createStateController<CoreState>(
    "ValueAreaReclaim/v1",
    () => ({
      engine: createEngineState(config),
      seeded: false,
      processedTimestamp: null,
      budgetDay: null,
      entries: { LONG: 0, SHORT: 0 },
      lastAttempt: null,
      holding: null,
      profileReadCode: null,
    }),
    { configKey: configKey(config) },
  );

  return async (): Promise<StrategyDecision> => {
    const { candle, currentPrice, timestamp } =
      await strategyApi.getDecisionPriceContext();
    const state = controller.get();
    if (state.processedTimestamp === timestamp)
      return strategyApi.skip("VAR_ALREADY_PROCESSED");
    if (
      state.processedTimestamp != null &&
      timestamp < state.processedTimestamp
    )
      throw new Error("Non-monotonic core decision");
    // Claim before any source IO so concurrent repeats cannot issue another entry.
    state.processedTimestamp = timestamp;
    const day = utcDayStart(candle.timestamp);
    let sourceProfile: ValueAreaProfile | null | undefined;
    if (config.INTERVAL === "60" && state.engine.profileDay !== day) {
      // One bounded source read per UTC day. Empty/failed windows block entries,
      // while existing positions still receive their holding-time exit.
      state.profileReadCode = null;
      try {
        const source = await strategyApi.getClosedCandles({
          interval: "15",
          start: day - config.VAR_PROFILE_DAYS * UTC_DAY_MS,
          end: day,
          limit: config.VAR_PROFILE_DAYS * 96,
        });
        sourceProfile = source.complete
          ? buildValueAreaProfile(
              source.candles,
              day,
              config.VAR_PROFILE_DAYS,
              config.VAR_VALUE_FRACTION,
            )
          : null;
        if (!source.complete)
          state.profileReadCode = "VAR_15M_HISTORY_INCOMPLETE";
      } catch {
        sourceProfile = null;
        state.profileReadCode = "VAR_15M_HISTORY_UNAVAILABLE";
      }
    }
    if (!state.seeded) {
      // Capture only the causal prefix; runtime data may also contain newer candles.
      const initial = data
        .filter((c) => c.timestamp < candle.timestamp)
        .slice(
          -(config.INTERVAL === "15"
            ? (config.VAR_PROFILE_DAYS + 1) * 96
            : Math.max(config.VAR_ATR_PERIOD + 1, 25)),
        );
      for (const row of initial)
        advanceEngine(
          state.engine,
          config,
          row,
          config.INTERVAL === "60"
            ? utcDayStart(row.timestamp) === day
              ? sourceProfile
              : null
            : undefined,
        );
      state.seeded = true;
    }
    const result = advanceEngine(state.engine, config, candle, sourceProfile);
    if (state.budgetDay !== day) {
      state.budgetDay = day;
      state.entries = { LONG: 0, SHORT: 0 };
    }
    const position = await strategyApi.getCurrentPosition();
    if (position && position.qty > 0) {
      state.engine.pending = null;
      if (!state.holding || state.holding.direction !== position.direction) {
        // Position has no opening timestamp in StrategyAPI: close an unbound position conservatively.
        return strategyApi.exit({
          code: "VAR_POSITION_WITHOUT_CHECKPOINT",
          direction: position.direction,
        });
      }
      if (timestamp - state.holding.since >= config.VAR_MAX_HOLD_BARS * step) {
        return strategyApi.exit({
          code: "VAR_MAX_HOLD",
          direction: position.direction,
        });
      }
      return strategyApi.skip("VAR_POSITION_EXISTS");
    }
    state.holding = null;
    const candidate = result.candidate;
    if (!candidate)
      return strategyApi.skip(state.profileReadCode ?? result.code);
    const { direction, profile } = candidate;
    if (!(direction === "LONG" ? config.VAR_LONG : config.VAR_SHORT))
      return strategyApi.skip("VAR_DIRECTION_DISABLED");
    if (state.entries[direction] >= config.VAR_MAX_ENTRIES_PER_SIDE)
      return strategyApi.skip("VAR_PROFILE_ENTRY_LIMIT");
    if (
      state.lastAttempt != null &&
      timestamp - state.lastAttempt <= config.VAR_COOLDOWN_BARS * step
    ) {
      return strategyApi.skip("VAR_COOLDOWN");
    }
    const sign = direction === "LONG" ? 1 : -1;
    const stop =
      candidate.extreme - sign * candidate.atr * config.VAR_ATR_BUFFER;
    const risk = sign * (currentPrice - stop);
    const reward = sign * (profile.poc - currentPrice);
    const oneWayCost =
      (config.RISK_FEE_RATE ?? 0) +
      ((config.RISK_SLIPPAGE_BPS ?? 0) + (config.RISK_MARKET_IMPACT_BPS ?? 0)) /
        10_000;
    const netRisk = risk + (currentPrice + stop) * oneWayCost;
    const netReward = reward - (currentPrice + profile.poc) * oneWayCost;
    const qty = config.MAX_LOSS_VALUE / netRisk;
    if (
      stop <= 0 ||
      risk <= 0 ||
      netReward <= 0 ||
      netReward / netRisk < config.VAR_MIN_RR ||
      ![stop, qty, netRisk, netReward].every(Number.isFinite) ||
      qty <= 0
    )
      return strategyApi.skip("VAR_MIN_RR");
    // Count accepted entry decisions, including orders later rejected by host policy.
    const decision = await strategyApi.entry({
      code: "VAR_RECLAIM_ENTRY",
      direction,
      signalId: `var-${profile.end}-${direction}-${timestamp}`,
      figures: buildFigures(candidate, currentPrice, stop),
      indicators: {
        valueAreaReclaim: {
          profile,
          excursionStart: candidate.excursionStart,
          extreme: candidate.extreme,
          atr: candidate.atr,
          netRiskRatio: netReward / netRisk,
        },
      },
      orderPlan: {
        qty,
        stopLossPrice: stop,
        takeProfits: [{ price: profile.poc, rate: 1 }],
      },
    });
    state.entries[direction]++;
    state.lastAttempt = timestamp;
    state.holding = { direction, since: timestamp };
    return decision;
  };
};
