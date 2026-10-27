import type { Signal } from "@tradejs/types";
import type { ReclaimCandidate } from "./engine.js";
import { SOURCE_INTERVAL_MS } from "./profile.js";

export function buildFigures(
  candidate: ReclaimCandidate,
  entry: number,
  stop: number,
  executionStep = SOURCE_INTERVAL_MS,
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
    lines: Object.entries({
      ...levels,
      ...(candidate.priorDayTrap
        ? {
            previous_day_high: candidate.priorDayTrap.previousDayRange.high,
            previous_day_low: candidate.priorDayTrap.previousDayRange.low,
          }
        : {}),
    }).map(([kind, value]) => ({
      id: `var-${kind}-${timestamp}`,
      kind: `var_${kind}`,
      points: [
        {
          timestamp: ["VAH", "VAL", "POC"].includes(kind)
            ? profile.end
            : timestamp,
          value,
        },
        { timestamp: timestamp + executionStep, value },
      ],
      color:
        kind === "stop" ? "#ef4444" : kind === "target" ? "#22c55e" : "#3b82f6",
      style: kind === "stop" || kind === "target" ? "dashed" : "solid",
    })),
    points: [
      ...(candidate.acceptedReturn
        ? [
            {
              kind: "var_accepted_closes",
              points: candidate.acceptedReturn.priorCloses.map((c) => ({
                timestamp: c.timestamp,
                value: c.close,
              })),
              radius: 3,
            },
            {
              kind: "var_accepted_outside",
              points: [
                {
                  timestamp: candidate.acceptedReturn.outsideBar.timestamp,
                  value: candidate.acceptedReturn.outsideBar.close,
                },
              ],
              radius: 4,
            },
          ]
        : []),
      ...(candidate.rsiDoubleTrap
        ? [candidate.rsiDoubleTrap.prior, candidate.rsiDoubleTrap.current].map(
            (c, i) => ({
              kind: `var_rsi_extreme_${i}`,
              points: [
                { timestamp: c.extremeTimestamp, value: c.extremePrice },
              ],
              radius: 4,
            }),
          )
        : []),
      ...(candidate.rsiDoubleTrap
        ? [
            {
              kind: "var_rsi_outside_closes",
              points: [
                candidate.rsiDoubleTrap.prior,
                candidate.rsiDoubleTrap.current,
              ].map((c) => ({
                timestamp: c.outsideBar.timestamp,
                value: c.outsideBar.close,
              })),
              radius: 3,
            },
            {
              kind: "var_rsi_return_closes",
              points: [
                candidate.rsiDoubleTrap.prior,
                candidate.rsiDoubleTrap.current,
              ].map((c) => ({
                timestamp: c.returnTimestamp,
                value: c.returnClose,
              })),
              radius: 3,
            },
          ]
        : []),
      ...(candidate.priorDayTrap
        ? [
            {
              kind: "var_prior_day_outside",
              points: [
                {
                  timestamp: candidate.priorDayTrap.outsideBar.timestamp,
                  value: candidate.priorDayTrap.outsideBar.close,
                },
              ],
              radius: 4,
            },
          ]
        : []),
      { kind: "var_entry", points: [{ timestamp, value: entry }], radius: 5 },
    ],
    zones: [
      ...(candidate.priorDayTrap
        ? [
            {
              kind: "var_previous_day_range",
              start: {
                timestamp: candidate.priorDayTrap.previousDayRange.start,
                value: candidate.priorDayTrap.previousDayRange.low,
              },
              end: {
                timestamp: candidate.priorDayTrap.previousDayRange.end,
                value: candidate.priorDayTrap.previousDayRange.high,
              },
              color: "#a855f722",
            },
          ]
        : []),
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
          `mode=${candidate.entryMode ?? "legacy"}`,
          ...(candidate.rsiDoubleTrap
            ? [JSON.stringify(candidate.rsiDoubleTrap)]
            : []),
          ...(candidate.priorDayTrap
            ? [JSON.stringify(candidate.priorDayTrap)]
            : []),
          `15m OHLCV, ${profile.bins.length} bins`,
          `[${new Date(profile.start).toISOString()}, ${new Date(profile.end).toISOString()})`,
          `VAH=${profile.vah}; VAL=${profile.val}; POC=${profile.poc}`,
          `entry=${entry}; stop=${stop}; target=${profile.poc}`,
        ],
      },
    ],
  };
}
