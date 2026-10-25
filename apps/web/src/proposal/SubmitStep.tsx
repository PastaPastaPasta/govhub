// Step 5: from a paid fee to a live proposal. The relay holds the proposal and submits it at 6 confirmations (Dash Core's rule),
// the page shows each stage as it happens (confirmations proven where the chain is verified here), and the user can always submit it
// with their own Dash Core instead. Then the moment it is live, in the same style as an accepted vote.
import { duffsToDash, GOVERNANCE_FEE_CONFIRMATIONS, gobjectSubmitCommand } from '@govhub/verify';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatInt, shortHash } from '../lib/format.ts';
import { CopyButton } from '../ui/vote/common.tsx';
import { WinMark } from '../ui/vote/VoteSuccess.tsx';
import { relayHost } from '../voting/relay.ts';
import { draftStage, type DraftSubmission, type ProposalDraft, type RelayReceipt } from './draft.ts';
import { govhubUrlOwner } from './EditSteps.tsx';
import { BackupBox, type PayProps } from './PayStep.tsx';
import type { CollateralCheck } from './services.ts';
import { markManualSubmit, resetRelays, submissionTick } from './submission.ts';

type Status = 'done' | 'now' | 'todo' | 'bad';

export function SubmitStep({ draft, commit, services }: PayProps) {
  const [check, setCheck] = useState<CollateralCheck | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const done = draftStage(draft) === 'done';

  useEffect(() => {
    if (done) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let again = true;
      try {
        const r = await submissionTick(draftRef.current, services);
        if (!live) return;
        setCheck(r.check);
        setInvalid(r.invalid ?? null);
        again = !r.invalid && draftStage(r.draft) !== 'done';
        // only what the tick learned is written back, onto the latest draft
        commitRef.current((d) => {
          const next = { ...r.draft.submission! };
          // a manual submit clicked while the tick ran stays
          if (d.submission?.submittedAt && !next.submittedAt) Object.assign(next, { submittedAt: d.submission.submittedAt, via: d.submission.via });
          return { ...d, submission: next };
        });
      } catch {
        /* a failed tick (or a draft that could not be saved) is tried again on the next one */
      } finally {
        if (live && again) timer = setTimeout(() => void run(), services.pollMs);
      }
    };
    void run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [services, done, nonce]);

  const lock = draft.lock!;
  const txid = draft.payment!.txid!;
  const sub = draft.submission;
  const conf = sub?.confirmations;
  const n = conf?.n ?? 0;
  const submitCmd = gobjectSubmitCommand(lock, txid);
  const holder = sub?.relays.find((r) => r.status === 'waiting' || r.status === 'submitting' || r.status === 'submitted');
  const failed = sub?.relays.filter((r) => r.status === 'failed' || r.status === 'unreachable') ?? [];
  const allFailed = !holder && failed.length > 0 && failed.length >= services.relays().length;
  const confStatus: Status = invalid ? 'bad' : n >= GOVERNANCE_FEE_CONFIRMATIONS ? 'done' : 'now';
  const subStatus: Status = sub?.submittedAt ? 'done' : allFailed ? 'bad' : n >= GOVERNANCE_FEE_CONFIRMATIONS ? 'now' : 'todo';
  const seenStatus: Status = sub?.seenAt ? 'done' : sub?.submittedAt ? 'now' : 'todo';
  const pubStatus: Status = sub?.publishedAt ? 'done' : sub?.seenAt ? 'now' : 'todo';
  const basis = conf?.basis === 'verified' ? 'proven in this browser' : services.demo ? 'simulated' : check?.weak ? 'checked here; testnet proof of work cannot make it secure' : 'as a DAPI node reports it';

  return (
    <div className="pw-form" data-testid="p-submit">
      {done && <Live draft={draft} />}
      <ol className="pw-timeline">
        <Stage status="done" title="Fee paid" testId="p-stage-paid">
          <p className="small muted break">
            Transaction {shortHash(txid, 10)} <CopyButton text={txid} label="Copy the fee transaction id" />
          </p>
        </Stage>
        <Stage status={confStatus} title={`Confirmations: ${Math.min(n, GOVERNANCE_FEE_CONFIRMATIONS)} of ${GOVERNANCE_FEE_CONFIRMATIONS}`} testId="p-stage-confs">
          {invalid ? (
            <p className="error small">{invalid}</p>
          ) : (
            <p className="small muted" data-testid="p-confs-detail">
              {conf ? `${formatInt(n)} confirmation${n === 1 ? '' : 's'}, ${basis}.` : check?.state === 'not-found' ? 'Not seen on the network yet.' : 'Checking…'}
              {conf?.final && ' Final: a ChainLock covers its block.'} Dash Core needs {GOVERNANCE_FEE_CONFIRMATIONS} (about 15 minutes) before it accepts the proposal.
            </p>
          )}
        </Stage>
        <Stage status={subStatus} title="Submitted to the network" testId="p-stage-submitted">
          <p className="small muted">{submittedNote(sub, holder, allFailed)}</p>
        </Stage>
        <Stage status={seenStatus} title="Seen by the network" testId="p-stage-seen">
          <p className="small muted">{sub?.seenAt ? 'Another Dash node has it.' : 'Checked on a bridge (a separate Dash Core node).'}</p>
        </Stage>
        <Stage status={pubStatus} title="On govhub" testId="p-stage-published">
          <p className="small muted">{sub?.publishedAt ? 'Published to Dash Platform by the bridge.' : 'The bridge publishes proposals to Dash Platform once they have 6 confirmations.'}</p>
        </Stage>
      </ol>

      {failed.length > 0 && !sub?.submittedAt && (
        <div className="auth-error" role="status" data-testid="p-relay-errors">
          {failed.map((r) => (
            <p key={r.base} className="small">
              {r.name}: {r.coreMessage ?? r.lastError}
            </p>
          ))}
          <button
            type="button"
            className="btn btn-s"
            onClick={() => {
              commit(resetRelays);
              setNonce((x) => x + 1);
            }}
          >
            Try the relays again
          </button>
        </div>
      )}

      <details className="pw-details" open={allFailed || undefined}>
        <summary>Submit it yourself with Dash Core</summary>
        <p className="small">
          After {GOVERNANCE_FEE_CONFIRMATIONS} confirmations, run this in Dash Core (Window → Console, or dash-cli). Submitting twice is harmless.
        </p>
        <pre className="pw-code" data-testid="p-submit-cmd">
          {submitCmd}
        </pre>
        <div className="form-actions">
          <span className="vwin-copy">
            Copy <CopyButton text={submitCmd} label="Copy the gobject submit command" />
          </span>
          {!sub?.submittedAt && (
            <button type="button" className="btn btn-s" onClick={() => commit(markManualSubmit)} data-testid="p-manual-done">
              I submitted it with Dash Core
            </button>
          )}
        </div>
      </details>

      <details className="pw-details">
        <summary>If something goes wrong</summary>
        <ul className="small pw-help">
          <li>
            <b>The relay is down.</b> Another configured relay is tried, and you can always submit with Dash Core (above). Your backup file has everything needed, on any device.
          </li>
          <li>
            <b>The fee transaction does not confirm.</b> Transactions with the standard fee confirm in the next block or two. If it stays unconfirmed for hours, it may have been
            replaced or dropped: then no fee was burned. Pay again from the Pay step after checking the transaction in a block explorer.
          </li>
          <li>
            <b>Dash Core refuses the proposal.</b> The reason is shown above. A refusal for the collateral ("requires at least 6 confirmations") clears itself; govhub checks the
            data against Core's rules before you pay, so a data refusal should not happen. If it does, keep the backup and ask for help in the Dash forum: the fee is spent.
          </li>
          <li>
            <b>You closed the page.</b> A holding relay submits anyway. Come back to Create a proposal, or restore the backup file, to follow it.
          </li>
        </ul>
      </details>

      <BackupBox draft={draft} commit={commit} compact />
      <details className="pw-details">
        <summary>Details</summary>
        <dl className="kv small">
          <div>
            <dt>Proposal hash</dt>
            <dd className="break" data-testid="p-govhash">
              {lock.govHash}
            </dd>
          </div>
          <div>
            <dt>Relays</dt>
            <dd>{services.relays().map((r) => (r.base.startsWith('demo') ? r.name : relayHost(r.base))).join(', ') || 'none configured'}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{duffsToDash(BigInt(lock.paymentDuffs))} DASH per payment</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

/** What the "Submitted to the network" stage says: who submitted it, who holds it, or why nobody does. */
function submittedNote(sub: DraftSubmission | undefined, holder: RelayReceipt | undefined, allFailed: boolean): string {
  if (sub?.submittedAt) {
    if (sub.via === 'manual') return 'You submitted it with Dash Core.';
    return sub.via === 'network' ? 'The network has it.' : `Submitted by ${sub.via}.`;
  }
  if (holder?.legacy) return `${holder.name} will be asked to submit it at ${GOVERNANCE_FEE_CONFIRMATIONS} confirmations; keep this page open until then.`;
  if (holder) return `${holder.name} holds it and submits it at ${GOVERNANCE_FEE_CONFIRMATIONS} confirmations. You can close this page.`;
  return allFailed ? 'No relay could take it. Submit it with Dash Core (below), or try the relays again.' : 'Handing it to a relay…';
}

function Stage({ status, title, children, testId }: { status: Status; title: string; children?: ReactNode; testId: string }) {
  return (
    <li data-status={status} data-testid={testId}>
      <span className="fund-dot" aria-hidden="true" />
      <div>
        <b>{title}</b>
        {children}
      </div>
    </li>
  );
}

function Live({ draft }: { draft: ProposalDraft }) {
  const lock = draft.lock!;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const govhubOwner = govhubUrlOwner(lock.url);
  return (
    <section ref={ref} tabIndex={-1} className="vwin" role="status" aria-labelledby="pw-live-title" data-testid="p-live">
      <WinMark />
      <div className="vwin-body">
        <h3 id="pw-live-title">Your proposal is live</h3>
        <p className="vwin-sub">
          <b>{lock.name}</b> is on the network and on govhub. Masternodes can vote on it now.
        </p>
        <div className="vwin-actions">
          <Link className="btn btn-s btn-primary" to={`/p/h/${lock.govHash}`} data-testid="p-view">
            View it on govhub
          </Link>
          <Link className="btn btn-s" to={`/p/h/${lock.govHash}#ownership`} data-testid="p-claim">
            Write the description
          </Link>
        </div>
        <p className="small muted">
          {govhubOwner
            ? `Its link names your identity ${shortHash(govhubOwner, 6)}. On the proposal page, accept ownership while signed in as it, then publish the description voters read.`
            : 'Claim it on the proposal page with a signature from the payment address, then publish the description voters read.'}
        </p>
      </div>
    </section>
  );
}
