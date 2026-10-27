import type { AiPayload, StrategyAiAdapter } from "@tradejs/types";
import {
  valueAreaReclaimGateAllows,
  valueAreaReclaimGatePolicy,
} from "./gate.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Normalize causal setup geometry and apply the frozen research gate. */
export const buildValueAreaReclaimAiPayload = (
  basePayload: AiPayload,
): AiPayload => {
  const { signal } = basePayload;
  const setup = record(record(basePayload.indicators).valueAreaReclaim);
  const profile = record(setup.profile);
  const { val, vah, poc } = profile;
  const netRiskRatio = setup.netRiskRatio;
  const prices = signal.prices;
  const current = prices.currentPrice;
  const stop = prices.stopLossPrice;
  const target = prices.takeProfitPrice;
  const atr = setup.atr;
  const interval = Number(signal.interval) * 60_000;
  const side = signal.direction === "LONG" ? 1 : -1;
  const valid =
    (signal.direction === "LONG" || signal.direction === "SHORT") &&
    finite(signal.timestamp) &&
    finite(current) &&
    current > 0 &&
    finite(stop) &&
    finite(target) &&
    finite(atr) &&
    atr > 0 &&
    finite(profile.start) &&
    finite(profile.end) &&
    profile.start < profile.end &&
    profile.end <= signal.timestamp &&
    finite(val) &&
    finite(vah) &&
    finite(poc) &&
    vah > val &&
    poc >= val &&
    poc <= vah &&
    finite(netRiskRatio) &&
    netRiskRatio > 0 &&
    side * (current - stop) > 0 &&
    side * (target - current) > 0;
  const features: Record<string, number> = {};
  if (valid) {
    const width = vah - val;
    features.atrPct = (atr / current) * 100;
    features.stopDistanceAtr = Math.abs(current - stop) / atr;
    features.rewardDistanceAtr = Math.abs(target - current) / atr;
    features.netRiskRatio = netRiskRatio;
    features.valueWidthAtr = width / atr;
    features.pocPosition = (poc - val) / width;
    features.reclaimDepth =
      side === 1 ? (current - val) / width : (vah - current) / width;
    if (
      finite(setup.excursionStart) &&
      setup.excursionStart <= signal.timestamp &&
      Number.isFinite(interval) &&
      interval > 0
    )
      features.excursionBars =
        (signal.timestamp - setup.excursionStart) / interval;
    const previousDay = record(setup.previousDayRange);
    if (
      finite(previousDay.high) &&
      finite(previousDay.low) &&
      finite(previousDay.end) &&
      previousDay.end <= signal.timestamp
    )
      features.previousDayWidthAtr = (previousDay.high - previousDay.low) / atr;
  }
  const trainedScope =
    signal.interval === valueAreaReclaimGatePolicy.interval &&
    setup.entryMode === valueAreaReclaimGatePolicy.entryMode &&
    finite(profile.start) &&
    finite(profile.end) &&
    profile.end - profile.start ===
      valueAreaReclaimGatePolicy.profileDays * 86_400_000;
  const approved =
    valid &&
    trainedScope &&
    valueAreaReclaimGateAllows(signal.direction, features);
  const reasons = !valid
    ? ["VAR_INVALID_CAUSAL_SETUP"]
    : !trainedScope
      ? ["VAR_UNTRAINED_GATE_SCOPE"]
      : !approved
        ? ["VAR_Q4_RULE_NOT_MATCHED"]
        : [];
  return {
    ...basePayload,
    additionalIndicators: {
      ...record(basePayload.additionalIndicators),
      approvalAllowedNow: approved,
      deterministicQuality: approved ? valueAreaReclaimGatePolicy.quality : 1,
      structuralHardBlockReasons: reasons,
      valueAreaReclaimSetupFeatures: features,
    },
  };
};

export const valueAreaReclaimAiAdapter: StrategyAiAdapter = {
  buildPayload: ({ basePayload }) =>
    buildValueAreaReclaimAiPayload(basePayload),
};
