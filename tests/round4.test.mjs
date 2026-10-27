import assert from "node:assert/strict";
import test from "node:test";
import {
  createValueAreaReclaimEngine,
  cutlerRsi14,
  buildPreviousDayRange,
  buildValueAreaProfile,
  parseConfig,
} from "../dist/index.js";
import {
  config,
  history,
  harness,
  END,
  STEP,
  DAY,
  bar,
  longBar,
  shortBar,
} from "./helpers.mjs";
const state = (h) => [...h.stores.values()][0].state;
const outside = (t, side = "LONG", deep = false) =>
  side === "LONG"
    ? bar(t, {
        open: 123,
        close: deep ? 122.9 : 122.8,
        low: deep ? 122.3 : 122.5,
        high: 124,
      })
    : bar(t, {
        open: 126,
        close: deep ? 126.1 : 126.2,
        low: 125,
        high: deep ? 126.7 : 126.5,
      });
const back = (t, side) => (side === "LONG" ? longBar(t) : shortBar(t));
const make = (extra = {}) =>
  createValueAreaReclaimEngine({
    config: config({ VAR_ENTRY_MODE: "rsi-double-trap", ...extra }),
    initialCandles: history(),
  });
function first(e, side = "LONG") {
  e.next(bar(END));
  e.next(outside(END + STEP, side));
  return e.next(back(END + 2 * STEP, side));
}
export function rangedSource(end = END) {
  return history(end, 3).map((c) =>
    c.timestamp >= end - DAY
      ? {
          ...c,
          low: 123.1,
          high: 125.9,
          volume: c.timestamp === end - DAY ? 10 : 0,
        }
      : c,
  );
}
const hourly = (data) =>
  Array.from({ length: data.length / 4 }, (_, i) => {
    const g = data.slice(i * 4, i * 4 + 4);
    return {
      ...g[0],
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g.at(-1).close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    };
  });
test("round4 parser permits only current behaviors and false compatibility flags", () => {
  for (const mode of [
    "legacy",
    "accepted-return",
    "rsi-double-trap",
    "prior-day-trap",
  ])
    assert.equal(parseConfig({ VAR_ENTRY_MODE: mode }).VAR_ENTRY_MODE, mode);
  assert.throws(
    () => parseConfig({ VAR_ENTRY_MODE: "engulf-return" }),
    /Invalid/,
  );
  for (const k of [
    "VAR_REQUIRE_VALUE_MIGRATION",
    "VAR_REQUIRE_VALUE_MIGRATION_LONG",
    "VAR_REQUIRE_VALUE_MIGRATION_SHORT",
    "VAR_REQUIRE_BALANCED_VALUE",
    "VAR_EXIT_ON_VALUE_LOSS",
    "VAR_PROTECT_PROGRESS",
  ])
    assert.throws(() => parseConfig({ [k]: true }), /unavailable/);
});
test("Cutler RSI14 known gain/loss/flat/mixed and bounded rolling changes", () => {
  assert.equal(cutlerRsi14(Array(14).fill(1)), 100);
  assert.equal(cutlerRsi14(Array(14).fill(-1)), 0);
  assert.equal(cutlerRsi14(Array(14).fill(0)), 50);
  assert.equal(cutlerRsi14([...Array(7).fill(3), ...Array(7).fill(-1)]), 75);
  assert.equal(cutlerRsi14(Array(13).fill(1)), null);
  const e = make();
  for (let i = 0; i < 22; i++)
    e.next(
      bar(END + i * STEP, {
        open: 124.5,
        close: 124.5 + i * 0.01,
        low: 124.4,
        high: 125,
      }),
    );
  assert.equal(e.getState().rsiChanges.length, 14);
  assert.equal(cutlerRsi14(e.getState().rsiChanges), 100);
});
test("two failed excursions require strict price and RSI divergence on both sides; first cannot enter", () => {
  for (const side of ["LONG", "SHORT"]) {
    const e = make();
    assert.equal(first(e, side).candidate, null);
    assert.ok(e.getState().completedExcursions[side]);
    e.next(bar(END + 3 * STEP));
    e.next(outside(END + 4 * STEP, side, true));
    const r = e.next(back(END + 5 * STEP, side));
    assert.equal(r.candidate.direction, side);
    const p = r.candidate.rsiDoubleTrap;
    assert.equal(p.prior.outsideBar.timestamp, END + STEP);
    assert.equal(p.current.outsideBar.timestamp, END + 4 * STEP);
    assert.equal(p.current.extremeTimestamp, END + 4 * STEP);
    assert.ok(
      side === "LONG"
        ? p.current.extremeRsi > p.prior.extremeRsi
        : p.current.extremeRsi < p.prior.extremeRsi,
    );
  }
});
test("equal extreme retains earliest closed RSI and return-bar strict extreme updates it", () => {
  const e = make();
  e.next(bar(END));
  e.next(outside(END + STEP));
  const before = e.getState().pending;
  e.next(outside(END + 2 * STEP, "LONG", false));
  assert.equal(e.getState().pending.extremeTimestamp, before.extremeTimestamp);
  assert.equal(e.getState().pending.extremeRsi, before.extremeRsi);
  e.next(longBar(END + 3 * STEP, { low: 122.4 }));
  assert.equal(
    e.getState().completedExcursions.LONG.extremeTimestamp,
    END + 3 * STEP,
  );
});
test("equal-price comparison rejects but still replaces latest valid completed record", () => {
  const e = make();
  first(e);
  e.next(bar(END + 3 * STEP));
  e.next(outside(END + 4 * STEP));
  assert.equal(
    e.next(longBar(END + 5 * STEP)).code,
    "VAR_RSI_DIVERGENCE_REJECTED",
  );
  assert.equal(
    e.getState().completedExcursions.LONG.returnTimestamp,
    END + 5 * STEP,
  );
});
test("pair age32 inclusive,33 rejects; valid completion always replaces prior", () => {
  for (const age of [32, 33]) {
    const e = make();
    first(e);
    for (let i = 3; i < 2 + age; i++)
      e.next(
        bar(END + i * STEP, i === 1 + age ? { close: 124.6, high: 124.7 } : {}),
      );
    e.next(outside(END + (2 + age) * STEP, "LONG", true));
    const r = e.next(longBar(END + (3 + age) * STEP));
    assert.equal(Boolean(r.candidate), age === 32);
    assert.equal(
      e.getState().completedExcursions.LONG.returnTimestamp,
      END + (3 + age) * STEP,
    );
  }
});
test("RSI gap resets14 changes; unavailable extreme cannot store a completion; day clears records", () => {
  const e = make();
  first(e);
  e.next(bar(END + 4 * STEP));
  assert.deepEqual(e.getState().rsiChanges, []);
  assert.equal(e.getState().completedExcursions.LONG, null);
  e.next(outside(END + 5 * STEP));
  assert.equal(e.next(longBar(END + 6 * STEP)).code, "VAR_WAIT_RSI");
  assert.equal(e.getState().completedExcursions.LONG, null);
  for (let i = 7; i <= 20; i++) e.next(bar(END + i * STEP));
  assert.equal(e.getState().rsiChanges.length, 14);
  e.next(outside(END + 21 * STEP));
  e.next(longBar(END + 22 * STEP));
  assert.ok(e.getState().completedExcursions.LONG);
  e.next(bar(END + DAY));
  assert.equal(e.getState().completedExcursions.LONG, null);
});
test("RSI pending and2 bounded records restore exactly; duplicate does not advance", () => {
  const a = make();
  first(a);
  a.next(bar(END + 3 * STEP));
  const row = outside(END + 4 * STEP, "LONG", true);
  a.next(row);
  const st = a.getState();
  a.next(row);
  assert.deepEqual(a.getState(), st);
  const b = createValueAreaReclaimEngine({
    config: config({ VAR_ENTRY_MODE: "rsi-double-trap" }),
    checkpoint: JSON.parse(JSON.stringify(st)),
  });
  assert.deepEqual(
    b.next(longBar(END + 5 * STEP)),
    a.next(longBar(END + 5 * STEP)),
  );
  assert.deepEqual(a.getState(), b.getState());
});
test("owned position preserves RSI pending and valid completions for later comparison", async () => {
  const h = await harness({
    overrides: {
      VAR_ENTRY_MODE: "rsi-double-trap",
      VAR_MIN_RR: 0.01,
      VAR_COOLDOWN_BARS: 0,
    },
  });
  await h.next(bar(END));
  h.position({ direction: "LONG", symbol: "BTCUSDT", qty: 1, price: 124.5 });
  state(h).holding = { direction: "LONG", since: END };
  await h.next(outside(END + STEP));
  assert.ok(state(h).engine.pending);
  await h.next(longBar(END + 2 * STEP));
  assert.ok(state(h).engine.completedExcursions.LONG);
  await h.next(bar(END + 3 * STEP));
  await h.next(outside(END + 4 * STEP, "LONG", true));
  h.position(null);
  const r = await h.next(longBar(END + 5 * STEP));
  assert.equal(r.kind, "entry");
  assert.equal(
    r.signal.indicators.valueAreaReclaim.rsiDoubleTrap.current.extremeTimestamp,
    END + 4 * STEP,
  );
  assert.ok(
    r.signal.figures.points.some((p) => p.kind === "var_rsi_extreme_0"),
  );
});
test("prior-day range requires96 unique contiguous positive-volume rows and excludes current day", () => {
  const src = rangedSource(),
    p = buildPreviousDayRange(src, END);
  assert.deepEqual(p, {
    start: END - DAY,
    end: END,
    low: 123.1,
    high: 125.9,
    volume: 10,
  });
  assert.deepEqual(
    buildPreviousDayRange([...src, bar(END, { high: 1e9, volume: 1e12 })], END),
    p,
  );
  assert.equal(
    buildPreviousDayRange(
      src.filter((c) => c.timestamp !== END - STEP),
      END,
    ),
    null,
  );
  assert.equal(buildPreviousDayRange([...src, src.at(-1)], END), null);
  assert.equal(
    buildPreviousDayRange(
      src.map((c) => ({ ...c, volume: 0 })),
      END,
    ),
    null,
  );
  assert.equal(
    buildPreviousDayRange(
      src.map((c) => ({
        ...c,
        open: 124.5,
        close: 124.5,
        low: 124.5,
        high: 124.5,
      })),
      END,
    ),
    null,
  );
});
const trap = (
  range = { start: END - DAY, end: END, low: 123.1, high: 125.9, volume: 10 },
) =>
  createValueAreaReclaimEngine({
    config: config({ INTERVAL: "60", VAR_ENTRY_MODE: "prior-day-trap" }),
    profileForDay: (day) => buildValueAreaProfile(history(day), day, 2, 0.9),
    previousDayRangeForDay: (day) =>
      range ? { ...range, start: day - DAY, end: day } : null,
    initialCandles: hourly(history()),
  });
test("H1 dual-range LONG/SHORT requires outside close then first strict dual return; restore exact", () => {
  for (const side of ["LONG", "SHORT"]) {
    const a = trap();
    a.next(bar(END));
    a.next(outside(END + 4 * STEP, side));
    const b = createValueAreaReclaimEngine({
      config: config({ INTERVAL: "60", VAR_ENTRY_MODE: "prior-day-trap" }),
      checkpoint: JSON.parse(JSON.stringify(a.getState())),
    });
    const row = back(END + 8 * STEP, side),
      r = a.next(row);
    assert.equal(r.candidate.direction, side);
    assert.deepEqual(b.next(row), r);
    assert.equal(r.candidate.priorDayTrap.previousClose.timestamp, END);
    assert.equal(r.candidate.priorDayTrap.outsideBar.timestamp, END + 4 * STEP);
    assert.equal(r.candidate.priorDayTrap.returnTimestamp, END + 8 * STEP);
  }
});
test("dual-range wick/equality/missing context cannot start; first main return outside day range cancels", () => {
  const wick = trap();
  assert.equal(wick.next(longBar(END)).candidate, null);
  assert.equal(wick.getState().pending, null);
  const missing = trap(null);
  missing.next(bar(END));
  missing.next(outside(END + 4 * STEP));
  assert.equal(missing.getState().pending, null);
  const narrow = trap({
    start: END - DAY,
    end: END,
    low: 123.3,
    high: 125.7,
    volume: 1,
  });
  narrow.next(bar(END));
  narrow.next(outside(END + 4 * STEP));
  assert.equal(
    narrow.next(longBar(END + 8 * STEP)).code,
    "VAR_DAY_RANGE_RETURN_REJECTED",
  );
  assert.equal(narrow.getState().pending, null);
  assert.equal(narrow.next(bar(END + 12 * STEP)).candidate, null);
  const equal = trap();
  equal.next(bar(END));
  equal.next(
    bar(END + 4 * STEP, { open: 123.1, close: 123.1, low: 122.8, high: 123.2 }),
  );
  assert.equal(equal.getState().pending, null);
});
test("dual pending cancels both-range ambiguity/opposite/day/gap/deadline", () => {
  for (const what of ["opposite", "ambiguous", "gap", "day", "expiry"]) {
    const e = trap();
    e.next(bar(END));
    e.next(outside(END + 4 * STEP));
    let row =
      what === "opposite"
        ? longBar(END + 8 * STEP, { high: 126 })
        : what === "ambiguous"
          ? bar(END + 8 * STEP, { low: 123, high: 126 })
          : what === "gap"
            ? longBar(END + 12 * STEP)
            : what === "day"
              ? longBar(END + DAY)
              : outside(END + 8 * STEP);
    if (what === "expiry") {
      for (let i = 2; i <= 5; i++) e.next(outside(END + i * 4 * STEP));
      row = longBar(END + 24 * STEP);
    }
    e.next(row);
    assert.equal(e.getState().pending, null);
  }
});
test("H1 core uses one exact15m read for profile/dayrange and refreshes both at UTC transition", async () => {
  const src = [
    ...rangedSource(),
    ...rangedSource(END + DAY).filter((c) => c.timestamp >= END),
  ];
  const h = await harness({
    overrides: {
      INTERVAL: "60",
      VAR_PROFILE_DAYS: 3,
      VAR_ENTRY_MODE: "prior-day-trap",
      VAR_MIN_RR: 0.01,
    },
    initial: hourly(src.filter((c) => c.timestamp < END)),
    source: [...src, bar(END + DAY, { high: 1e9, volume: 1e12 })],
  });
  await h.next(bar(END));
  assert.deepEqual(
    state(h).engine.previousDayRange,
    buildPreviousDayRange(src, END),
  );
  await h.next(outside(END + 4 * STEP));
  const r = await h.next(longBar(END + 8 * STEP));
  assert.equal(r.kind, "entry");
  assert.deepEqual(
    r.signal.indicators.valueAreaReclaim.profile,
    buildValueAreaProfile(src, END, 3, 0.9),
  );
  assert.equal(h.reads.length, 1);
  for (let i = 3; i <= 24; i++) await h.next(bar(END + i * 4 * STEP));
  assert.equal(h.reads.length, 2);
  assert.deepEqual(
    state(h).engine.previousDayRange,
    buildPreviousDayRange(src, END + DAY),
  );
  assert.equal(state(h).engine.candles.length, 0);
});
