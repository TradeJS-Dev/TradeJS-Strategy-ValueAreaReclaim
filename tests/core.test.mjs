import assert from "node:assert/strict";
import test from "node:test";
import {
  harness,
  END,
  STEP,
  DAY,
  bar,
  longBar,
  shortBar,
  history,
} from "./helpers.mjs";

test("public StrategyAPI builds symmetric entries with figures, POC target and ATR stop", async () => {
  for (const [row, direction] of [
    [longBar(END), "LONG"],
    [shortBar(END), "SHORT"],
  ]) {
    const h = await harness();
    const decision = await h.next(row);
    assert.equal(decision.kind, "entry");
    assert.equal(decision.entryContext.direction, direction);
    assert.equal(decision.entryContext.timestamp, END);
    assert.equal(decision.entryContext.prices.currentPrice, row.close);
    assert.equal(decision.orderPlan.takeProfits[0].price, 124.5);
    assert.equal(decision.orderPlan.takeProfits[0].rate, 1);
    const stop = decision.orderPlan.stopLossPrice;
    assert.ok(direction === "LONG" ? stop < row.low : stop > row.high);
    assert.ok(
      Math.abs(Math.abs(row.close - stop) * decision.orderPlan.qty - 10) <
        1e-10,
    );
    const f = decision.signal.figures;
    assert.deepEqual(
      f.lines.map((l) => l.kind),
      ["var_VAH", "var_VAL", "var_POC", "var_entry", "var_stop", "var_target"],
    );
    assert.equal(f.zones[0].start.timestamp, END - 2 * DAY);
    assert.equal(f.zones[0].end.timestamp, END);
    assert.ok(
      f.annotations[0].items.some((s) =>
        s.includes(new Date(END).toISOString()),
      ),
    );
    assert.equal((await h.repeat()).code, "VAR_ALREADY_PROCESSED");
  }
});
test("minimum net RR rejects weak geometry and includes configured costs", async () => {
  const strict = await harness({ overrides: { VAR_MIN_RR: 100 } });
  assert.equal((await strict.next(longBar(END))).code, "VAR_MIN_RR");
  const costly = await harness({ overrides: { RISK_FEE_RATE: 0.02 } });
  assert.equal((await costly.next(longBar(END))).code, "VAR_MIN_RR");
  const wrongSide = await harness();
  assert.equal(
    (await wrongSide.next(longBar(END, { high: 124.9, close: 124.8 }))).code,
    "VAR_MIN_RR",
  );
});

test("position sizing includes entry and stop notionals on both sides", async () => {
  for (const row of [longBar(END), shortBar(END)]) {
    const h = await harness({
      overrides: { RISK_FEE_RATE: 0.0006, RISK_SLIPPAGE_BPS: 2 },
    });
    const decision = await h.next(row);
    assert.equal(decision.kind, "entry");
    const stop = decision.orderPlan.stopLossPrice;
    const expectedRisk =
      Math.abs(row.close - stop) + (row.close + stop) * 0.0008;
    assert.ok(Math.abs(decision.orderPlan.qty * expectedRisk - 10) < 1e-10);
  }
});
test("entry limit survives serialized core/controller checkpoint restore", async () => {
  const h = await harness();
  assert.equal((await h.next(longBar(END))).kind, "entry");
  await h.next(bar(END + STEP));
  const restoredStores = new Map(JSON.parse(JSON.stringify([...h.stores])));
  const restored = await harness({ initial: h.data, stores: restoredStores });
  const reference = await h.next(longBar(END + 2 * STEP));
  assert.equal(reference.code, "VAR_PROFILE_ENTRY_LIMIT");
  assert.deepEqual(await restored.next(longBar(END + 2 * STEP)), reference);
  assert.deepEqual(
    [...restored.stores.values()].map((s) => s.state),
    [...h.stores.values()].map((s) => s.state),
  );
});
test("cooldown applies to both directions with an inclusive boundary", async () => {
  const h = await harness({ overrides: { VAR_MAX_ENTRIES_PER_SIDE: 3 } });
  assert.equal((await h.next(longBar(END))).kind, "entry");
  await h.next(bar(END + STEP));
  assert.equal((await h.next(shortBar(END + 2 * STEP))).code, "VAR_COOLDOWN");
  await h.next(bar(END + 3 * STEP));
  assert.equal((await h.next(shortBar(END + 4 * STEP))).kind, "entry");
});
test("frozen position protection survives new profile; maximum holding exits through API", async () => {
  const h = await harness({ overrides: { VAR_MAX_HOLD_BARS: 100 } });
  const entry = await h.next(longBar(END));
  assert.equal(entry.kind, "entry");
  const position = {
    symbol: "BTCUSDT",
    direction: "LONG",
    qty: entry.orderPlan.qty,
    price: 123.2,
    slPrice: entry.orderPlan.stopLossPrice,
    tpPrice: 124.5,
  };
  h.position(position);
  for (let i = 1; i <= 100; i++) {
    const r = await h.next(bar(END + i * STEP));
    if (i < 100) assert.equal(r.code, "VAR_POSITION_EXISTS");
    else {
      assert.equal(r.kind, "exit");
      assert.equal(r.code, "VAR_MAX_HOLD");
      assert.equal(r.closePlan.timestamp, END + 100 * STEP);
      assert.equal(r.closePlan.price, 124.5);
    }
  }
  assert.equal(position.slPrice, entry.orderPlan.stopLossPrice);
  assert.equal(position.tpPrice, 124.5);
});
test("unknown position after cold restart is closed with an explicit reason", async () => {
  const h = await harness({
    position: { symbol: "BTCUSDT", direction: "SHORT", qty: 1, price: 125.8 },
  });
  const r = await h.next(bar(END));
  assert.equal(r.kind, "exit");
  assert.equal(r.code, "VAR_POSITION_WITHOUT_CHECKPOINT");
  assert.equal(r.closePlan.direction, "SHORT");
});

test("restored position checkpoint preserves the original holding deadline", async () => {
  const h = await harness({ overrides: { VAR_MAX_HOLD_BARS: 2 } });
  await h.next(longBar(END));
  const position = {
    symbol: "BTCUSDT",
    direction: "LONG",
    qty: 1,
    price: 123.2,
  };
  h.position(position);
  await h.next(bar(END + STEP));
  const restored = await harness({
    overrides: { VAR_MAX_HOLD_BARS: 2 },
    initial: h.data,
    position,
    stores: new Map(JSON.parse(JSON.stringify([...h.stores]))),
  });
  const expected = await h.next(bar(END + 2 * STEP));
  assert.equal(expected.code, "VAR_MAX_HOLD");
  assert.deepEqual(await restored.next(bar(END + 2 * STEP)), expected);
});
test("shared state isolates every effective config cell", async () => {
  const stores = new Map();
  const h = await harness({ stores });
  await h.next(longBar(END));
  const other = await harness({ stores, overrides: { VAR_MIN_RR: 1.1 } });
  assert.equal((await other.next(longBar(END))).kind, "entry");
  assert.equal(stores.size, 2);
});
test("causal preload ignores future rows in data passed to the core", async () => {
  const { createValueAreaReclaimCore } = await import("../dist/index.js");
  const h = await harness();
  const reference = await h.next(longBar(END));
  // API is the host boundary here; future data is deliberately outside its current candle context.
  const states = new Map();
  const candle = longBar(END);
  let params;
  const api = {
    createStateController(key, make) {
      if (!states.has(key)) states.set(key, make());
      return { get: () => states.get(key) };
    },
    getDecisionPriceContext: async () => ({
      candle,
      currentPrice: candle.close,
      timestamp: END,
    }),
    getCurrentPosition: async () => null,
    skip: (code) => ({ kind: "skip", code }),
    entry: async (p) => {
      params = p;
      return { kind: "entry" };
    },
  };
  const run = await createValueAreaReclaimCore({
    config: h.config,
    data: [...history(), candle, bar(END + STEP, { high: 1e8, volume: 1e12 })],
    strategyApi: api,
    indicatorsState: {},
  });
  assert.equal((await run(candle, candle)).kind, "entry");
  assert.deepEqual(params.orderPlan, reference.orderPlan);
  assert.deepEqual(params.figures, reference.signal.figures);
});
test("cold startup cannot trade on incomplete UTC days", async () => {
  const h = await harness({ initial: history().slice(10) });
  assert.equal(
    (await h.next(longBar(END))).code,
    "VAR_WAIT_COMPLETE_UTC_PROFILE",
  );
});
