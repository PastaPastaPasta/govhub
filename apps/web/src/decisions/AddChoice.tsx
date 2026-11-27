// Entering a choice for a multiple choice poll (anyone, for an open poll; only the asker otherwise), while its vote takes choices.
// Each choice pays the contest's fund to join (0.1 DASH, doubling past 250 choices), read from Platform, from the signed-in identity's credits.
import { useState } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText, formatCredits, formatDash } from '../lib/format.ts';
import { TopUpError } from '../voting/funds.ts';
import { WriteError } from '../ui/WriteError.tsx';
import { useAsync } from '../ui/hooks.ts';
import { useDecisionSource } from './useDecisions.ts';
import { choiceOp, needCredits, textProblem, titleProblem } from './create.ts';
import { CHOICE_FUND_DUFFS, type ChoicePoll } from './model.ts';

export function AddChoice({ poll, onAdded }: { poll: ChoicePoll; onAdded(): void }) {
  const { mode } = useApp();
  const { write, balance } = useForum();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; topUp: boolean } | null>(null);
  // after an add that may have landed, adding again could pay for a duplicate choice
  const [unconfirmed, setUnconfirmed] = useState(false);
  const src = useDecisionSource();
  const fundRead = useAsync(() => src.choiceFund(poll.id), [src, poll.id, open]);
  const fund = fundRead.data ?? CHOICE_FUND_DUFFS;
  const tp = title ? titleProblem(title) : null;
  const dp = textProblem(description, false);
  const need = needCredits(fund);
  const short = balance !== null && balance < need;
  if (!open)
    return (
      <p className="small">
        <button type="button" className="btn btn-s" onClick={() => setOpen(true)} data-testid="add-choice-open">
          Add a choice
        </button>{' '}
        <span className="muted">Costs {formatDash(fund)}, paid into the vote.</span>
      </p>
    );
  const go = async () => {
    if (titleProblem(title) || dp) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'fixtures') throw new Error('Demo data: nothing is created. Switch to live data in Settings to add a choice.');
      await write(choiceOp(poll.id, { title, description }));
      setTitle('');
      setDescription('');
      setOpen(false);
      onAdded();
    } catch (e) {
      const text = errText(e);
      setError({ text, topUp: e instanceof TopUpError });
      if (/may still appear|not confirmed/i.test(text)) setUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel form poll-add" aria-labelledby="add-choice-title" data-testid="add-choice">
      <h2 id="add-choice-title" className="panel-title">
        Add a choice
      </h2>
      <label>
        Choice
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="add-choice-title" />
      </label>
      {tp && <p className="error small">{tp}</p>}
      <label>
        What voting for it means <span className="muted">(optional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      {dp && <p className="error small">{dp}</p>}
      <p className="small muted">
        It costs {formatDash(fund)}, paid into the vote to cover the masternodes’ votes, plus Platform’s fee. Choices can never be changed or removed.
        {balance !== null && ` Your identity has ${formatCredits(balance)}.`}
      </p>
      <div className="cvote-acts">
        {!unconfirmed && (
          <button type="button" className="btn btn-primary" disabled={busy || fundRead.loading || !title.trim() || !!tp || !!dp || short} onClick={() => void go()} data-testid="add-choice-send">
            {busy ? 'Adding…' : `Pay ${formatDash(fund)} and add it`}
          </button>
        )}
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {short && <WriteError error={`Your identity needs about ${formatCredits(need)} available for this.`} needsTopUp />}
      <WriteError error={error?.text ?? null} needsTopUp={error?.topUp ?? false} />
      {unconfirmed && <p className="small">It may still have been added: reload the poll and check its choices before adding it again, so you don’t pay twice.</p>}
    </section>
  );
}
