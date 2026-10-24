// Client timing rules (PLAN §8.5). The issuer must not be able to line a token up with a badge, or a request with the
// user's other activity, by time: requests go out at a uniformly random height inside the issuance window and badges are
// posted at a uniformly random height in [S(E), S(E)+W]. All randomness is from the CSPRNG.

import { randomBelow } from './bytes.ts';
import { clientIssuanceWindow, epochStart, postingWindow, type EpochParams, type HeightRange } from './epoch.ts';

/** Uniform height in [max(from, now), to); null when nothing of the range is left. */
export function pickHeight(range: HeightRange, now: number): number | null {
  const from = Math.max(range.from, now);
  if (from >= range.to) return null;
  return from + randomBelow(range.to - from);
}

/** When to send the token request for `epoch` (null: too late for this epoch). */
export const pickRequestHeight = (p: EpochParams, epoch: number, now: number): number | null => pickHeight(clientIssuanceWindow(p, epoch), now);

/** The client's posting range for `epoch`: [S(E) + margin, S(E) + W] (inclusive end, so `to` is W + 1). */
export function clientPostingWindow(p: EpochParams, epoch: number): HeightRange {
  const w = postingWindow(p, epoch);
  return { from: w.from + p.boundaryMarginBlocks, to: w.to + 1 };
}

/** When to post the badge for `epoch`. After the window it is still allowed (until the display window ends), so it returns `now`. */
export function pickPostHeight(p: EpochParams, epoch: number, now: number): number {
  const w = clientPostingWindow(p, epoch);
  return pickHeight(w, now) ?? Math.max(now, w.from);
}

/**
 * A due action found when the app opens is not run at once (that would tie it to the page load and its IP): it waits a
 * random 30 s to 10 min, or less when the window is about to close.
 */
export function resumeDelayMs(maxMs = 600_000): number {
  const min = Math.min(30_000, maxMs);
  return min + randomBelow(Math.max(1, maxMs - min));
}

/** The latest epoch a client can still request a token for at `now`, i.e. the next epoch if its window is still open. */
export function requestableEpoch(p: EpochParams, now: number): number | null {
  const len = epochStart(p, 1);
  const next = Math.floor(now / len) + 1;
  for (const e of [next, next + 1]) if (clientIssuanceWindow(p, e).to > now) return e;
  return null;
}
