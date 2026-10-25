// The privacy mode choice (PLAN §8.5, §8.7, §8.8): one sentence per mode, its details under its own "learn more". Used by the badge
// page and, folded under "Privacy options", by the badge option of "Add your masternodes".
import { PRIVACY_MODES, type PrivacyMode } from '@govhub/badge';
import type { CoreNetwork } from '../data/types.ts';
import { ModeDetails } from './BadgeLeaks.tsx';
import type { KeyAvailability } from './client.ts';

export const MODES: Record<PrivacyMode, { label: string; summary: string }> = {
  standard: {
    label: 'Standard',
    summary: 'Fast: your badge appears now. The issuer could tell which masternode it belongs to; the govhub issuer’s operator commits to keeping no records that would let it link them, and you are trusting that.',
  },
  private: {
    label: 'Private',
    summary:
      'Your badge appears at a random time early in the next epoch, among the others who chose a private mode with the same issuer. That makes it harder for the issuer to match it to your masternode by timing, not impossible.',
  },
  extra: {
    label: 'Extra private',
    summary: 'Like Private, but the badge goes out at a random time across the first half of the next epoch: its timing is harder to match still, and it takes longer.',
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
