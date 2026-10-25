// Funding screen: QR for the one-time deposit address, live status, IS-lock, done. The address is only shown once the DAPI
// deposit watcher is subscribed (runFunding calls onUpdate after the streams are live), because IS-locks are never replayed.
// A create whose lock is too small for Platform (LockTooSmallError, permanent) is offered as a top-up of an existing identity instead.
import { identifierBytes, LockTooSmallError, runFunding, type FundingView, type SeedWallet, type Session } from '@govhub/auth';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from './context.tsx';
import { Qr } from './Qr.tsx';
import { errorText, formatDuffs } from './runtime.ts';

export interface FundingPanelProps {
  kind: 'create' | 'topup';
  wallet: SeedWallet | null;
  identityIndex: number;
  topUp?: { identityId: string; index: number };
  /** Seedless top-ups: the key-paste session whose key derives the one-time key. */
  session?: Session;
  onDone(identityId: string): void;
}

const STEPS: Array<{ id: FundingView['state'] | 'is'; label: string }> = [
  { id: 'awaiting-deposit', label: 'Waiting for your payment' },
  { id: 'locking', label: 'Payment received' },
  { id: 'locked', label: 'Asset lock sent to the network' },
  { id: 'is', label: 'InstantSend lock' },
  { id: 'registering', label: 'Registering on Platform' },
  { id: 'done', label: 'Done' },
];
const ORDER: FundingView['state'][] = ['awaiting-deposit', 'locking', 'locked', 'registering', 'done'];

export function FundingPanel(p: FundingPanelProps) {
  const { dapi, platform, store } = useAuth();
  const [view, setView] = useState<FundingView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  /** The existing identity a too-small create lock is being added to. */
  const [recoverInto, setRecoverInto] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const done = useRef(p.onDone);
  done.current = p.onDone;

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    (async () => {
      const port = await platform();
      const r = await runFunding({
        wallet: p.wallet, dapi: dapi(), platform: port, store, kind: p.kind, identityIndex: p.identityIndex, topUp: p.topUp, session: p.session,
        recoverInto: recoverInto ?? undefined, signal: ac.signal, onUpdate: (v) => !ac.signal.aborted && setView(v),
      });
      if (ac.signal.aborted) return;
      // a recovery is saved in the record: a later resume (also without recoverInto) finishes it
      if (r.record.recoveredInto) setRecovered(r.identityId);
      else done.current(r.identityId);
    })().catch((e) => {
      if (ac.signal.aborted) return;
      if (recoverInto && !(e instanceof LockTooSmallError)) {
        // e.g. no such identity: back to the choice, with the reason
        setRecoverError(errorText(e));
        setRecoverInto(null);
      } else setError(e);
    });
    return () => ac.abort();
    // The funding is keyed by what it funds; a new attempt is an explicit retry.
  }, [p.kind, p.identityIndex, p.topUp?.identityId, p.topUp?.index, attempt, recoverInto]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => setAttempt((a) => a + 1);
  const errorBox = error ? (
    error instanceof LockTooSmallError ? (
      <TooSmall error={error} offerTopUp={p.kind === 'create' && error.canTopUp} problem={recoverError} onTopUp={(id) => (setRecoverError(null), setRecoverInto(id))} />
    ) : (
      <ErrorBox text={errorText(error)} retry={retry} />
    )
  ) : null;

  if (recovered) {
    return (
      <div className="funding" data-state="recovered">
        <p className="notice" role="status" data-testid="recovered">
          Done: the payment was added to identity <span className="break">{recovered}</span>. Sign in with that identity to use it.
        </p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="funding" data-state="connecting">
        {errorBox ?? <p className="muted"><span className="spinner" aria-hidden="true" /> Connecting to the Dash network…</p>}
      </div>
    );
  }
  const seenDuffs = view.receivedDuffs + view.pendingDuffs;
  const at = ORDER.indexOf(view.state);
  const status = (id: (typeof STEPS)[number]['id']): 'done' | 'now' | 'todo' => {
    if (id === 'is') return view.isLocked ? 'done' : view.state === 'locked' ? 'now' : at > ORDER.indexOf('locked') ? 'done' : 'todo';
    const i = ORDER.indexOf(id);
    return view.state === 'done' || i < at ? 'done' : i === at ? 'now' : 'todo';
  };
  return (
    <div className="funding" data-state={view.state} aria-live="polite">
      {view.state === 'awaiting-deposit' && (
        <div className="deposit">
          <Qr text={view.uri} label={`Dash payment request to ${view.address}`} />
          <div className="deposit-text">
            {seenDuffs > 0n && view.remainingDuffs > 0n ? (
              <p data-testid="underpaid">
                Received <b>{formatDuffs(seenDuffs)}</b>, still need <b>{formatDuffs(view.remainingDuffs)}</b>. Send the rest to the same address; the QR code asks
                for just that.
              </p>
            ) : (
              <p>
                Send at least <b>{formatDuffs(view.minDuffs)}</b> to this one-time address. Any Dash wallet works.
              </p>
            )}
            <p className="address" data-testid="deposit-address">
              {view.address}
            </p>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(view.address)}>
                Copy address
              </button>
              <a className="btn" href={view.uri}>
                Open in wallet
              </a>
            </div>
            {view.pendingDuffs > 0n && (
              <p className="muted small" data-testid="pending-deposit">
                {formatDuffs(view.pendingDuffs)} seen; it counts once InstantSend locks it or it is in a block.
              </p>
            )}
            <p className="muted small">Everything you send is locked for Platform credits. This page is watching the network; keep it open until it finishes.</p>
          </div>
        </div>
      )}
      <ol className="fund-steps">
        {STEPS.map((s) => (
          <li key={s.id} data-status={status(s.id)}>
            <span className="fund-dot" aria-hidden="true" />
            {s.label}
            {s.id === 'is' && view.proofKind === 'chain' && <span className="muted small"> (not seen; using a ChainLock instead)</span>}
          </li>
        ))}
      </ol>
      {view.note && <p className="muted small" data-testid="funding-note">{view.note}</p>}
      {view.lateDuffs > 0n && (
        <p className="notice-box" role="status">
          {formatDuffs(view.lateDuffs)} arrived at {view.address} after the asset lock was made. It was not used and is still there; your
          recovery phrase (or key) controls that address. Use it in a later top-up or move it with a wallet.
        </p>
      )}
      {view.lockTxid && (
        <p className="muted small break">
          Asset lock transaction {view.lockTxid}
          {view.identityId && p.kind === 'create' && <> · identity {view.identityId}</>}
        </p>
      )}
      {errorBox}
    </div>
  );
}

/** A lock Platform can never register (permanent: no retry). A create's lock can still top up an existing identity. */
function TooSmall({ error, offerTopUp, problem, onTopUp }: { error: LockTooSmallError; offerTopUp: boolean; problem: string | null; onTopUp(identityId: string): void }) {
  const [open, setOpen] = useState(!!problem);
  const [id, setId] = useState('');
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = id.trim();
    try {
      identifierBytes(v);
    } catch {
      return setBad(true);
    }
    onTopUp(v);
  };
  return (
    <div className="auth-error" role="alert" data-testid="lock-too-small">
      <p>{error.message}</p>
      {offerTopUp &&
        (open ? (
          <form className="form" onSubmit={submit}>
            <label>
              Identity to top up
              <input value={id} onChange={(e) => (setId(e.target.value), setBad(false))} placeholder="identity id (base58)" spellCheck={false} autoComplete="off" data-testid="recover-identity" />
            </label>
            {bad && <p className="error small">That is not an identity id.</p>}
            {problem && !bad && <p className="error small">{problem}</p>}
            <p className="muted small">Anyone can top up any identity: check the id. The whole amount goes to that identity's balance.</p>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={!id.trim()}>
                Top up this identity
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Use these funds to top up an existing identity
          </button>
        ))}
    </div>
  );
}

function ErrorBox({ text, retry }: { text: string; retry(): void }) {
  return (
    <div className="auth-error" role="alert">
      <p>{text}</p>
      <p className="muted small">Your progress is saved in this browser. Retrying continues where it stopped; nothing is paid twice.</p>
      <button type="button" className="btn" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
