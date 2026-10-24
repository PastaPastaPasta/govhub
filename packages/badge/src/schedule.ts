// Client timing (PLAN §8.5), per privacy mode:
//   standard  token for the CURRENT epoch, requested and posted at once (the issuer could link MN and identity by timing)
//   private   token for the NEXT epoch at a uniformly random height in E-1's window; badge at a random height in [S(E), S(E)+W]
//   extra     as private, but the badge goes out at a random height in the first half of E
// All randomness is from the CSPRNG.

import { randomBelow } from './bytes.ts';
import { epochOf, epochStart, extraPostingWindow, postingWindow, privateRequestWindow, type EpochParams, type HeightRange } from './epoch.ts';

export type PrivacyMode = 'standard' | 'private' | 'extra';
export const PRIVACY_MODES: readonly PrivacyMode[] = ['standard', 'private', 'extra'];
export const isPrivacyMode = (v: unknown): v is PrivacyMode => typeof v === 'string' && (PRIVACY_MODES as readonly string[]).includes(v);

/** Uniform height in [max(from, now), to); null when nothing of the range is left. */
export function pickHeight(range: HeightRange, now: number): number | null {
  const from = Math.max(range.from, now);
  if (from >= range.to) return null;
  return from + randomBelow(range.to - from);
}

/** When a private-mode client sends its request for `epoch` (null: too late for this epoch). */
export const pickRequestHeight = (p: EpochParams, epoch: number, now: number): number | null => pickHeight(privateRequestWindow(p, epoch), now);

/** The client's posting range for `epoch` in a private mode: from S(E) + margin to the end of the mode's window (inclusive). */
export function clientPostingWindow(p: EpochParams, epoch: number, mode: Exclude<PrivacyMode, 'standard'> = 'private'): HeightRange {
  const w = mode === 'extra' ? extraPostingWindow(p, epoch) : postingWindow(p, epoch);
  return { from: w.from + p.boundaryMarginBlocks, to: w.to + 1 };
}

/** When to post the badge for `epoch`: Standard at once (never before S(E)); the private modes at a random height in their window. */
export function pickPostHeight(p: EpochParams, epoch: number, now: number, mode: PrivacyMode = 'private'): number {
  if (mode === 'standard') return Math.max(now, epochStart(p, epoch));
  const w = clientPostingWindow(p, epoch, mode);
  return pickHeight(w, now) ?? Math.max(now, w.from);
}

/**
 * A due action found when the app opens is not run at once (that would tie it to the page load and its IP): it waits a
 * random 30 s to 10 min, or less when the window is about to close. Private modes only.
 */
export function resumeDelayMs(maxMs = 600_000): number {
  const min = Math.min(30_000, maxMs);
  return min + randomBelow(Math.max(1, maxMs - min));
}

/**
 * The epoch a client asks for at `now`:
 *   standard  the current epoch, unless its last `boundaryMarginBlocks` are running (then the next one, posted from its start)
 *   private   the next epoch whose request window is still open
 */
export function requestableEpoch(p: EpochParams, now: number, mode: PrivacyMode = 'private'): number | null {
  const e = epochOf(p, now);
  if (mode === 'standard') return now < epochStart(p, e + 1) - p.boundaryMarginBlocks ? Math.max(1, e) : e + 1;
  for (const x of [e + 1, e + 2]) if (privateRequestWindow(p, x).to > now) return x;
  return null;
}

