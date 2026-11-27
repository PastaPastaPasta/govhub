// /polls/new: put a question to the masternodes with the signed-in identity. A yes/no poll pays its 0.5 DASH fund; a multiple choice
// poll pays 0.2 DASH, and each choice 0.1 DASH into its vote. The cost is shown before anything is signed, and the documents are
// checked against the contract's rules first (Platform would refuse them and still charge its fees). Signed with the session's key.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { useAuth } from '../auth/context.tsx';
import { needCredits } from '../decisions/AddChoice.tsx';
import { choiceOp, choicePollCost, choicePollOp, choicePollProblems, endDateFor, hasProblems, MAX_CHOICES, yesNoCost, yesNoOp, yesNoProblems, type ChoiceDraft, type ChoicePollDraft, type YesNoDraft } from '../decisions/create.ts';
import { CHOICE_FUND_DUFFS, MULTIPLE_CHOICE_FEE_DUFFS, PASS_PERCENT, pollHref, TURNOUT_PERCENT, YES_NO_FUND_DUFFS } from '../decisions/model.ts';
import { PollsNotYet } from '../decisions/ui.tsx';
import { useDecisionSource, usePollsAvailable } from '../decisions/useDecisions.ts';
import { errText, formatCredits, formatDash, formatDateTime } from '../lib/format.ts';
import { isWalletSession } from '../session/authSession.ts';
import { ReadError } from '../ui/ReadError.tsx';
import { WriteError } from '../ui/WriteError.tsx';
import { TopUpError } from '../voting/funds.ts';
import '../decisions/decisions.css';

type Kind = 'yn' | 'mc';
const EMPTY_CHOICE: ChoiceDraft = { title: '', description: '' };

export function NewPollPage() {
  const src = useDecisionSource();
  const avail = usePollsAvailable(src);
  const { session } = useForum();
  const { openSheet } = useAuth();
  return (
    <section className="page-narrow polls poll-new" aria-labelledby="new-poll-title">
      <p className="crumbs">
        <Link to="/polls">‹ Masternode polls</Link>
      </p>
      <h1 id="new-poll-title">New masternode poll</h1>
      {avail.phase === 'checking' ? (
        <p className="muted" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Checking Platform for masternode polls…
        </p>
      ) : avail.phase === 'error' ? (
        <ReadError error={avail.error} what="Platform" lead="Platform could not be asked about masternode polls" onRetry={avail.retry} />
      ) : avail.phase === 'no' ? (
        <PollsNotYet network={src.network} />
      ) : !session ? (
        <div className="vempty" data-testid="new-poll-signin">
          <p>Sign in with the identity that asks the question. It pays for the poll from its Platform credits.</p>
          <button type="button" className="btn" onClick={() => openSheet('choose')}>
            Sign in
          </button>
        </div>
      ) : isWalletSession(session) ? (
        <p className="notice-box">Your wallet sign-in can only write govhub comments, reactions and posts. Sign in with your recovery phrase or key to ask a poll.</p>
      ) : (
        <PollForm />
      )}
    </section>
  );
}

function PollForm() {
  const { mode } = useApp();
  const { write, balance } = useForum();
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('yn');
  const [yn, setYn] = useState<YesNoDraft>({ title: '', description: '', url: '', passPercent: 60, minimumTurnoutPercent: 10, days: 14 });
  const [mc, setMc] = useState<ChoicePollDraft>({ title: '', url: '', open: true, choices: [{ ...EMPTY_CHOICE }, { ...EMPTY_CHOICE }] });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; topUp: boolean; created?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  // after a write that did or may have landed, asking again could pay for a second poll: the form locks
  const [locked, setLocked] = useState<{ created?: string } | null>(null);

  const ynProblems = yesNoProblems(yn);
  const mcProblems = choicePollProblems(mc);
  const filled = mc.choices.filter((c) => c.title.trim());
  const cost = kind === 'yn' ? yesNoCost() : choicePollCost(filled.length);
  const need = needCredits(cost);
  const short = balance !== null && balance < need;
  const invalid = kind === 'yn' ? Object.keys(ynProblems).length > 0 : hasProblems(mcProblems);
  const show = (p: string | undefined) => (touched && p ? <p className="error small">{p}</p> : null);

  const submit = async () => {
    setBusy('Signing…');
    setError(null);
    let created: string | undefined;
    try {
      if (mode === 'fixtures') throw new Error('Demo data: nothing is created. Switch to live data in Settings to ask a poll.');
      if (kind === 'yn') {
        const r = await write(yesNoOp(yn, Date.now()));
        navigate(pollHref(r.id));
        return;
      }
      setBusy('Creating the poll…');
      created = (await write(choicePollOp(mc))).id;
      for (const [i, c] of filled.entries()) {
        setBusy(`Adding choice ${i + 1} of ${filled.length}…`);
        await write(choiceOp(created, c));
      }
      navigate(pollHref(created));
    } catch (e) {
      const text = errText(e);
      // a poll created before a choice failed is there: its page takes the rest of the choices
      setError({ text, topUp: e instanceof TopUpError, ...(created ? { created } : {}) });
      if (created || /may still appear|not confirmed/i.test(text)) setLocked(created ? { created } : {});
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const review = () => {
    setTouched(true);
    if (!invalid && !short) setConfirming(true);
  };

  return (
    <div className="form poll-form" data-testid="new-poll-form">
      <fieldset className="seg">
        <legend className="visually-hidden">Kind of poll</legend>
        {(
          [
            ['yn', 'Yes or no'],
            ['mc', 'Multiple choice'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className={kind === k ? 'on' : undefined}>
            <input type="radio" name="poll-kind" checked={kind === k} onChange={() => (setKind(k), setConfirming(false))} data-testid={`new-poll-kind-${k}`} />
            {label}
          </label>
        ))}
      </fieldset>

      {kind === 'yn' ? (
        <>
          <label>
            Question
            <input value={yn.title} onChange={(e) => setYn({ ...yn, title: e.target.value })} maxLength={200} placeholder="Should …?" data-testid="new-poll-title" />
          </label>
          {show(ynProblems.title)}
          <label>
            What a yes and a no mean
            <textarea value={yn.description} onChange={(e) => setYn({ ...yn, description: e.target.value })} rows={5} data-testid="new-poll-description" />
          </label>
          {show(ynProblems.description)}
          <label>
            Where it is discussed <span className="muted">(optional link)</span>
            <input value={yn.url} onChange={(e) => setYn({ ...yn, url: e.target.value })} inputMode="url" placeholder="https://" data-testid="new-poll-url" />
          </label>
          {show(ynProblems.url)}
          <div className="poll-rule">
            <label>
              Passes when yes is more than
              <span className="poll-num">
                <input type="number" min={PASS_PERCENT.min} max={PASS_PERCENT.max} value={yn.passPercent} onChange={(e) => setYn({ ...yn, passPercent: Number(e.target.value) })} data-testid="new-poll-pass" />% of yes and no
              </span>
            </label>
            {show(ynProblems.passPercent)}
            <label>
              Minimum turnout
              <span className="poll-num">
                <input type="number" min={TURNOUT_PERCENT.min} max={TURNOUT_PERCENT.max} value={yn.minimumTurnoutPercent} onChange={(e) => setYn({ ...yn, minimumTurnoutPercent: Number(e.target.value) })} data-testid="new-poll-turnout" />% of all
                masternode voting power votes yes or no
              </span>
            </label>
            {show(ynProblems.minimumTurnoutPercent)}
            <label>
              Voting runs for
              <span className="poll-num">
                <input type="number" min={7} max={28} value={yn.days} onChange={(e) => setYn({ ...yn, days: Number(e.target.value) })} data-testid="new-poll-days" /> days
              </span>
            </label>
            {show(ynProblems.days)}
            {!ynProblems.days && <p className="small muted">Closes about {formatDateTime(endDateFor(yn.days, Date.now()) / 1000)}. The rule and the end can never change; the text can be edited for a day.</p>}
          </div>
        </>
      ) : (
        <>
          <label>
            Question
            <input value={mc.title} onChange={(e) => setMc({ ...mc, title: e.target.value })} maxLength={200} placeholder="Which …?" data-testid="new-poll-title" />
          </label>
          {show(mcProblems.title)}
          <label>
            The page that says what is being decided
            <input value={mc.url} onChange={(e) => setMc({ ...mc, url: e.target.value })} inputMode="url" placeholder="https://" data-testid="new-poll-url" />
          </label>
          <p className="small muted">A multiple choice poll holds no description of its own; voters read it at this link. Nothing on the network moderates that page, and whoever runs it can change it.</p>
          {show(mcProblems.url)}
          <label className="check">
            <input type="checkbox" checked={mc.open} onChange={(e) => setMc({ ...mc, open: e.target.checked })} /> Anyone may add choices (each pays {formatDash(CHOICE_FUND_DUFFS)}). Off: only you can.
          </label>
          <fieldset className="poll-choices">
            <legend>Choices</legend>
            {mc.choices.map((c, i) => (
              <div key={i} className="poll-choice-in">
                <label>
                  Choice {i + 1}
                  <input value={c.title} onChange={(e) => setMc({ ...mc, choices: mc.choices.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} maxLength={200} data-testid="new-poll-choice" />
                </label>
                {show(mcProblems.choices[i]?.title)}
                <label>
                  What voting for it means <span className="muted">(optional)</span>
                  <input value={c.description} onChange={(e) => setMc({ ...mc, choices: mc.choices.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
                </label>
                {show(mcProblems.choices[i]?.description)}
              </div>
            ))}
            {mc.choices.length < MAX_CHOICES && (
              <button type="button" className="btn btn-s" onClick={() => setMc({ ...mc, choices: [...mc.choices, { ...EMPTY_CHOICE }] })}>
                Add another choice
              </button>
            )}
            {show(mcProblems.count)}
            <p className="small muted">The vote opens with the first choice and runs two weeks (90 minutes on testnet); choices can join it for its first week. Choices can never be changed or removed.</p>
          </fieldset>
        </>
      )}

      <section className="panel poll-cost" aria-labelledby="poll-cost-title" data-testid="new-poll-cost">
        <h2 id="poll-cost-title" className="panel-title">
          What it costs
        </h2>
        {kind === 'yn' ? (
          <p>
            <b>{formatDash(YES_NO_FUND_DUFFS)}</b> into the poll’s fund, which pays for the masternodes’ votes; what they leave goes to Platform’s fee pools when it closes. It is not refunded.
          </p>
        ) : (
          <p>
            <b>{formatDash(cost)}</b>: {formatDash(MULTIPLE_CHOICE_FEE_DUFFS)} for the poll
            {filled.length ? `, and ${formatDash(CHOICE_FUND_DUFFS)} for ${filled.length === 1 ? 'its choice' : `each of its ${filled.length} choices`}, paid into the vote` : ''}. Not refunded.
          </p>
        )}
        <p className="small muted">
          Plus Platform’s processing fees, a small fraction of a DASH. Paid from your identity’s credits{balance !== null ? `: it has ${formatCredits(balance)}` : ''}.
          {kind === 'mc' && filled.length > 0 && ` That is ${filled.length + 1} transactions, signed one after another.`}
        </p>
        {short && <WriteError error={`Your identity needs about ${formatCredits(need)} available for this.`} needsTopUp />}
        {locked ? null : !confirming ? (
          <button type="button" className="btn btn-primary" onClick={review} disabled={!!busy} data-testid="new-poll-review">
            Review
          </button>
        ) : (
          <div className="cvote-acts">
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!!busy} data-testid="new-poll-send">
              {busy ?? `Pay ${formatDash(cost)} and ask`}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={!!busy}>
              Back
            </button>
          </div>
        )}
        <WriteError error={error?.text ?? null} needsTopUp={error?.topUp ?? false} />
        {locked?.created && (
          <p className="small" data-testid="new-poll-partial">
            The poll itself was created, so asking again would pay for a second one. <Link to={pollHref(locked.created)}>Open it</Link> to add the remaining choices.
          </p>
        )}
        {locked && !locked.created && (
          <p className="small" data-testid="new-poll-unconfirmed">
            It may still have been created: look in <Link to="/polls?show=mine">your polls</Link> before asking again, so you don’t pay twice.
          </p>
        )}
      </section>
    </div>
  );
}
