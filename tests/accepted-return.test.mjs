import assert from "node:assert/strict";
import test from "node:test";
import {
  createValueAreaReclaimEngine,
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
const outside = (t, side = "LONG") =>
  side === "LONG"
    ? longBar(t, { open: 122.8, low: 122.6, high: 124, close: 122.8 })
    : shortBar(t, { open: 126.2, low: 125, high: 126.4, close: 126.2 });
const accept = (extra = {}) =>
  createValueAreaReclaimEngine({
    config: config({ VAR_ENTRY_MODE: "accepted-return", ...extra }),
    initialCandles: history(),
  });
const rows = (e, n = 4, step = STEP) => {
  for (let i = 0; i < n; i++) e.next(bar(END + i * step));
};
const state = (h) => [...h.stores.values()][0].state;
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

test("accepted return requires four preceding closes under current profile, on both sides", () => {
  for (const side of ["LONG", "SHORT"]) {
    const e = accept();
    rows(e);
    const before = e.getState();
    assert.equal(before.acceptedCloses.length, 4);
    assert.equal(
      e.next(outside(END + 4 * STEP, side)).code,
      "VAR_WAIT_RECLAIM",
    );
    const result = e.next(
      (side === "LONG" ? longBar : shortBar)(END + 5 * STEP),
    );
    assert.equal(result.candidate.direction, side);
    assert.deepEqual(
      result.candidate.acceptedReturn.priorCloses,
      before.acceptedCloses,
    );
    assert.equal(result.candidate.acceptedReturn.profileEnd, END);
    assert.equal(result.candidate.excursionStart, END + 4 * STEP);
    assert.equal(
      result.candidate.acceptedReturn.returnTimestamp,
      END + 5 * STEP,
    );
    assert.equal(result.candidate.engulfReturn, undefined);
    assert.equal(e.getState().acceptedCloses.length, 1);
  }
  const e = accept();
  rows(e, 3);
  assert.equal(
    e.next(outside(END + 3 * STEP)).code,
    "VAR_WAIT_VALUE_ACCEPTANCE",
  );
  assert.equal(e.getState().pending, null);
});
test("accepted close tail saturates at four, same-bar duplicates cannot advance it", () => {
  const e = accept();
  rows(e, 10);
  assert.equal(e.getState().acceptedCloses.length, 4);
  assert.deepEqual(
    e.getState().acceptedCloses.map((c) => c.timestamp),
    [6, 7, 8, 9].map((i) => END + i * STEP),
  );
  const a = e.getState();
  e.next(bar(END + 9 * STEP));
  assert.deepEqual(e.getState(), a);
});
test("accepted pending and prior causal timestamps survive JSON restoration and preload parity", () => {
  const cfg = config({ VAR_ENTRY_MODE: "accepted-return" }),
    prefix = [
      ...history(),
      ...Array.from({ length: 4 }, (_, i) => bar(END + i * STEP)),
      outside(END + 4 * STEP),
    ];
  const a = createValueAreaReclaimEngine({
      config: cfg,
      initialCandles: prefix,
    }),
    b = createValueAreaReclaimEngine({
      config: cfg,
      checkpoint: JSON.parse(JSON.stringify(a.getState())),
    }),
    c = createValueAreaReclaimEngine({ config: cfg });
  prefix.forEach((r) => c.next(r));
  const row = longBar(END + 5 * STEP),
    r = a.next(row);
  assert.ok(r.candidate);
  assert.deepEqual(b.next(row), r);
  assert.deepEqual(c.next(row), r);
  assert.deepEqual(b.getState(), a.getState());
  const closes = r.candidate.acceptedReturn.priorCloses;
  assert.ok(
    closes.every(
      (x, i) =>
        x.timestamp === END + i * STEP &&
        x.timestamp < r.candidate.excursionStart &&
        x.close > r.candidate.profile.val &&
        x.close < r.candidate.profile.vah,
    ),
  );
});
test("accepted wick-only never starts pending; equal/outside/ambiguous/gap/day clear acceptance", () => {
  const wick = accept();
  rows(wick);
  assert.equal(wick.next(longBar(END + 4 * STEP)).candidate, null);
  assert.equal(wick.getState().pending, null);
  for (const kind of ["equal", "outside", "ambiguous", "gap", "day"]) {
    const e = accept();
    rows(e);
    const p = e.getState().profile;
    const row =
      kind === "equal"
        ? bar(END + 4 * STEP, {
            open: p.val,
            close: p.val,
            low: p.val,
            high: p.val + 0.1,
          })
        : kind === "outside"
          ? outside(END + 4 * STEP)
          : kind === "ambiguous"
            ? bar(END + 4 * STEP, { low: p.val - 1, high: p.vah + 1 })
            : kind === "gap"
              ? outside(END + 5 * STEP)
              : outside(END + DAY);
    e.next(row);
    assert.equal(e.getState().acceptedCloses.length, 0);
    if (kind !== "outside") assert.equal(e.getState().pending, null);
  }
  const missing = createValueAreaReclaimEngine({
    config: config({ VAR_ENTRY_MODE: "accepted-return" }),
    initialCandles: history().slice(1),
  });
  rows(missing);
  assert.equal(missing.getState().acceptedCloses.length, 0);
});
test("accepted pending keeps original deadline and cancels opposite boundary", () => {
  const e = accept({ VAR_RECLAIM_BARS: 1 });
  rows(e);
  e.next(outside(END + 4 * STEP));
  e.next(outside(END + 5 * STEP));
  assert.equal(e.next(longBar(END + 6 * STEP)).code, "VAR_RECLAIM_EXPIRED");
  const cross = accept();
  rows(cross);
  cross.next(outside(END + 4 * STEP));
  assert.equal(
    cross.next(bar(END + 5 * STEP, { high: 126.2 })).code,
    "VAR_CROSSED_OPPOSITE_BOUNDARY",
  );
});
test("H1 accepted return counts four execution bars but uses original15m profile", async () => {
  const source = history(END, 3),
    h = await harness({
      overrides: {
        INTERVAL: "60",
        VAR_PROFILE_DAYS: 3,
        VAR_ENTRY_MODE: "accepted-return",
        VAR_MIN_RR: 0.01,
      },
      initial: hourly(source),
      source,
    });
  for (let i = 0; i < 4; i++) await h.next(bar(END + i * 4 * STEP));
  await h.next(outside(END + 16 * STEP));
  const d = await h.next(longBar(END + 20 * STEP));
  assert.equal(d.kind, "entry");
  const info = d.signal.indicators.valueAreaReclaim;
  assert.deepEqual(info.profile, buildValueAreaProfile(source, END, 3, 0.9));
  assert.deepEqual(
    info.acceptedReturn.priorCloses.map((c) => c.timestamp),
    [0, 4, 8, 12].map((i) => END + i * STEP),
  );
  assert.equal(h.reads.length, 1);
});
test("core keeps acceptance during an owned position and includes effective metadata/figures", async () => {
  const h = await harness({
    overrides: {
      VAR_ENTRY_MODE: "accepted-return",
      VAR_MIN_RR: 0.01,
      VAR_COOLDOWN_BARS: 0,
      VAR_MAX_ENTRIES_PER_SIDE: 3,
    },
  });
  for (let i = 0; i < 4; i++) await h.next(bar(END + i * STEP));
  await h.next(outside(END + 4 * STEP));
  const d = await h.next(longBar(END + 5 * STEP));
  assert.equal(d.kind, "entry");
  assert.equal(
    d.signal.indicators.valueAreaReclaim.entryMode,
    "accepted-return",
  );
  assert.equal(
    d.signal.indicators.valueAreaReclaim.acceptedReturn.priorCloses.length,
    4,
  );
  assert.equal(
    d.signal.figures.points.find((x) => x.kind === "var_accepted_closes").points
      .length,
    4,
  );
  h.position({ symbol: "BTCUSDT", direction: "LONG", qty: 1, price: 123.2 });
  for (let i = 6; i < 10; i++) await h.next(bar(END + i * STEP));
  assert.equal(state(h).engine.acceptedCloses.length, 4);
});
test("a host missing the optional source capability fails closed on H1", async () => {
  const h = await harness({
    overrides: { INTERVAL: "60" },
    initial: hourly(history()),
    sourceCapability: false,
  });
  assert.equal(
    (await h.next(longBar(END))).code,
    "VAR_15M_HISTORY_UNAVAILABLE",
  );
  assert.equal(state(h).engine.profile, null);
  assert.equal(h.reads.length, 0);
});
