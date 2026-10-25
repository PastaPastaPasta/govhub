// Net yes votes against the funding threshold (the notch). Green past it, amber close to it, red far from it.
import { formatInt } from '../lib/format.ts';
import type { PassState } from '../lib/governance.ts';

export function fundingText(state: PassState): string {
  return state.passing ? `Passing by ${formatInt(state.margin)}` : `Needs ${formatInt(state.needed)} more yes votes`;
}

export function FundingMeter({ absYes, threshold, state, size = 'm' }: { absYes: number; threshold: number; state: PassState; size?: 's' | 'm' }) {
  // the threshold sits at 2/3 of the track, so passing and failing proposals both have room
  const max = Math.max(threshold * 1.5, absYes, 1);
  const fill = Math.max(0, Math.min(1, absYes / max));
  const text = fundingText(state);
  return (
    <div className={`meter meter-${state.light} meter-${size}`} data-testid="funding-meter">
      <p className="meter-text">
        <span className="meter-dot" aria-hidden="true" />
        {text}
      </p>
      <div
        className="meter-track"
        role="meter"
        aria-label="Net yes votes against the funding threshold"
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.max(0, absYes)}
        aria-valuetext={`${formatInt(absYes)} net yes of ${formatInt(threshold)} needed. ${text}`}
      >
        <div className="meter-fill" style={{ inlineSize: `${fill * 100}%` }} />
        <div className="meter-notch" style={{ insetInlineStart: `${(threshold / max) * 100}%` }} />
      </div>
    </div>
  );
}
