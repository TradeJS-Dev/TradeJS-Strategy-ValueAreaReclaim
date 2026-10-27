import type { KlineChartData } from "@tradejs/types";

/** Exact approved capability; older published hosts may not provide it. */
export interface ClosedCandlesCapability {
  getClosedCandles(request: {
    interval: "15";
    start: number;
    end: number;
    limit: number;
  }): Promise<{
    interval: "15";
    start: number;
    end: number;
    asOf: number;
    candles: KlineChartData;
    complete: boolean;
    missingRanges: Array<{ start: number; end: number }>;
  }>;
}
