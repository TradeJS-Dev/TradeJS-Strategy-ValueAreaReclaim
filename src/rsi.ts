/** Cutler RSI of exactly14 closed close-to-close changes; no intrabar inputs. */
export function cutlerRsi14(changes: readonly number[]): number | null {
  if (changes.length !== 14) return null;
  if (!changes.every(Number.isFinite)) throw new Error("Invalid RSI change");
  let gain = 0,
    loss = 0;
  for (const change of changes) {
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }
  return gain + loss === 0 ? 50 : (100 * gain) / (gain + loss);
}
