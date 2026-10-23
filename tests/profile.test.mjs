import assert from "node:assert/strict";
import test from "node:test";
import { buildValueAreaProfile, PROFILE_BINS } from "../dist/index.js";
import { history, END, DAY, STEP, bar } from "./helpers.mjs";

test("known point distribution gives exact POC and contiguous VA boundaries", () => {
  const p = buildValueAreaProfile(history(), END, 2, 0.9);
  assert.equal(p.totalVolume, 100);
  assert.equal(p.pocIndex, 24);
  assert.equal(p.poc, 124.5);
  assert.equal(p.val, 123);
  assert.equal(p.vah, 126);
  assert.equal(p.valueVolume, 100);
  assert.equal(
    p.bins.reduce((a, b) => a + b, 0),
    100,
  );
});
test("ties select lower POC and lower adjacent bin first", () => {
  const rows = history();
  rows.forEach((c) => {
    c.volume = 0;
  });
  Object.assign(rows[1], { volume: 10 });
  Object.assign(rows[2], { volume: 10 });
  let p = buildValueAreaProfile(rows, END, 2, 0.5);
  assert.equal(p.pocIndex, 23);
  assert.equal(p.val, 123);
  assert.equal(p.vah, 124);
  p = buildValueAreaProfile(history(), END, 2, 0.8);
  assert.equal(p.val, 123);
  assert.equal(p.vah, 125);
  assert.equal(p.valueVolume, 80);
});
test("uniform range volume and zero-width candles conserve input volume", () => {
  const rows = history();
  rows.forEach((c) => {
    c.volume = 0;
  });
  rows[0].volume = 96;
  let p = buildValueAreaProfile(rows, END, 2, 1);
  assert.deepEqual(p.bins, Array(PROFILE_BINS).fill(2));
  assert.equal(p.val, 100);
  assert.equal(p.vah, 148);
  Object.assign(rows[1], {
    open: 148,
    high: 148,
    low: 148,
    close: 148,
    volume: 7,
  });
  p = buildValueAreaProfile(rows, END, 2, 1);
  assert.equal(p.bins.at(-1), 9);
  assert.equal(
    p.bins.reduce((a, b) => a + b, 0),
    103,
  );
  rows.forEach((c) =>
    Object.assign(c, { open: 100, high: 100, low: 100, close: 100, volume: 1 }),
  );
  p = buildValueAreaProfile(rows, END, 2, 0.7);
  assert.equal(p.totalVolume, 192);
  assert.equal(p.bins[0], 192);
  assert.equal(p.poc, 100);
  assert.equal(p.val, p.vah);
});
test("deterministic irregular distributions conserve volume within floating precision", () => {
  const rows = history();
  for (let i = 0; i < rows.length; i++) {
    const low = 100 + (i % 37) * 0.137;
    const high = low + 0.013 + (i % 17) * 0.078;
    Object.assign(rows[i], {
      open: low,
      low,
      high,
      close: high,
      volume: (i * 17.123) % 101,
    });
  }
  const p = buildValueAreaProfile(rows, END, 2, 0.7);
  const sum = rows.reduce((a, b) => a + b.volume, 0);
  assert.ok(Math.abs(p.bins.reduce((a, b) => a + b, 0) - sum) < sum * 1e-12);
  assert.ok(p.bins.every((v) => v >= 0));
  assert.ok(p.valueVolume >= p.totalVolume * 0.7);
  assert.deepEqual(p, buildValueAreaProfile(rows, END, 2, 0.7));
});
test("exact half-open UTC window excludes current day and all future candles", () => {
  const rows = history();
  const p = buildValueAreaProfile(rows, END, 2, 0.9);
  const future = [bar(END, { high: 1e8, volume: 1e10 }), bar(END + DAY)];
  assert.deepEqual(buildValueAreaProfile([...rows, ...future], END, 2, 0.9), p);
  assert.equal(p.start, END - 2 * DAY);
  assert.equal(p.end, END);
  assert.equal(buildValueAreaProfile(rows.slice(1), END, 2, 0.9), null);
  assert.equal(
    buildValueAreaProfile([...rows.slice(0, -1), rows[0]], END, 2, 0.9),
    null,
  );
  assert.equal(buildValueAreaProfile([...rows].reverse(), END, 2, 0.9), null);
  assert.throws(() => buildValueAreaProfile(rows, END + STEP, 2, 0.9));
});
test("missing history, zero volume and invalid OHLCV do not create tradable profiles", () => {
  assert.equal(buildValueAreaProfile([], END, 2, 0.7), null);
  const rows = history();
  rows.forEach((c) => {
    c.volume = 0;
  });
  assert.equal(buildValueAreaProfile(rows, END, 2, 0.7), null);
  for (const patch of [
    { volume: -1 },
    { low: NaN },
    { high: 90 },
    { open: Infinity },
  ]) {
    const bad = history();
    Object.assign(bad[1], patch);
    assert.throws(() => buildValueAreaProfile(bad, END, 2, 0.7), /Invalid/);
  }
});

test("an exact interior bin boundary belongs to its upper bin", () => {
  const rows = history();
  rows.forEach((c) => {
    c.volume = 0;
  });
  Object.assign(rows[1], {
    open: 123,
    high: 123,
    low: 123,
    close: 123,
    volume: 10,
  });
  const profile = buildValueAreaProfile(rows, END, 2, 0.7);
  assert.equal(profile.bins[23], 10);
  assert.equal(profile.bins[22], 0);
  assert.equal(profile.poc, 123.5);
});
