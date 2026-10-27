import { defineStrategyPlugin } from "@tradejs/core/config";
import type { ValidatedStrategyRegistryEntry } from "@tradejs/strategy-kit/config";
import {
  defaultConfig,
  parseConfig,
  STRATEGY_NAME,
  type ValueAreaReclaimConfig,
} from "./config.js";
import { createValueAreaReclaimCore } from "./core.js";
import { valueAreaReclaimAiAdapter } from "./ai.js";

const entry: ValidatedStrategyRegistryEntry<ValueAreaReclaimConfig> = {
  defaults: defaultConfig,
  parseConfig,
  manifest: { name: STRATEGY_NAME, aiAdapter: valueAreaReclaimAiAdapter },
  createCore: createValueAreaReclaimCore,
};
export const strategyEntries = defineStrategyPlugin({
  strategyEntries: [entry],
}).strategyEntries;
export default defineStrategyPlugin({ strategyEntries });
export * from "./config.js";
export * from "./profile.js";
export * from "./engine.js";
export * from "./core.js";
export * from "./figures.js";
export * from "./ai.js";
export * from "./gate.js";

export type { ClosedCandlesCapability } from "./history.js";

export * from "./rsi.js";
