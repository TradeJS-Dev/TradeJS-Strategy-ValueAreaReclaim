import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import plugin, {
  strategyEntries,
  defaultConfig,
  parseConfig,
} from "../dist/index.js";

test("ESM and CJS export the standalone plugin contract", () => {
  assert.equal(strategyEntries.length, 1);
  assert.equal(strategyEntries[0].manifest.name, "ValueAreaReclaim");
  assert.deepEqual(plugin.strategyEntries, strategyEntries);
  assert.deepEqual(strategyEntries[0].parseConfig({}), defaultConfig);
  const cjs = createRequire(import.meta.url)("../dist/index.cjs");
  assert.equal(cjs.strategyEntries[0].manifest.name, "ValueAreaReclaim");
});
test("strict config rejects unknown, malformed and unbounded parameters", () => {
  for (const value of [
    { VAR_PROFILE_DAY: 3 },
    { VAR_PROFILE_DAYS: 1 },
    { VAR_PROFILE_DAYS: 15 },
    { VAR_PROFILE_DAYS: 2.5 },
    { VAR_VALUE_FRACTION: 0 },
    { VAR_VALUE_FRACTION: 1.1 },
    { VAR_ATR_BUFFER: 0 },
    { VAR_ATR_PERIOD: 97 },
    { VAR_LONG: "true" },
    { VAR_MIN_RR: NaN },
    { MAX_LOSS_VALUE: -1 },
    { INTERVAL: "30" },
    { RISK_FEE_RATE: -0.1 },
    { RISK_SLIPPAGE_BPS: Infinity },
    { BACKTEST_ENTRY_DELAY_BARS: 1 },
    { BACKTEST_EXECUTION_DELAY_MS: 1 },
    { BACKTEST_PRICE_MODE: "open" },
  ]) {
    assert.throws(() => parseConfig(value), JSON.stringify(value));
  }
  assert.throws(() => parseConfig(null));
  assert.equal(parseConfig({ INTERVAL: "60" }).INTERVAL, "60");
  assert.equal(parseConfig({ VAR_VALUE_FRACTION: 1 }).VAR_VALUE_FRACTION, 1);
});

test("future cache-only backtest fixture is a single explicit reproducible config", () => {
  const grid = JSON.parse(
    fs.readFileSync("examples/backtest-grid.json", "utf8"),
  );
  assert.ok(
    Object.values(grid).every(
      (values) => Array.isArray(values) && values.length === 1,
    ),
  );
  const cfg = parseConfig(
    Object.fromEntries(
      Object.entries(grid).map(([key, values]) => [key, values[0]]),
    ),
  );
  assert.equal(cfg.VAR_LONG, true);
  assert.equal(cfg.VAR_SHORT, true);
  assert.equal(cfg.MAX_LOSS_VALUE, 10);
  const plan = JSON.parse(
    fs.readFileSync("examples/backtest-plan.json", "utf8"),
  );
  assert.equal(Date.parse(plan.start), plan.startTime);
  assert.equal(Date.parse(plan.endExclusive), plan.endTime);
  assert.equal(plan.endTime - plan.startTime, 30 * 86400000);
  assert.ok(plan.symbols.every((symbol) => symbol.endsWith("USDT")));
  assert.equal(plan.cacheOnly, true);
  assert.equal(plan.sourceInterval, cfg.INTERVAL);
  assert.equal(plan.executionCosts.fees.takerRate, cfg.RISK_FEE_RATE);
  assert.equal(plan.executionCosts.slippage.baseBps, cfg.RISK_SLIPPAGE_BPS);
});

test("1h backtest fixture changes execution interval while retaining the same 15m profile config", () => {
  const read = (file) =>
    JSON.parse(fs.readFileSync(`examples/${file}`, "utf8"));
  const grid = read("backtest-grid-1h.json");
  const base = read("backtest-grid.json");
  assert.deepEqual(grid, { ...base, INTERVAL: ["60"] });
  const cfg = parseConfig(
    Object.fromEntries(
      Object.entries(grid).map(([key, values]) => [key, values[0]]),
    ),
  );
  assert.equal(cfg.INTERVAL, "60");
  const plan = read("backtest-plan-1h.json");
  const basePlan = read("backtest-plan.json");
  assert.equal(plan.sourceInterval, "15");
  assert.equal(plan.executionInterval, "60");
  assert.equal(plan.grid, "backtest-grid-1h.json");
  assert.equal(plan.startTime, basePlan.startTime);
  assert.equal(plan.endTime, basePlan.endTime);
  assert.deepEqual(plan.symbols, basePlan.symbols);
  assert.deepEqual(plan.executionCosts, basePlan.executionCosts);
  assert.equal(plan.cacheOnly, true);
});
