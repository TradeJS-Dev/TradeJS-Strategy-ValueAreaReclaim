import { createStrategyAPI } from "@tradejs/core/strategies";

import {
  createValueAreaReclaimCore,
  parseConfig,
  SOURCE_INTERVAL_MS as STEP,
  UTC_DAY_MS as DAY,
} from "../dist/index.js";

export { STEP, DAY };
export const END = Date.UTC(2026, 9, 20);
export const config = (overrides = {}) =>
  parseConfig({
    VAR_PROFILE_DAYS: 2,
    VAR_VALUE_FRACTION: 0.9,
    VAR_ATR_PERIOD: 2,
    VAR_ATR_BUFFER: 0.1,
    VAR_MIN_RR: 1,
    VAR_COOLDOWN_BARS: 2,
    RISK_FEE_RATE: 0,
    RISK_SLIPPAGE_BPS: 0,
    ...overrides,
  });
export const bar = (timestamp, values = {}) => ({
  timestamp,
  open: 124.5,
  high: 124.6,
  low: 124.4,
  close: 124.5,
  volume: 0,
  ...values,
});
export function history(end = END, days = 2) {
  const rows = Array.from({ length: days * 96 }, (_, i) =>
    bar(end - days * DAY + i * STEP, { high: 124.5, low: 124.5 }),
  );
  Object.assign(rows[0], { low: 100, high: 148 });
  Object.assign(rows[1], { volume: 60 });
  Object.assign(rows[2], {
    open: 123.5,
    high: 123.5,
    low: 123.5,
    close: 123.5,
    volume: 20,
  });
  Object.assign(rows[3], {
    open: 125.5,
    high: 125.5,
    low: 125.5,
    close: 125.5,
    volume: 20,
  });
  return rows;
}
export const longBar = (ts, values = {}) =>
  bar(ts, { open: 123.1, low: 122.8, high: 123.3, close: 123.2, ...values });
export const shortBar = (ts, values = {}) =>
  bar(ts, { open: 125.9, low: 125.7, high: 126.2, close: 125.8, ...values });

// Published public entry/state builders with a strategy-owned source capability boundary.
export async function harness({
  overrides = {},
  initial = history(),
  stores = new Map(),
  position = null,
  source = history(),
  env = "BACKTEST",
  sourceError = null,
  runtimeConfig = {},
  sourceCapability = true,
} = {}) {
  const cfg = config(overrides);
  const data = [...initial];
  let currentPosition = position;
  const reads = [];
  const api = createStrategyAPI({
    strategy: "ValueAreaReclaim",
    symbol: "BTCUSDT",
    interval: cfg.INTERVAL,
    env,
    connector: {
      getPosition: async () => currentPosition,
      kline: async (request) => {
        reads.push(request);
        const failure =
          typeof sourceError === "function" ? sourceError() : sourceError;
        if (failure) throw failure;
        return source.map((row) => ({
          ...row,
          dt: new Date(row.timestamp).toISOString(),
          turnover: row.close * row.volume,
        }));
      },
    },
    cachedData: data,
    indicatorsState: {},
    isConfigFromBacktest: false,
    sharedReplayKey: "var-test",
    getSharedReplayState: (key, make) => {
      if (!stores.has(key)) stores.set(key, make());
      return stores.get(key);
    },
  });
  // Strategy-owned boundary double. Actual host capability is checked separately in Project integration.
  if (sourceCapability)
    api.getClosedCandles = async (request) => {
      reads.push(request);
      const failure =
        typeof sourceError === "function" ? sourceError() : sourceError;
      if (failure) throw failure;
      const candles = source
        .filter(
          (c) => c.timestamp >= request.start && c.timestamp < request.end,
        )
        .map((c) => ({
          ...c,
          dt: new Date(c.timestamp).toISOString(),
          turnover: c.close * c.volume,
        }));
      return {
        ...request,
        asOf: data.at(-1).timestamp + Number(cfg.INTERVAL) * 60000,
        candles,
        complete:
          candles.length === (request.end - request.start) / STEP &&
          candles.every((c, i) => c.timestamp === request.start + i * STEP),
        missingRanges: [],
      };
    };
  const run = await createValueAreaReclaimCore({
    config: { ...cfg, ...runtimeConfig },
    data,
    strategyApi: api,
    indicatorsState: {},
  });
  return {
    reads,
    stores,
    data,
    config: cfg,
    position: (p) => {
      currentPosition = p;
    },
    async next(row) {
      data.push(row);
      return run(row, row);
    },
    async repeat() {
      return run(data.at(-1), data.at(-1));
    },
  };
}
