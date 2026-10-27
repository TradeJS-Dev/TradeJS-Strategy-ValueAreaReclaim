import assert from "node:assert/strict";
import test from "node:test";
import { buildValueAreaReclaimAiPayload } from "../dist/index.js";

const timestamp = Date.UTC(2025, 0, 4, 12);
function payload(direction = "LONG") {
  return {
    signal: {
      symbol: "BTCUSDT",
      signalId: "setup",
      strategy: "ValueAreaReclaim",
      interval: "60",
      direction,
      timestamp,
      prices:
        direction === "LONG"
          ? { currentPrice: 100, stopLossPrice: 96, takeProfitPrice: 104 }
          : { currentPrice: 100, stopLossPrice: 104, takeProfitPrice: 96 },
    },
    figures: {},
    additionalIndicators: { setupId: "retained" },
    indicators: {
      valueAreaReclaim: {
        profile: {
          start: timestamp - 3 * 86400000 - 43200000,
          end: timestamp - 43200000,
          val: 94,
          vah: 106,
          poc: direction === "LONG" ? 104 : 96,
        },
        atr: 2,
        entryMode: "prior-day-trap",
        netRiskRatio: 1.8,
        excursionStart: timestamp - 3600000,
        previousDayRange: { low: 92, high: 108, end: timestamp - 43200000 },
      },
    },
  };
}
for (const direction of ["LONG", "SHORT"]) {
  test(`learned ${direction} decision retains causal normalized geometry`, () => {
    const p = payload(direction),
      r = buildValueAreaReclaimAiPayload(p);
    assert.equal(
      r.additionalIndicators.approvalAllowedNow,
      direction === "SHORT",
    );
    assert.equal(
      r.additionalIndicators.deterministicQuality,
      direction === "SHORT" ? 4 : 1,
    );
    assert.equal(r.additionalIndicators.setupId, "retained");
    const f = r.additionalIndicators.valueAreaReclaimSetupFeatures;
    assert.equal(f.atrPct, 2);
    assert.equal(f.stopDistanceAtr, 2);
    assert.equal(f.rewardDistanceAtr, 2);
    assert.equal(f.valueWidthAtr, 6);
    assert.equal(f.reclaimDepth, 0.5);
    assert.equal(f.excursionBars, 1);
    assert.equal(f.previousDayWidthAtr, 8);
    assert.equal(p.additionalIndicators.approvalAllowedNow, undefined);
  });
}
test("future profile fails closed but exact decision boundary is causal", () => {
  const p = payload("SHORT");
  p.indicators.valueAreaReclaim.profile.end = timestamp;
  p.indicators.valueAreaReclaim.profile.start = timestamp - 3 * 86400000;
  assert.equal(
    buildValueAreaReclaimAiPayload(p).additionalIndicators.approvalAllowedNow,
    true,
  );
  p.indicators.valueAreaReclaim.profile.end = timestamp + 1;
  const r = buildValueAreaReclaimAiPayload(p).additionalIndicators;
  assert.equal(r.approvalAllowedNow, false);
  assert.deepEqual(r.structuralHardBlockReasons, ["VAR_INVALID_CAUSAL_SETUP"]);
  assert.deepEqual(r.valueAreaReclaimSetupFeatures, {});
});
test("missing setup, invalid ATR and inverted order prices fail closed", () => {
  for (const alter of [
    (p) => {
      p.indicators = {};
    },
    (p) => {
      p.indicators.valueAreaReclaim.atr = 0;
    },
    (p) => {
      p.indicators.valueAreaReclaim.atr = NaN;
    },
    (p) => {
      p.signal.prices.stopLossPrice = 101;
    },
    (p) => {
      p.signal.prices.takeProfitPrice = 99;
    },
    (p) => {
      p.indicators.valueAreaReclaim.netRiskRatio = null;
    },
  ]) {
    const p = payload();
    alter(p);
    assert.equal(
      buildValueAreaReclaimAiPayload(p).additionalIndicators.approvalAllowedNow,
      false,
    );
  }
});
test("future optional range or excursion never becomes a feature", () => {
  const p = payload();
  p.indicators.valueAreaReclaim.previousDayRange.end = timestamp + 1;
  p.indicators.valueAreaReclaim.excursionStart = timestamp + 1;
  const f =
    buildValueAreaReclaimAiPayload(p).additionalIndicators
      .valueAreaReclaimSetupFeatures;
  assert.equal(f.previousDayWidthAtr, undefined);
  assert.equal(f.excursionBars, undefined);
});
test("completed outcomes do not influence causal gate features or learned approval", () => {
  const p = payload(),
    before = buildValueAreaReclaimAiPayload(p);
  p.tradeResult = { netProfit: 1e12, exitTimestamp: timestamp + 86400000 };
  assert.deepEqual(
    buildValueAreaReclaimAiPayload(p).additionalIndicators,
    before.additionalIndicators,
  );
});

test("the frozen LONG rule accepts a valid low POC setup", () => {
  const p = payload();
  p.signal.prices = {
    currentPrice: 94.4,
    stopLossPrice: 91.1,
    takeProfitPrice: 100,
  };
  Object.assign(p.indicators.valueAreaReclaim.profile, {
    val: 94,
    vah: 114,
    poc: 100,
  });
  p.indicators.valueAreaReclaim.netRiskRatio = 1.58;
  const r = buildValueAreaReclaimAiPayload(p).additionalIndicators;
  assert.equal(r.approvalAllowedNow, true);
  assert.equal(r.deterministicQuality, 4);
  assert.deepEqual(r.structuralHardBlockReasons, []);
});

test("untrained interval, entry mode and profile length fail closed", () => {
  for (const alter of [
    (p) => {
      p.signal.interval = "15";
    },
    (p) => {
      p.indicators.valueAreaReclaim.entryMode = "legacy";
    },
    (p) => {
      p.indicators.valueAreaReclaim.profile.start -= 86400000;
    },
  ]) {
    const p = payload("SHORT");
    alter(p);
    const r = buildValueAreaReclaimAiPayload(p).additionalIndicators;
    assert.equal(r.approvalAllowedNow, false);
    assert.deepEqual(r.structuralHardBlockReasons, [
      "VAR_UNTRAINED_GATE_SCOPE",
    ]);
  }
});
