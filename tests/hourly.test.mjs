import assert from "node:assert/strict";
import test from "node:test";
import {
  createValueAreaReclaimEngine,
  buildValueAreaProfile,
} from "../dist/index.js";
import {
  harness,
  history,
  config,
  END,
  STEP,
  DAY,
  bar,
  longBar,
  shortBar,
} from "./helpers.mjs";

const HOUR = STEP * 4;
function hourly(rows = history()) {
  const result = [];
  for (let i = 0; i < rows.length; i += 4) {
    const group = rows.slice(i, i + 4);
    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      close: group.at(-1).close,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return result;
}
const opts = (extra = {}) => ({
  overrides: { INTERVAL: "60" },
  initial: hourly(),
  ...extra,
});
const state = (h) => [...h.stores.values()][0].state;

test("1h entries on both sides use exactly the same 15m profile as 15m execution", async () => {
  for (const row of [longBar(END), shortBar(END)]) {
    const fifteen = await harness();
    const hour = await harness(opts());
    const a = await fifteen.next(row);
    const b = await hour.next(row);
    assert.equal(b.kind, "entry");
    assert.equal(b.entryContext.interval, "60");
    assert.deepEqual(
      b.signal.indicators.valueAreaReclaim.profile,
      a.signal.indicators.valueAreaReclaim.profile,
    );
    assert.equal(b.orderPlan.takeProfits[0].price, 124.5);
    assert.equal(hour.reads.length, 1);
    assert.deepEqual(hour.reads[0], {
      symbol: "BTCUSDT",
      interval: "15",
      start: END - 2 * DAY,
      end: END - 1,
      cacheOnly: true,
      silent: true,
    });
    assert.equal(state(hour).engine.candles.length, 0);
  }
});

test("concurrent repeats of one hourly bar read and enter only once", async () => {
  const h = await harness(opts());
  const [first, second] = await Promise.all([h.next(longBar(END)), h.repeat()]);
  assert.equal(first.kind, "entry");
  assert.equal(second.code, "VAR_ALREADY_PROCESSED");
  assert.equal(h.reads.length, 1);
});

test("runtime-injected execution fields do not bypass strict strategy config or block 1h", async () => {
  const h = await harness(
    opts({
      runtimeConfig: {
        ENV: "BACKTEST",
        MAKE_ORDERS: true,
        CLOSE_OPPOSITE_POSITIONS: false,
        JEV: { enabled: false },
        BACKTEST_PRICE_MODE: "close",
        BACKTEST_ENTRY_DELAY_BARS: 0,
      },
    }),
  );
  assert.equal((await h.next(longBar(END))).kind, "entry");
  await assert.rejects(
    () => harness(opts({ runtimeConfig: { VAR_PROFILE_DAY: 3 } })),
    /not allowed/,
  );
  await assert.rejects(
    () => harness(opts({ runtimeConfig: { BACKTEST_PRICE_MODE: "open" } })),
    /close decision prices/,
  );
});
test("aggregating source data to hours would change the profile; actual 1h engine never does so", async () => {
  const wrong = hourly().flatMap((c) =>
    Array.from({ length: 4 }, (_, i) => ({
      ...c,
      timestamp: c.timestamp + i * STEP,
      volume: c.volume / 4,
    })),
  );
  const h = await harness(opts());
  const decision = await h.next(longBar(END));
  const correct = decision.signal.indicators.valueAreaReclaim.profile;
  assert.notDeepEqual(
    buildValueAreaProfile(wrong, END, 2, 0.9).bins,
    correct.bins,
  );
  assert.deepEqual(correct, buildValueAreaProfile(history(), END, 2, 0.9));
});
test("1h source access is causal in BACKTEST, PARITY and CRON", async () => {
  const outputs = [];
  for (const env of ["BACKTEST", "PARITY", "CRON"]) {
    const h = await harness(
      opts({
        env,
        source: [
          ...history(),
          bar(END, { high: 1e8, volume: 1e12 }),
          bar(END + DAY, { high: 1e9, volume: 1e13 }),
        ],
      }),
    );
    const r = await h.next(longBar(END));
    assert.equal(r.kind, "entry");
    assert.equal(r.signal.indicators.valueAreaReclaim.profile.high, 148);
    assert.equal(h.reads[0].cacheOnly, env !== "CRON");
    outputs.push(r.orderPlan);
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[1], outputs[2]);
});
test("1h reads once per UTC day and preserves frozen profile within the day", async () => {
  const source = history();
  const h = await harness(opts({ source }));
  await h.next(bar(END));
  const original = structuredClone(state(h).engine.profile);
  source[0].volume = 1e8;
  for (let i = 1; i < 24; i++) await h.next(bar(END + i * HOUR));
  assert.deepEqual(state(h).engine.profile, original);
  assert.equal(h.reads.length, 1);
  await h.next(bar(END + DAY));
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].start, END - DAY);
  assert.equal(h.reads[1].end, END + DAY - 1);
});
test("1h incomplete history blocks entries for the day and does not substitute hourly candles", async () => {
  const source = history().slice(1);
  const h = await harness(opts({ source }));
  assert.equal((await h.next(longBar(END))).code, "VAR_15M_HISTORY_INCOMPLETE");
  source.unshift(history()[0]);
  assert.equal(
    (await h.next(longBar(END + HOUR))).code,
    "VAR_15M_HISTORY_INCOMPLETE",
  );
  assert.equal(h.reads.length, 1);
  assert.equal(state(h).engine.profile, null);
});
test("provider failure blocks entries but cannot suppress holding deadline exits", async () => {
  let failure = null;
  const h = await harness(
    opts({
      overrides: { INTERVAL: "60", VAR_MAX_HOLD_BARS: 24 },
      sourceError: () => failure,
    }),
  );
  const entry = await h.next(longBar(END));
  assert.equal(entry.kind, "entry");
  h.position({
    symbol: "BTCUSDT",
    direction: "LONG",
    qty: 1,
    price: 123.2,
    slPrice: entry.orderPlan.stopLossPrice,
    tpPrice: 124.5,
  });
  for (let i = 1; i < 24; i++)
    assert.equal(
      (await h.next(bar(END + i * HOUR))).code,
      "VAR_POSITION_EXISTS",
    );
  failure = new Error("cache offline");
  const exit = await h.next(bar(END + DAY));
  assert.equal(exit.code, "VAR_MAX_HOLD");
  assert.equal(exit.kind, "exit");
  assert.equal(state(h).profileReadCode, "VAR_15M_HISTORY_UNAVAILABLE");
  const cold = await harness(opts({ sourceError: failure }));
  assert.equal(
    (await cold.next(longBar(END))).code,
    "VAR_15M_HISTORY_UNAVAILABLE",
  );
});
test("1h pending reclaim and frozen profile survive JSON restoration without source reread", async () => {
  const h = await harness(opts());
  assert.equal(
    (await h.next(longBar(END, { open: 122.8, high: 122.9, close: 122.8 })))
      .code,
    "VAR_WAIT_RECLAIM",
  );
  const restored = await harness(
    opts({
      initial: h.data,
      stores: new Map(JSON.parse(JSON.stringify([...h.stores]))),
      sourceError: new Error("restored profile should not be reloaded"),
    }),
  );
  const expected = await h.next(longBar(END + HOUR));
  assert.equal(expected.kind, "entry");
  assert.deepEqual(await restored.next(longBar(END + HOUR)), expected);
  assert.equal(restored.reads.length, 0);
  assert.deepEqual(state(restored), state(h));
  assert.equal((await restored.repeat()).code, "VAR_ALREADY_PROCESSED");
});
test("hourly reclaim timeout and holding/cooldown counts use hours", async () => {
  const h = await harness(
    opts({
      overrides: {
        INTERVAL: "60",
        VAR_RECLAIM_BARS: 2,
        VAR_MIN_RR: 0.1,
        VAR_MAX_HOLD_BARS: 2,
        VAR_MAX_ENTRIES_PER_SIDE: 3,
      },
    }),
  );
  const outside = (timestamp) =>
    longBar(timestamp, { open: 122.8, high: 122.9, close: 122.8 });
  await h.next(outside(END));
  await h.next(outside(END + HOUR));
  assert.equal((await h.next(longBar(END + 2 * HOUR))).kind, "entry");
  await h.next(bar(END + 3 * HOUR));
  assert.equal((await h.next(shortBar(END + 4 * HOUR))).code, "VAR_COOLDOWN");
  await h.next(bar(END + 5 * HOUR));
  const entry = await h.next(shortBar(END + 6 * HOUR));
  assert.equal(entry.kind, "entry");
  h.position({ symbol: "BTCUSDT", direction: "SHORT", qty: 1, price: 125.8 });
  assert.equal((await h.next(bar(END + 7 * HOUR))).code, "VAR_POSITION_EXISTS");
  assert.equal((await h.next(bar(END + 8 * HOUR))).code, "VAR_MAX_HOLD");
});
test("pure 1h engine replays and restores with an explicit frozen 15m profile", () => {
  const cfg = config({ INTERVAL: "60" });
  const profile = buildValueAreaProfile(
    history(),
    END,
    2,
    cfg.VAR_VALUE_FRACTION,
  );
  let profileReads = 0;
  const profileForDay = (day) => {
    profileReads++;
    return day === END ? profile : null;
  };
  const prefix = [
    ...hourly(),
    longBar(END, { open: 122.8, high: 122.9, close: 122.8 }),
  ];
  const next = longBar(END + HOUR);
  const a = createValueAreaReclaimEngine({ config: cfg, profileForDay });
  prefix.forEach((c) => a.next(c));
  assert.equal(profileReads, 3);
  const b = createValueAreaReclaimEngine({
    config: cfg,
    profileForDay,
    initialCandles: prefix,
  });
  const c = createValueAreaReclaimEngine({
    config: cfg,
    checkpoint: JSON.parse(JSON.stringify(b.getState())),
  });
  const expected = a.next(next);
  assert.ok(expected.candidate);
  assert.deepEqual(b.next(next), expected);
  assert.deepEqual(c.next(next), expected);
  assert.deepEqual(c.getState(), a.getState());
  assert.equal(c.getState().candles.length, 0);
  const missing = createValueAreaReclaimEngine({ config: cfg });
  const before = missing.getState();
  assert.throws(() => missing.next(bar(END)), /explicit closed 15m profile/);
  assert.deepEqual(missing.getState(), before);
  assert.throws(
    () =>
      createValueAreaReclaimEngine({
        config: cfg,
        profileForDay: () => profile,
      }).next(bar(END + DAY)),
    /UTC day/,
  );
});

test("1h engine freezes an owned profile copy and rejects misaligned execution before mutation", () => {
  const cfg = config({ INTERVAL: "60" });
  const profile = buildValueAreaProfile(history(), END, 2, 0.9);
  const e = createValueAreaReclaimEngine({
    config: cfg,
    profileForDay: () => profile,
  });
  e.next(bar(END));
  const frozen = structuredClone(e.getState().profile);
  profile.bins[0] = 1e9;
  profile.poc = 1e9;
  assert.deepEqual(e.getState().profile, frozen);
  const before = e.getState();
  assert.throws(() => e.next(bar(END + STEP)), /Misaligned/);
  assert.deepEqual(e.getState(), before);
});
