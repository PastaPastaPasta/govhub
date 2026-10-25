// The live progress of one signed vote: signed in your browser -> accepted by relay -> broadcast -> seen by the network -> counted.
// The provider's watchdog polls the relay and the bridge (with backoff); this only renders, with a ticking elapsed time.
import { useKeyring } from '../../voting/KeyringContext.tsx';
import { isOpen, type WatchedVote } from '../../voting/pending.ts';
import { cancelAction, describeVote, trackerSteps } from '../../voting/status.ts';
import { Badge, fmtElapsed, fmtTime, OutcomeChip, useNow } from './common.tsx';

export function VoteTracker({ vote, name }: { vote: WatchedVote; name: string }) {
  const k = useKeyring();
  const moving = isOpen(vote) || (vote.status === 'confirmed' && !vote.countedAt);
  const nowMs = useNow(1000, moving);
  const now = Math.floor(nowMs / 1000);
  const steps = trackerSteps(vote, now, fmtTime);
  const view = describeVote(vote, now, fmtTime);
  const start = vote.signedAt ?? vote.time;
  const end = vote.countedAt ?? (moving ? now : (vote.seenAt ?? now));
  const sendError = vote.status === 'queued' && !!vote.lastSendError && !vote.cancelSig;
  // a queued vote that is simply being sent has no cancel here (the list has Discard); one that may be at a relay always has one
  const cancelText = vote.status === 'queued' && !sendError && !vote.maybeAt?.length && !vote.cancelSig ? null : cancelAction(vote);
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <article className={`vtrack vtrack-${view.tone}`} data-testid="vote-tracker" data-status={vote.status} data-counted={vote.countedAt ? 'yes' : 'no'} aria-label={`${name}: ${view.badge}`}>
      <header className="vtrack-head">
        <span className="vtrack-name">{name}</span>
        <OutcomeChip outcome={vote.outcome} />
        <Badge tone={view.tone} testId="vote-tracker-badge">
          {view.badge}
        </Badge>
        <span className="vtrack-elapsed small" title="Time since you signed">
          {fmtElapsed(end - start)}
        </span>
      </header>
      <ol className="vsteps" style={{ ['--vdone' as string]: String(Math.max(0, done - 1)) }} aria-label="Progress of this vote">
        {steps.map((s) => (
          <li key={s.key} className={`vstep vstep-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined} data-step={s.key} data-state={s.state}>
            <span className="vstep-dot" aria-hidden="true">
              {s.state === 'done' ? (
                <svg viewBox="0 0 16 16" width="12" height="12">
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : s.state === 'error' ? (
                '!'
              ) : null}
            </span>
            <span className="vstep-label">
              {s.label}
              <span className="visually-hidden">{s.state === 'done' ? ' (done)' : s.state === 'active' ? ' (in progress)' : s.state === 'error' ? ' (stopped)' : ''}</span>
            </span>
            {s.detail && <span className="vstep-detail">{s.detail}</span>}
          </li>
        ))}
      </ol>
      <p className="vtrack-line small" aria-live="polite" data-testid="vote-tracker-line">
        {view.line}
      </p>
      {(sendError || cancelText) && (
        <div className="vtrack-actions">
          {sendError && (
            <button type="button" className="btn btn-s btn-primary" onClick={k.retryNow} data-testid="vote-retry">
              {k.relays.length > 1 ? 'Retry now (tries every relay)' : 'Retry now'}
            </button>
          )}
          {cancelText && (
            <button type="button" className="btn btn-s" onClick={() => void k.cancel(vote.voteHash).catch(() => {})} disabled={!!k.busy} data-testid="vote-cancel">
              {cancelText}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
