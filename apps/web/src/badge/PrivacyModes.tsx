// The privacy mode choice (PLAN §8.5, §8.7, §8.8, §8.10): one sentence per mode, its details under its own "learn more". Used by the badge
// page and, folded under "Privacy options", by the badge option of "Add your masternodes".
import { PRIVACY_MODES, type PrivacyMode } from '@govhub/badge';
import type { CoreNetwork } from '../data/types.ts';
import { ModeDetails } from './BadgeLeaks.tsx';
import type { KeyAvailability } from './client.ts';

export const MODES: Record<PrivacyMode, { label: string; summary: string }> = {
  standard: {
    label: 'Standard',
    summary:
      'Your badge is fetched now and appears the next time you post or react, so it shows up with your own activity rather than right after the request. You can also post it straight away.',
  },
  private: {
    label: 'Private',
    summary: 'Slower: the badge is for the next epoch and appears at a random time early in it, among the others who chose Private. Harder still to match to your masternode.',
  },
};

/** Why a mode cannot be requested right now, from the key pre-check (null: it can, or the check has not finished). */
export function modeBlocked(av: KeyAvailability | null, m: PrivacyMode): string | null {
  const c = av?.modes.find((x) => x.mode === m);
  return c && !c.ok ? `no key for epoch ${c.epoch}` : null;
}

export function PrivacyModes({ value, onChange, av, net, name = 'badge-mode' }: { value: PrivacyMode; onChange(m: PrivacyMode): void; av: KeyAvailability | null; net: CoreNetwork; name?: string }) {
  return (
    <fieldset className="badge-modes">
      <legend>Privacy</legend>
      {PRIVACY_MODES.map((m) => (
        <div key={m} className="badge-mode">
          <label className="check">
            <input type="radio" name={name} checked={value === m} onChange={() => onChange(m)} data-testid={`${name}-${m}`} />
            <span>
              <b>{MODES[m].label}</b>
              {m === 'standard' && ' (default)'}
              {modeBlocked(av, m) && <span className="muted"> · not available yet ({modeBlocked(av, m)})</span>}: {MODES[m].summary}
            </span>
          </label>
          <details className="badge-mode-more" data-testid={`${name}-more-${m}`}>
            <summary>Learn more about {MODES[m].label}</summary>
            <p className="small">
              <ModeDetails mode={m} net={net} />
            </p>
          </details>
        </div>
      ))}
    </fieldset>
  );
}
