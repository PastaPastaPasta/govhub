// Up/down buttons for a reaction target. The score is counted in this browser from the proven reactions. Each
// button says what clicking it costs: a first reaction stores a document (~0.0005 DASH), flipping replaces it
// (~0.00003), clicking your current vote again deletes it (a refund).
import { useState } from 'react';
import { COSTS, type Score } from '@govhub/forum';
import { formatCredits, formatSigned } from '../lib/format.ts';

export function costOfVote(value: 1 | -1, mine: Score['mine']): { credits: number; what: string } {
  if (!mine) return { credits: COSTS.reactionCreate, what: 'a first vote' };
  if (mine.value === value) return { credits: COSTS.reactionDelete, what: 'clearing your vote refunds' };
  return { credits: COSTS.reactionFlip, what: 'flipping your vote' };
}

const hint = (value: 1 | -1, s: Score, signedIn: boolean) => {
  if (!signedIn) return 'Sign in to vote';
  const c = costOfVote(value, s.mine);
  return c.credits < 0 ? `${c.what} about ${formatCredits(-c.credits, true)}` : `${c.what} costs about ${formatCredits(c.credits, true)}`;
};

export function Votes({ score, onVote, signedIn, label }: { score: Score; onVote(value: 1 | -1): Promise<void>; signedIn: boolean; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = score.mine?.value;
  const click = async (v: 1 | -1) => {
    setBusy(true);
    setError(null);
    try {
      await onVote(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="votes" role="group" aria-label={label} data-score={score.net}>
      <button type="button" className={`vote vote-up ${mine === 1 ? 'on' : ''}`} aria-pressed={mine === 1} disabled={busy} onClick={() => click(1)} title={hint(1, score, signedIn)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 2 11 9H1z" />
        </svg>
        <span className="visually-hidden">Up-vote ({hint(1, score, signedIn)})</span>
      </button>
      <span className="vote-score" title={`${score.up} up, ${score.down} down (counted here from the reactions on Platform)`}>
        {formatSigned(score.net)}
      </span>
      <button type="button" className={`vote vote-down ${mine === -1 ? 'on' : ''}`} aria-pressed={mine === -1} disabled={busy} onClick={() => click(-1)} title={hint(-1, score, signedIn)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 10 1 3h10z" />
        </svg>
        <span className="visually-hidden">Down-vote ({hint(-1, score, signedIn)})</span>
      </button>
      {busy && <span className="spinner" aria-label="signing" />}
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
