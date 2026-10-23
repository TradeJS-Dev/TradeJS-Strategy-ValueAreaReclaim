import type { Signal } from "@tradejs/types";
import type { ReclaimCandidate } from "./engine.js";

export function buildFigures(
  candidate: ReclaimCandidate,
  entry: number,
  stop: number,
): Signal["figures"] {
  const { profile, timestamp, direction } = candidate;
  const levels = {
    VAH: profile.vah,
    VAL: profile.val,
    POC: profile.poc,
    entry,
    stop,
    target: profile.poc,
  };
  return {
    lines: Object.entries(levels).map(([kind, value]) => ({
      id: `var-${kind}-${timestamp}`,
      kind: `var_${kind}`,
      points: [
        { timestamp: profile.end, value },
        { timestamp, value },
      ],
      color:
        kind === "stop" ? "#ef4444" : kind === "target" ? "#22c55e" : "#3b82f6",
      style: kind === "stop" || kind === "target" ? "dashed" : "solid",
    })),
    points: [
      { kind: "var_entry", points: [{ timestamp, value: entry }], radius: 5 },
    ],
    zones: [
      {
        kind: "var_profile_period",
        start: { timestamp: profile.start, value: profile.low },
        end: { timestamp: profile.end, value: profile.high },
        color: "#3b82f622",
      },
    ],
    annotations: [
      {
        kind: "var_profile",
        point: { timestamp, value: entry },
        title: `ValueAreaReclaim ${direction}`,
        items: [
          `15m OHLCV, ${profile.bins.length} bins`,
          `[${new Date(profile.start).toISOString()}, ${new Date(profile.end).toISOString()})`,
          `VAH=${profile.vah}; VAL=${profile.val}; POC=${profile.poc}`,
          `entry=${entry}; stop=${stop}; target=${profile.poc}`,
        ],
      },
    ],
  };
}
