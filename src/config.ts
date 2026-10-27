import { createStrategyConfigParser } from "@tradejs/strategy-kit/config";
import type { StrategyConfig } from "@tradejs/types";

export const STRATEGY_NAME = "ValueAreaReclaim";

export type EntryMode =
  | "legacy"
  | "accepted-return"
  | "rsi-double-trap"
  | "prior-day-trap";

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
  VAR_ENTRY_MODE: EntryMode;
  VAR_ENTRY_MODE_LONG: EntryMode | "inherit";
  VAR_ENTRY_MODE_SHORT: EntryMode | "inherit";
  VAR_REQUIRE_VALUE_MIGRATION: boolean;
  VAR_REQUIRE_VALUE_MIGRATION_LONG: boolean;
  VAR_REQUIRE_VALUE_MIGRATION_SHORT: boolean;
  /** Rejected research paths are unavailable in this source checkpoint. */
  VAR_REQUIRE_BALANCED_VALUE: boolean;
  VAR_EXIT_ON_VALUE_LOSS: boolean;
  VAR_PROTECT_PROGRESS: boolean;
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
  VAR_ENTRY_MODE: "legacy",
  VAR_ENTRY_MODE_LONG: "inherit",
  VAR_ENTRY_MODE_SHORT: "inherit",
  VAR_REQUIRE_VALUE_MIGRATION: false,
  VAR_REQUIRE_VALUE_MIGRATION_LONG: false,
  VAR_REQUIRE_VALUE_MIGRATION_SHORT: false,
  VAR_REQUIRE_BALANCED_VALUE: false,
  VAR_EXIT_ON_VALUE_LOSS: false,
  VAR_PROTECT_PROGRESS: false,
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
  const modes = [
    "legacy",
    "accepted-return",
    "rsi-double-trap",
    "prior-day-trap",
  ];
  if (!modes.includes(config.VAR_ENTRY_MODE))
    throw new Error("Invalid VAR_ENTRY_MODE");
  for (const key of ["VAR_ENTRY_MODE_LONG", "VAR_ENTRY_MODE_SHORT"] as const)
    if (!["inherit", ...modes].includes(config[key]))
      throw new Error(`Invalid ${key}`);
  for (const key of [
    "VAR_REQUIRE_BALANCED_VALUE",
    "VAR_EXIT_ON_VALUE_LOSS",
    "VAR_PROTECT_PROGRESS",
    "VAR_REQUIRE_VALUE_MIGRATION",
    "VAR_REQUIRE_VALUE_MIGRATION_LONG",
    "VAR_REQUIRE_VALUE_MIGRATION_SHORT",
  ] as const)
    if (config[key])
      throw new Error(`${key} is unavailable in this research checkpoint`);
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

export const entryModeFor = (
  config: ValueAreaReclaimConfig,
  direction: "LONG" | "SHORT",
): EntryMode => {
  const side =
    direction === "LONG"
      ? config.VAR_ENTRY_MODE_LONG
      : config.VAR_ENTRY_MODE_SHORT;
  return side === "inherit" ? config.VAR_ENTRY_MODE : side;
};
export const needsPreviousDayRange = (config: ValueAreaReclaimConfig) =>
  entryModeFor(config, "LONG") === "prior-day-trap" ||
  entryModeFor(config, "SHORT") === "prior-day-trap";
