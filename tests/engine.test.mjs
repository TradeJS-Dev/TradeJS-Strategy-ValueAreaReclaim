import assert from "node:assert/strict";
import test from "node:test";
import { createValueAreaReclaimEngine, utcDayStart } from "../dist/index.js";
import {
  END,
  STEP,
  DAY,
  history,
  config,
  bar,
  longBar,
  shortBar,
} from "./helpers.mjs";
const engine = (cfg = {}) =>
  createValueAreaReclaimEngine({
    config: config(cfg),
    initialCandles: history(),
  });

test("LONG and SHORT require an outside excursion and close strictly inside", () => {
  for (const [row, direction] of [
    [longBar(END), "LONG"],
    [shortBar(END), "SHORT"],
  ]) {
    const e = engine();
    const result = e.next(row);
    assert.equal(result.candidate.direction, direction);
    assert.equal(result.candidate.profile.end, END);
    assert.equal(result.candidate.timestamp, END);
  }
  const e = engine();
  assert.equal(e.next(bar(END)).candidate, null);
  assert.equal(
    e.next(longBar(END + STEP, { close: 123 })).code,
    "VAR_WAIT_RECLAIM",
  );
  assert.equal(e.next(longBar(END + 2 * STEP)).candidate.direction, "LONG");
});
test("successful breakout is never an entry, and late reclaim expires", () => {
  const e = engine({ VAR_RECLAIM_BARS: 2 });
  const outside = (t) =>
    longBar(t, { open: 122.8, low: 122, high: 122.9, close: 122.5 });
  assert.equal(e.next(outside(END)).code, "VAR_WAIT_RECLAIM");
  assert.equal(e.next(outside(END + STEP)).candidate, null);
  assert.equal(e.next(outside(END + 2 * STEP)).candidate, null);
  assert.equal(e.next(longBar(END + 3 * STEP)).code, "VAR_RECLAIM_EXPIRED");
  const timely = engine({ VAR_RECLAIM_BARS: 2 });
  timely.next(outside(END));
  timely.next(outside(END + STEP));
  assert.equal(
    timely.next(longBar(END + 2 * STEP)).candidate.direction,
    "LONG",
  );
});
test("extreme includes the whole excursion and the return candle", () => {
  const e = engine();
  e.next(longBar(END, { open: 122.7, high: 122.9, low: 122, close: 122.5 }));
  const r = e.next(longBar(END + STEP, { low: 121 }));
  assert.equal(r.candidate.extreme, 121);
  assert.equal(r.candidate.excursionStart, END);
});
test("ambiguous candles and crossing the opposite edge invalidate the setup", () => {
  const e = engine();
  assert.equal(
    e.next(bar(END, { low: 122, high: 127 })).code,
    "VAR_AMBIGUOUS_BOTH_BOUNDARIES",
  );
  e.next(bar(END + STEP));
  e.next(longBar(END + 2 * STEP, { high: 122.9, open: 122.8, close: 122.8 }));
  assert.equal(
    e.next(
      bar(END + 3 * STEP, { open: 125, low: 124, high: 127, close: 126.5 }),
    ).code,
    "VAR_CROSSED_OPPOSITE_BOUNDARY",
  );
});
test("UTC transition rebuilds once per day and never includes the new day's candle", () => {
  const e = engine();
  const first = e.next(bar(END));
  const p = e.getState().profile;
  const rebuilds = e.getState().rebuilds;
  for (let i = 1; i < 96; i++)
    e.next(bar(END + i * STEP, { high: 1000, volume: 1000 }));
  assert.deepEqual(e.getState().profile, p);
  assert.equal(e.getState().rebuilds, rebuilds);
  e.next(bar(END + DAY, { high: 10000, volume: 1e8 }));
  assert.equal(e.getState().profile.end, END + DAY);
  assert.equal(e.getState().profile.high, 1000);
  assert.equal(e.getState().rebuilds, rebuilds + 1);
  assert.equal(utcDayStart(Date.parse("2026-10-20T02:59:59+03:00")), END - DAY);
  assert.equal(first.candidate, null);
});
test("day rollover and candle gaps cancel pending setups", () => {
  const rows = history();
  // A constant repeating profile retains concentrated volumes on the next day.
  rows[96].volume = 60;
  rows[98] = { ...rows[2], timestamp: rows[98].timestamp };
  rows[99] = { ...rows[3], timestamp: rows[99].timestamp };
  const e = createValueAreaReclaimEngine({
    config: config(),
    initialCandles: rows,
  });
  for (let i = 0; i < 95; i++) e.next(bar(END + i * STEP));
  e.next(
    longBar(END + 95 * STEP, {
      open: 122.8,
      high: 122.9,
      low: 122,
      close: 122.5,
    }),
  );
  assert.ok(e.getState().pending);
  assert.equal(
    e.next(
      bar(END + DAY, { open: 123.2, low: 123.1, high: 123.4, close: 123.3 }),
    ).candidate,
    null,
  );
  assert.equal(e.getState().pending, null);
  const gap = engine();
  gap.next(longBar(END, { open: 122.8, high: 122.9, close: 122.8 }));
  assert.equal(gap.next(longBar(END + 2 * STEP)).candidate, null);
});
test("continuous execution equals preload and JSON checkpoint restoration", () => {
  const rows = [
    ...history(),
    longBar(END, { open: 122.8, high: 122.9, close: 122.8 }),
    longBar(END + STEP),
  ];
  const continuous = createValueAreaReclaimEngine({ config: config() });
  const outputs = rows.map((r) => continuous.next(r));
  const preloaded = createValueAreaReclaimEngine({
    config: config(),
    initialCandles: rows.slice(0, -1),
  });
  const restored = createValueAreaReclaimEngine({
    config: config(),
    checkpoint: JSON.parse(JSON.stringify(preloaded.getState())),
  });
  assert.deepEqual(preloaded.next(rows.at(-1)), outputs.at(-1));
  assert.deepEqual(restored.next(rows.at(-1)), outputs.at(-1));
  assert.deepEqual(restored.getState(), continuous.getState());
  assert.deepEqual(restored.next(rows.at(-1)), outputs.at(-1));
  assert.deepEqual(restored.getState(), continuous.getState());
  assert.throws(() => restored.next(rows.at(-2)), /Non-monotonic/);
  assert.throws(
    () =>
      createValueAreaReclaimEngine({
        config: config({ VAR_MIN_RR: 2 }),
        checkpoint: restored.getState(),
      }),
    /Incompatible/,
  );
});
test("history and ATR memory stay bounded after extended replay", () => {
  const e = engine();
  for (let i = 0; i < 96 * 20; i++) e.next(bar(END + i * STEP));
  const s = e.getState();
  assert.equal(s.candles.length, 3 * 96);
  assert.equal(s.trueRanges.length, 2);
  assert.ok(JSON.stringify(s).length < 60000);
});
