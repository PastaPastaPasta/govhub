// Small shared pieces of the keyring and voting UI: copy button, status badge, outcome chip, a ticking clock, time formats.
import { useEffect, useState } from 'react';
import { formatDateTime, shortHash } from '../../lib/format.ts';
import type { OwnedMasternode } from '../../voting/masternodes.ts';
import type { WatchedVote } from '../../voting/pending.ts';
import type { Tone } from '../../voting/status.ts';

export const OUTCOME_LABEL: Record<number, string> = { 1: 'Yes', 2: 'No', 3: 'Abstain' };

/** Re-renders every `ms` while `on`. */
export function useNow(ms = 1000, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** "4:53 PM" today, "Oct 25, 4:53 PM" otherwise. */
export function fmtTime(unixS: number): string {
  const d = new Date(unixS * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : formatDateTime(unixS);
}

/** "0:42", "12:05", "1:02:10" */
export function fmtElapsed(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function mnName(m: Pick<OwnedMasternode, 'proTxHash'> | Pick<WatchedVote, 'proTxHash' | 'collateralTxid' | 'collateralIndex'>, labels: ReadonlyMap<string, string>): string {
  const pro = m.proTxHash.toLowerCase();
  if (pro && labels.get(pro)) return labels.get(pro)!;
  if (pro) return shortHash(pro, 6);
  const v = m as WatchedVote;
  return `${shortHash(v.collateralTxid, 4)}:${v.collateralIndex}`;
}

export function Badge({ tone, children, testId }: { tone: Tone; children: React.ReactNode; testId?: string }) {
  return (
    <span className={`vbadge vbadge-${tone}`} data-testid={testId}>
      {children}
    </span>
  );
}

export function OutcomeChip({ outcome, muted = false }: { outcome: number | undefined; muted?: boolean }) {
  if (!outcome) return <span className="vout vout-none">Not voted</span>;
  return <span className={`vout vout-${outcome}${muted ? ' vout-muted' : ''}`}>{OUTCOME_LABEL[outcome]}</span>;
}

export function CopyButton({ text, label, done = 'Copied' }: { text: string; label: string; done?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="vcopy"
      aria-label={label}
      title={label}
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => setState('ok'),
          () => setState('fail'),
        ) ?? setState('fail')
      }
    >
      <span aria-hidden="true">{state === 'ok' ? '✓' : '⧉'}</span>
      <span className="vcopy-text" aria-live="polite">
        {state === 'ok' ? done : state === 'fail' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}

/** A hash shown short with a copy button for the full value. */
export function HashCopy({ value, label, n = 8 }: { value: string; label: string; n?: number }) {
  return (
    <span className="vhash">
      <span className="mono-ish" title={value}>
        {value.length > 2 * n + 1 ? shortHash(value, n) : value}
      </span>
      <CopyButton text={value} label={`Copy ${label}`} />
    </span>
  );
}
