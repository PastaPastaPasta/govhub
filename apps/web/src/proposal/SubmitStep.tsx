// Step 5: from a paid fee to a live proposal. The relay holds the proposal and sends it once the fee is in a ChainLocked block; Dash
// Core makes it live at 6 confirmations (its rule). The page shows each stage as it happens (confirmations proven where the chain is
// verified here), and the user can always submit it with their own Dash Core instead. Then the moment it is live, in the same style
// as an accepted vote.
import { duffsToDash, GOVERNANCE_FEE_CONFIRMATIONS, gobjectSubmitCommand } from '@govhub/verify';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '../ui/Link.tsx';
import { useApp } from '../app/context.tsx';
import { formatInt, shortHash } from '../lib/format.ts';
import { CopyButton } from '../ui/vote/common.tsx';
import { WinMark } from '../ui/vote/VoteSuccess.tsx';
import { relayHost } from '../voting/relay.ts';
import { backupFile, backupMilestone, draftStage, feeUnit, type DraftSubmission, type ProposalDraft, type RelayReceipt } from './draft.ts';
import { govhubUrlOwner } from './EditSteps.tsx';
import { downloadBackup, type PayProps } from './PayStep.tsx';
import type { CollateralCheck } from './services.ts';
import { markManualSubmit, resetRelays, sendable, submissionTick } from './submission.ts';
import { IdentityName } from '../ui/Identity.tsx';

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
  const { reload } = useApp();
  // the moment it is on govhub, the lists load again so it shows there without a page reload
  useEffect(() => {
    if (draft.submission?.publishedAt) reload();
  }, [draft.submission?.publishedAt, reload]);

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
  const subStatus: Status = sub?.submittedAt ? 'done' : allFailed ? 'bad' : holder?.sent || sendable(check) ? 'now' : 'todo';
  const seenStatus: Status = sub?.seenAt ? 'done' : sub?.submittedAt ? 'now' : 'todo';
  const pubStatus: Status = sub?.publishedAt ? 'done' : sub?.seenAt ? 'now' : 'todo';
  const basis = conf?.basis === 'verified' ? 'proven in this browser' : services.demo ? 'simulated' : check?.weak ? 'checked here; testnet proof of work cannot make it secure' : 'as a DAPI node reports it';

  // a relay that holds the proposal past 12 confirmations without sending it is stuck: the user's own Dash Core is the way out then
  const stuck = !sub?.submittedAt && !holder?.sent && n >= GOVERNANCE_FEE_CONFIRMATIONS * 2;
  const backupHasTx = draft.backup?.milestone === 'signed' || draft.backup?.milestone === 'paid';
  const coreSubmit = (
    <>
      <p className="small">
        Once the fee transaction is in a ChainLocked block, run this in Dash Core (Window → Console, or dash-cli). Dash Core holds the proposal until the fee has{' '}
        {GOVERNANCE_FEE_CONFIRMATIONS} confirmations, then makes it live. Submitting twice is harmless.
      </p>
      <pre className="pw-code" data-testid="p-submit-cmd">
        {submitCmd}
      </pre>
      <div className="form-actions">
        <span className="vwin-copy">
          Copy <CopyButton text={submitCmd} label="Copy the gobject submit command" />
        </span>
        {!sub?.submittedAt && (
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => commit(markManualSubmit)} data-testid="p-manual-done">
            I submitted it with Dash Core
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="pw-form" data-testid="p-submit">
      {done ? <Live draft={draft} /> : <NextNote sub={sub} holder={holder} allFailed={allFailed} stuck={stuck} />}
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
              {conf ? `${formatInt(n)} confirmation${n === 1 ? '' : 's'} so far.` : check?.state === 'not-found' ? 'Not seen on the network yet.' : 'Checking…'} The network makes the
              proposal live at {GOVERNANCE_FEE_CONFIRMATIONS} (about 15 minutes after payment).
            </p>
          )}
        </Stage>
        <Stage status={subStatus} title="Submitted to the network" testId="p-stage-submitted">
          <p className="small muted">{submittedNote(sub, holder, allFailed)}</p>
        </Stage>
        <Stage status={seenStatus} title="Seen by the network" testId="p-stage-seen">
          <p className="small muted">{sub?.seenAt ? 'Another Dash node has it.' : 'Checked on another Dash node.'}</p>
        </Stage>
        <Stage status={pubStatus} title="On Governance" testId="p-stage-published">
          <p className="small muted">{sub?.publishedAt ? 'Listed on Governance.' : `Governance lists it once it has ${GOVERNANCE_FEE_CONFIRMATIONS} confirmations.`}</p>
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
            className="btn dh-btn btn-s dh-btn--sm"
            onClick={() => {
              commit(resetRelays);
              setNonce((x) => x + 1);
            }}
          >
            Try the relays again
          </button>
        </div>
      )}

      {/* the happy path failed: submitting with Dash Core is the next step, not a fallback */}
      {(allFailed || stuck) && !done && (
        <section className="pw-details" aria-labelledby="pw-core-title" data-testid="p-core-submit">
          <h3 id="pw-core-title" className="pw-h">Submit it yourself with Dash Core</h3>
          {coreSubmit}
        </section>
      )}

      {!backupHasTx && !done && (
        <p className="small" data-testid="p-backup-stale">
          Your backup file was saved before the fee was paid. A new one includes the fee transaction, so this proposal can be finished on any device.{' '}
          <BackupLink draft={draft} commit={commit} />
        </p>
      )}

      {!done && (
        <details className="pw-details dh-disclosure" data-testid="p-help">
          <summary>If something goes wrong</summary>
          <ul className="small pw-help">
            <li>
              <b>The relay is down.</b> Another relay is tried, and you can always submit it yourself with Dash Core (below). Your backup file has everything needed, on any device.
            </li>
            <li>
              <b>The fee transaction does not confirm.</b> Transactions with the standard fee confirm in the next block or two. If it stays unconfirmed for hours, it may have been
              replaced or dropped: then no fee was burned. Pay again from the Pay step after checking the transaction in a block explorer.
            </li>
            <li>
              <b>Dash Core refuses the proposal.</b> The reason is shown above. A refusal because the fee is not confirmed yet ("rejected -- try again later") clears itself;
              Governance checks the data against Core's rules before you pay, so a data refusal should not happen. If it does, keep the backup and ask for help in the Dash forum: the fee is spent.
            </li>
            <li>
              <b>You closed the page.</b> The relay submits it anyway. Come back to Create a proposal, or restore the backup file, to follow it.
            </li>
          </ul>
          {!(allFailed || stuck) && (
            <details className="pw-sub dh-disclosure" data-testid="p-core-fallback">
              <summary>Submit it yourself with Dash Core</summary>
              {coreSubmit}
            </details>
          )}
          {backupHasTx && (
            <p className="small">
              <BackupLink draft={draft} commit={commit} label="Download the backup again" />
            </p>
          )}
        </details>
      )}

      <details className="pw-details dh-disclosure" data-testid="p-submit-details">
        <summary>Details</summary>
        <dl className="kv small">
          <div>
            <dt>Proposal hash</dt>
            <dd className="break" data-testid="p-govhash">
              {lock.govHash}
            </dd>
          </div>
          <div>
            <dt>Confirmations</dt>
            <dd>
              {conf ? basis : '–'}
              {conf?.final && '; final (a ChainLock covers its block)'}. A relay sends the proposal once the fee is ChainLocked ("final" above); Dash Core makes it live at {GOVERNANCE_FEE_CONFIRMATIONS}.
            </dd>
          </div>
          <div>
            <dt>Relays</dt>
            <dd>{services.relays().map((r) => (r.base.startsWith('demo') ? r.name : relayHost(r.base))).join(', ') || 'none configured'}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{duffsToDash(BigInt(lock.paymentDuffs))} {feeUnit(services.network)} per payment</dd>
          </div>
          {done && (
            <div>
              <dt>Backup</dt>
              <dd>
                <BackupLink draft={draft} commit={commit} label="Download the backup" />
              </dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}

/** One line on top: is there anything left for the user to do? */
function NextNote({ sub, holder, allFailed, stuck }: { sub: DraftSubmission | undefined; holder: RelayReceipt | undefined; allFailed: boolean; stuck: boolean }) {
  let tone: 'ok' | 'act' | 'wait' = 'wait';
  let text: string;
  if (allFailed) {
    tone = 'act';
    text = 'No relay could take your proposal right now. Submit it with Dash Core (below), or try the relays again. The fee is not lost: it stays valid for this proposal.';
  } else if (stuck) {
    tone = 'act';
    text = 'The relay has not sent your proposal yet, though the fee has enough confirmations. Submit it yourself with Dash Core (below) to be sure; submitting twice is harmless.';
  } else if (sub?.submittedAt || holder?.sent || (holder && !holder.legacy)) {
    tone = 'ok';
    text = sub?.submittedAt || holder?.sent
      ? `Nothing more to do: the network has your proposal and makes it live at ${GOVERNANCE_FEE_CONFIRMATIONS} confirmations. You can close this page.`
      : 'Nothing more to do: a Governance relay has your proposal and sends it to the network by itself. It goes live in about 15 minutes. You can close this page.';
  } else if (holder?.legacy) {
    tone = 'act';
    text = 'Keep this page open until the proposal is sent to the network (a few minutes).';
  } else {
    text = 'Handing your proposal to a relay…';
  }
  return (
    <p className={`pw-next pw-next-${tone}`} role="status" data-testid="p-next-note" data-tone={tone}>
      {tone === 'ok' && <span aria-hidden="true">✓ </span>}
      {text}
    </p>
  );
}

/** A quiet way to save the backup again (the prominent backup box belongs to the Pay step, before any money moves). */
function BackupLink({ draft, commit, label = 'Download the updated backup' }: Pick<PayProps, 'draft' | 'commit'> & { label?: string }) {
  const mark = () => commit((d) => ({ ...d, backup: { at: Date.now(), milestone: backupMilestone(d) } }));
  return (
    <span className="pw-backup-link">
      <button
        type="button"
        className="btn dh-btn btn-s dh-btn--sm"
        data-testid="p-backup-download"
        onClick={() => {
          downloadBackup(draft);
          mark();
        }}
      >
        {label}
      </button>{' '}
      {/* browsers that block downloads (in-app webviews) can still keep the text */}
      <span className="vwin-copy small" onClick={mark}>
        or copy it <CopyButton text={backupFile(draft).text} label="Copy the backup" />
      </span>
    </span>
  );
}

/** What the "Submitted to the network" stage says: who submitted it, who holds it, or why nobody does. */
function submittedNote(sub: DraftSubmission | undefined, holder: RelayReceipt | undefined, allFailed: boolean): string {
  if (sub?.submittedAt) {
    if (sub.via === 'manual') return 'You submitted it with Dash Core.';
    return sub.via === 'network' ? 'The network has it.' : `Submitted by ${sub.via}.`;
  }
  const live = `The network makes it live after ${GOVERNANCE_FEE_CONFIRMATIONS} confirmations (about 15 minutes).`;
  if (holder?.sent) return `${holder.name} sent it to the network once the fee was final. ${live}`;
  if (holder?.legacy) return `${holder.name} will be asked to send it once the fee is final (a few minutes); keep this page open until then.`;
  if (holder) return `${holder.name} holds it and sends it to the network once the fee is final (usually within a few minutes).`;
  return allFailed ? 'No relay could take it.' : 'Handing it to a relay…';
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
          <b>{lock.name}</b> is on the network and in Governance. Masternodes can vote on it now.
        </p>
        <div className="vwin-actions">
          <Link className="btn dh-btn btn-s dh-btn--sm btn-primary dh-btn--primary" to={`/p/h/${lock.govHash}`} data-testid="p-view">
            View it in Governance
          </Link>
          <Link className="btn dh-btn btn-s dh-btn--sm" to={`/p/h/${lock.govHash}#ownership`} data-testid="p-claim">
            Write the description
          </Link>
        </div>
        <p className="small muted">
          {govhubOwner ? (
            <>
              Its link names your identity <IdentityName id={govhubOwner} />. On the proposal page, accept ownership while signed in as it, then publish the
              description voters read.
            </>
          ) : (
            'Claim it on the proposal page with a signature from the payment address, then publish the description voters read.'
          )}
        </p>
      </div>
    </section>
  );
}
