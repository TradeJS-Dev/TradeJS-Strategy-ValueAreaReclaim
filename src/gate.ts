/** Frozen on mature development data before the historical test was opened. */
export const valueAreaReclaimGatePolicy = Object.freeze({
  id: "var-20261027-three-year-rounded-1",
  interval: "60",
  entryMode: "prior-day-trap",
  profileDays: 3,
  quality: 4,
  longMaxPocPosition: 0.35,
  longMaxNetRiskRatio: 1.6,
  shortMinReclaimDepth: 0.15,
  shortMinStopDistanceAtr: 1.2,
} as const);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Requires a structurally valid, causal setup; missing used features reject. */
export const valueAreaReclaimGateAllows = (
  direction: string,
  features: Readonly<Record<string, unknown>>,
): boolean => {
  if (direction === "LONG")
    return (
      finite(features.pocPosition) &&
      finite(features.netRiskRatio) &&
      features.pocPosition <= valueAreaReclaimGatePolicy.longMaxPocPosition &&
      features.netRiskRatio <= valueAreaReclaimGatePolicy.longMaxNetRiskRatio
    );
  if (direction === "SHORT")
    return (
      finite(features.reclaimDepth) &&
      finite(features.stopDistanceAtr) &&
      features.reclaimDepth >=
        valueAreaReclaimGatePolicy.shortMinReclaimDepth &&
      features.stopDistanceAtr >=
        valueAreaReclaimGatePolicy.shortMinStopDistanceAtr
    );
  return false;
};
