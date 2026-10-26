// Client timing (PLAN §8.5, §8.8, §8.10), per privacy mode:
//   standard  token for the CURRENT epoch, requested as soon as the browser's activity spacing allows; the badge is held in the
//             browser and posted with the user's next Platform write (or at once, on request). Its posting time is the app's
//             business (apps/web/src/badge), not a height picked here.
//   private   token for the NEXT epoch at a uniformly random height in E-1's window; badge at a random height in [S(E), S(E)+W]
// All randomness is from the CSPRNG.

import { randomBelow } from './bytes.ts';
import { epochOf, epochStart, postingWindow, privateRequestWindow, type EpochParams, type HeightRange } from './epoch.ts';

export type PrivacyMode = 'standard' | 'private';
export const PRIVACY_MODES: readonly PrivacyMode[] = ['standard', 'private'];
export const isPrivacyMode = (v: unknown): v is PrivacyMode => typeof v === 'string' && (PRIVACY_MODES as readonly string[]).includes(v);
/** A stored mode: the retired 'extra' (Extra private) reads as 'private'; anything else unknown as `fallback`. */
export const parsePrivacyMode = (v: unknown, fallback: PrivacyMode): PrivacyMode => (v === 'extra' ? 'private' : isPrivacyMode(v) ? v : fallback);

/** Uniform height in [max(from, now), to); null when nothing of the range is left. */
export function pickHeight(range: HeightRange, now: number): number | null {
  const from = Math.max(range.from, now);
  if (from >= range.to) return null;
  return from + randomBelow(range.to - from);
}

/** When a private-mode client sends its request for `epoch` (null: too late for this epoch). */
export const pickRequestHeight = (p: EpochParams, epoch: number, now: number): number | null => pickHeight(privateRequestWindow(p, epoch), now);

/** A Private client's posting range for `epoch`: from S(E) + margin to S(E) + W (inclusive). */
export function clientPostingWindow(p: EpochParams, epoch: number): HeightRange {
  const w = postingWindow(p, epoch);
  return { from: w.from + p.boundaryMarginBlocks, to: w.to + 1 };
}

/** When a Private client posts the badge for `epoch`: a uniformly random height in its posting window. */
export function pickPostHeight(p: EpochParams, epoch: number, now: number): number {
  const w = clientPostingWindow(p, epoch);
  return pickHeight(w, now) ?? Math.max(now, w.from);
}

/**
 * A due action found when the app opens is not run at once (that would tie it to the page load and its IP): it waits a
 * random 30 s to 10 min, or less when the window is about to close. Private mode only.
 */
export function resumeDelayMs(maxMs = 600_000): number {
  const min = Math.min(30_000, maxMs);
  return min + randomBelow(Math.max(1, maxMs - min));
}

/**
 * The epoch a client asks for at `now`:
 *   standard  the current epoch, unless its last `boundaryMarginBlocks` are running (then the next one, from its start)
 *   private   the next epoch whose request window is still open
 */
export function requestableEpoch(p: EpochParams, now: number, mode: PrivacyMode = 'private'): number | null {
  const e = epochOf(p, now);
  if (mode === 'standard') return now < epochStart(p, e + 1) - p.boundaryMarginBlocks ? Math.max(1, e) : e + 1;
  for (const x of [e + 1, e + 2]) if (privateRequestWindow(p, x).to > now) return x;
  return null;
}
