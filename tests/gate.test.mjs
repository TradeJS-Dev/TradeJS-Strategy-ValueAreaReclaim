import assert from "node:assert/strict";
import test from "node:test";
import { valueAreaReclaimGateAllows as allow } from "../dist/index.js";

test("LONG thresholds are inclusive and each is required", () => {
  const f = { pocPosition: 0.35, netRiskRatio: 1.6 };
  assert.equal(allow("LONG", f), true);
  assert.equal(allow("LONG", { ...f, pocPosition: 0.35 + 1e-10 }), false);
  assert.equal(allow("LONG", { ...f, netRiskRatio: 1.6 + 1e-10 }), false);
  assert.equal(allow("SHORT", f), false);
});

test("SHORT thresholds are inclusive and each is required", () => {
  const f = { reclaimDepth: 0.15, stopDistanceAtr: 1.2 };
  assert.equal(allow("SHORT", f), true);
  assert.equal(allow("SHORT", { ...f, reclaimDepth: 0.15 - 1e-10 }), false);
  assert.equal(allow("SHORT", { ...f, stopDistanceAtr: 1.2 - 1e-10 }), false);
  assert.equal(allow("LONG", f), false);
});

test("missing, non-finite or string inputs cannot approve either side", () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, "0.3"]) {
    assert.equal(
      allow("LONG", { pocPosition: value, netRiskRatio: 1.6 }),
      false,
    );
    assert.equal(
      allow("LONG", { pocPosition: 0.3, netRiskRatio: value }),
      false,
    );
    assert.equal(
      allow("SHORT", { reclaimDepth: value, stopDistanceAtr: 1.2 }),
      false,
    );
    assert.equal(
      allow("SHORT", { reclaimDepth: 0.2, stopDistanceAtr: value }),
      false,
    );
  }
  assert.equal(allow("unknown", {}), false);
});

test("unrelated geometry and outcome fields cannot affect the rule", () => {
  const f = { pocPosition: 0.3, netRiskRatio: 1.58 };
  assert.equal(
    allow("LONG", {
      ...f,
      profit: -1e12,
      symbol: "unexpected",
      exitTimestamp: Infinity,
    }),
    true,
  );
  assert.deepEqual(f, { pocPosition: 0.3, netRiskRatio: 1.58 });
});
