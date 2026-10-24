// Traffic-light passing bar: absolute yes votes against the funding threshold (the tick).
import { formatInt, formatSigned } from '../lib/format.ts';
import type { PassState } from '../lib/governance.ts';

export function PassingBar({ absYes, threshold, state, compact }: { absYes: number; threshold: number; state: PassState; compact?: boolean }) {
  // Scale: the threshold sits at 2/3 of the track, so passing and failing proposals both have room.
  const max = Math.max(threshold * 1.5, absYes, 1);
  const fill = Math.max(0, Math.min(1, absYes / max));
  const tick = threshold / max;
  const text = state.passing ? `Passing ${formatSigned(state.margin)}` : `Needs ${formatInt(state.needed)} more yes`;
  return (
    <div className={`passbar passbar-${state.light}${compact ? ' passbar-compact' : ''}`}>
      <div
        className="passbar-track"
        role="meter"
        aria-label="Absolute yes votes against the funding threshold"
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.max(0, absYes)}
        aria-valuetext={`${formatInt(absYes)} of ${formatInt(threshold)} needed. ${text}`}
      >
        <div className="passbar-fill" style={{ inlineSize: `${fill * 100}%` }} />
        <div className="passbar-tick" style={{ insetInlineStart: `${tick * 100}%` }} />
      </div>
      <p className="passbar-text">
        <span className="passbar-dot" aria-hidden="true" />
        {text}
      </p>
    </div>
  );
}
