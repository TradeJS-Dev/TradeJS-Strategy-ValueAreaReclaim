import assert from "node:assert/strict";
import test from "node:test";
import { harness, END, STEP, DAY, longBar, shortBar } from "./helpers.mjs";

test("setup identity follows the original excursion across JSON restoration", async () => {
  for (const side of ["LONG", "SHORT"]) {
    const overrides = { VAR_MIN_RR: 0.5 };
    const h = await harness({ overrides });
    const outside =
      side === "LONG"
        ? longBar(END, { open: 122.8, low: 122, high: 122.9, close: 122.5 })
        : shortBar(END, { open: 126.2, low: 126.1, high: 127, close: 126.5 });
    assert.equal((await h.next(outside)).kind, "skip");
    const restored = await harness({
      overrides,
      initial: h.data,
      stores: new Map(JSON.parse(JSON.stringify([...h.stores]))),
    });
    const reclaim = (side === "LONG" ? longBar : shortBar)(END + STEP);
    const expected = await h.next(reclaim);
    const actual = await restored.next(reclaim);
    assert.equal(expected.kind, "entry");
    const setupId = `var:${END - 2 * DAY}:${END}:${side}:${END}`;
    assert.equal(expected.signal.indicators.setupId, setupId);
    assert.equal(actual.signal.indicators.setupId, setupId);
    assert.equal(actual.signal.additionalIndicators.setupId, setupId);
    assert.equal(actual.signal.signalId, expected.signal.signalId);
    assert.deepEqual(actual.orderPlan, expected.orderPlan);
  }
});
