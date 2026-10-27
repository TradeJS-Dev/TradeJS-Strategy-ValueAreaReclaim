import assert from "node:assert/strict";
import test from "node:test";
import { buildFigures, buildValueAreaProfile } from "../dist/index.js";
import { history, END, STEP } from "./helpers.mjs";

test("figure segments stay visible on the first bar and order levels start at the decision", () => {
  const profile = buildValueAreaProfile(history(), END, 2, 0.9);
  for (const step of [STEP, STEP * 4]) {
    for (const timestamp of [END, END + 2 * step]) {
      const figures = buildFigures(
        {
          profile,
          timestamp,
          direction: "LONG",
          excursionStart: END,
          extreme: 122.8,
          atr: 0.3,
        },
        123.2,
        122.7,
        step,
      );
      for (const line of figures.lines) {
        const profileLevel = ["var_VAH", "var_VAL", "var_POC"].includes(
          line.kind,
        );
        assert.equal(line.points[0].timestamp, profileLevel ? END : timestamp);
        assert.equal(line.points[1].timestamp, timestamp + step);
        assert.ok(line.points[1].timestamp > line.points[0].timestamp);
        assert.equal(line.points[0].value, line.points[1].value);
      }
    }
  }
});
