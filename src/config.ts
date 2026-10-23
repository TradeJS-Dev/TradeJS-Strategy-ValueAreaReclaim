import { createStrategyConfigParser } from "@tradejs/strategy-kit/config";
import type { StrategyConfig } from "@tradejs/types";

export const STRATEGY_NAME = "ValueAreaReclaim";

export interface ValueAreaReclaimConfig extends StrategyConfig {
  INTERVAL: "15" | "60";
  VAR_PROFILE_DAYS: number;
  VAR_VALUE_FRACTION: number;
  VAR_ATR_PERIOD: number;
  VAR_ATR_BUFFER: number;
  VAR_RECLAIM_BARS: number;
  VAR_MAX_HOLD_BARS: number;
  VAR_MIN_RR: number;
  VAR_COOLDOWN_BARS: number;
  VAR_MAX_ENTRIES_PER_SIDE: number;
  VAR_LONG: boolean;
  VAR_SHORT: boolean;
  MAX_LOSS_VALUE: number;
}

export const defaultConfig: ValueAreaReclaimConfig = {
  INTERVAL: "15",
  VAR_PROFILE_DAYS: 3,
  VAR_VALUE_FRACTION: 0.7,
  VAR_ATR_PERIOD: 14,
  VAR_ATR_BUFFER: 0.25,
  VAR_RECLAIM_BARS: 4,
  VAR_MAX_HOLD_BARS: 32,
  VAR_MIN_RR: 1.5,
  VAR_COOLDOWN_BARS: 8,
  VAR_MAX_ENTRIES_PER_SIDE: 1,
  VAR_LONG: true,
  VAR_SHORT: true,
  MAX_LOSS_VALUE: 10,
  RISK_FEE_RATE: 0.0006,
  RISK_SLIPPAGE_BPS: 2,
  RISK_MARKET_IMPACT_BPS: 0,
};

const baseParser = createStrategyConfigParser({
  strategyName: STRATEGY_NAME,
  defaults: defaultConfig,
});

export function parseConfig(input: unknown): ValueAreaReclaimConfig {
  const config = baseParser(input);
  if (!["15", "60"].includes(config.INTERVAL)) {
    throw new Error("ValueAreaReclaim.INTERVAL must be 15 or 60");
  }
  const bounds = {
    VAR_PROFILE_DAYS: [2, 14],
    VAR_ATR_PERIOD: [2, 96],
    VAR_RECLAIM_BARS: [1, 96],
    VAR_MAX_HOLD_BARS: [1, 672],
    VAR_COOLDOWN_BARS: [0, 672],
    VAR_MAX_ENTRIES_PER_SIDE: [1, 10],
  } as const;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = config[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `${STRATEGY_NAME}.${key} must be an integer in [${min}, ${max}]`,
      );
    }
  }
  if (!(config.VAR_VALUE_FRACTION > 0 && config.VAR_VALUE_FRACTION <= 1)) {
    throw new Error("VAR_VALUE_FRACTION must be in (0, 1]");
  }
  for (const key of [
    "VAR_ATR_BUFFER",
    "VAR_MIN_RR",
    "MAX_LOSS_VALUE",
  ] as const) {
    if (!(config[key] > 0)) throw new Error(`${key} must be positive`);
  }
  for (const key of [
    "RISK_FEE_RATE",
    "RISK_SLIPPAGE_BPS",
    "RISK_MARKET_IMPACT_BPS",
  ] as const) {
    const value = config[key];
    if (value == null || value < 0)
      throw new Error(`${key} must be nonnegative`);
  }
  if ((config.RISK_FEE_RATE ?? 0) >= 1)
    throw new Error("RISK_FEE_RATE must be below 1");
  if (
    (config.BACKTEST_ENTRY_DELAY_BARS ?? 0) !== 0 ||
    (config.BACKTEST_EXECUTION_DELAY_MS ?? 0) !== 0
  ) {
    throw new Error("ValueAreaReclaim v1 requires zero entry delay");
  }
  if (config.BACKTEST_PRICE_MODE && config.BACKTEST_PRICE_MODE !== "close") {
    throw new Error("ValueAreaReclaim v1 requires close decision prices");
  }
  return config;
}

export const configKey = (config: ValueAreaReclaimConfig) =>
  JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
