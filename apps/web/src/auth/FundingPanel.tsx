// Funding screen: QR for the one-time deposit address, live status, IS-lock, done. The address is only shown once the DAPI
// deposit watcher is subscribed (runFunding calls onUpdate after the streams are live), because IS-locks are never replayed.
// A create whose lock can never create an account (too small for Platform, LockTooSmallError; or the phrase's identity at that index
// already exists, KeyConflictError) is offered as a top-up of an existing identity instead. Anything else stuck has the Recover tool.
import {
  discoverIdentities, identifierBytes, KeyConflictError, LockTooSmallError, nextCreateIndex, runFunding, type FoundIdentity, type FundingView, type SeedWallet, type Session,
} from '@govhub/auth';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from './context.tsx';
import { useLeaveWarning } from './leaveWarning.ts';
import { Qr } from './Qr.tsx';
import { RecoverLink } from './RecoverLink.tsx';
import { errorText, formatDuffs } from './runtime.ts';

export interface FundingPanelProps {
  kind: 'create' | 'topup';
  wallet: SeedWallet | null;
  identityIndex: number;
  topUp?: { identityId: string; index: number };
  /** Seedless top-ups: the key-paste session whose key derives the one-time key. */
  session?: Session;
  /** `identityIndex`: where the identity was made (a new payment after a too-small one moves to a later index). */
  onDone(identityId: string, identityIndex: number): void;
  /**
   * Called once per run when the deposit watcher is live (the first view in state 'awaiting-deposit': runFunding reports it only
   * after subscribing). The starter pays the address only then, because IS-locks are never replayed.
   */
  onAwaitingDeposit?(address: string): void;
  /** Shown instead of the QR code and payment text while waiting for the deposit (the starter: the faucet pays it). */
  deposit?: ReactNode;
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
  const { dapi, platform, store, closeSheet, network } = useAuth();
  const [view, setView] = useState<FundingView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  /** The existing identity a too-small create lock is being added to. */
  const [recoverInto, setRecoverInto] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  /** The last identity id tried, kept for the form when it comes back with a reason. */
  const [lastTarget, setLastTarget] = useState('');
  /** A new account paid for at this index, after a payment too small to create one. */
  const [fresh, setFresh] = useState<number | null>(null);
  const done = useRef(p.onDone);
  done.current = p.onDone;
  // an asset lock in flight: closing the tab now loses its IS-lock (a ChainLock proof then takes minutes)
  useLeaveWarning(!error && !!view && (view.state === 'locking' || view.state === 'locked' || view.state === 'registering'));
  const awaiting = useRef(p.onAwaitingDeposit);
  awaiting.current = p.onAwaitingDeposit;

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    let live = false;
    const onUpdate = (v: FundingView) => {
      if (ac.signal.aborted) return;
      setView(v);
      if (v.state === 'awaiting-deposit' && !live) {
        live = true;
        awaiting.current?.(v.address);
      }
    };
    (async () => {
      const port = await platform();
      const r = await runFunding({
        wallet: p.wallet, dapi: dapi(), platform: port, store, kind: p.kind, identityIndex: p.identityIndex, topUp: p.topUp, session: p.session,
        recoverInto: recoverInto ?? undefined, signal: ac.signal, onUpdate,
      });
      if (ac.signal.aborted) return;
      // a recovery is saved in the record: a later resume (also without recoverInto) finishes it
      if (r.record.recoveredInto) setRecovered(r.identityId);
      else done.current(r.identityId, r.record.identityIndex);
    })().catch((e) => {
      if (ac.signal.aborted) return;
      if (recoverInto && !(e instanceof LockTooSmallError || e instanceof KeyConflictError)) {
        // e.g. no such identity: back to the choice, with the reason
        setRecoverError(errorText(e));
        setRecoverInto(null);
      } else setError(e);
    });
    return () => ac.abort();
    // The funding is keyed by what it funds; a new attempt is an explicit retry.
  }, [p.kind, p.identityIndex, p.topUp?.identityId, p.topUp?.index, attempt, recoverInto]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => {
    setRecoverError(null);
    setAttempt((a) => a + 1);
  };
  const payAgain =
    p.kind === 'create' && p.wallet
      ? () => {
          try {
            setFresh(nextCreateIndex(store, p.wallet!));
          } catch (e) {
            setRecoverError(errorText(e));
          }
        }
      : undefined;
  const startRecovery = (identityId: string) => {
    setRecoverError(null);
    setLastTarget(identityId);
    setRecoverInto(identityId);
  };
  let errorBox: ReactNode = null;
  if (error instanceof LockTooSmallError)
    errorBox = <TooSmall error={error} offerTopUp={p.kind === 'create' && error.canTopUp} wallet={p.wallet} problem={recoverError} initialId={lastTarget} onTopUp={startRecovery} onPayAgain={payAgain} />;
  else if (error instanceof KeyConflictError && p.kind === 'create')
    errorBox = <TooSmall error={error} offerTopUp wallet={p.wallet} problem={recoverError} initialId={lastTarget} onTopUp={startRecovery} />;
  else if (error) errorBox = <ErrorBox text={(recoverError ? `${recoverError} ` : '') + errorText(error)} retry={retry} onRecover={closeSheet} />;

  // a new payment at another index: another address, which a starter token (bound to the first one) cannot pay
  if (fresh !== null) return <FundingPanel key={fresh} {...p} identityIndex={fresh} onAwaitingDeposit={undefined} deposit={undefined} />;
  if (recovered) {
    return (
      <div className="funding" data-state="recovered">
        <p className="notice" role="status" data-testid="recovered">
          Done: the payment was added to identity <span className="break">{recovered}</span>. Sign in with that identity to use it.
        </p>
        <button type="button" className="btn btn-primary" onClick={closeSheet}>
          Close
        </button>
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
      {view.state === 'awaiting-deposit' && p.deposit}
      {view.state === 'awaiting-deposit' && !p.deposit && (
        <div className="deposit">
          <Qr text={view.uri} label={`Dash payment request to ${view.address}`} />
          <div className="deposit-text">
            {seenDuffs > 0n && view.remainingDuffs > 0n ? (
              <p data-testid="underpaid">
                Received <b>{formatDuffs(seenDuffs)}</b>, still need <b>{formatDuffs(view.remainingDuffs)}</b>. Send the rest to the same address; the QR code asks
                for just that.
              </p>
            ) : seenDuffs > 0n ? (
              <p data-testid="enough">
                Received <b>{formatDuffs(seenDuffs)}</b>: that is enough. Nothing more to send.
              </p>
            ) : (
              <p>
                Send at least <b>{formatDuffs(view.minDuffs)}</b> to this one-time address. Any Dash wallet works; one payment is best.
              </p>
            )}
            <p className="address" data-testid="deposit-address">
              {view.address}
            </p>
            {network && network !== 'mainnet' && (
              <p className="small" data-testid="deposit-network">
                This is a <b>{network}</b> address: send {network} DASH only. A mainnet wallet refuses it.
              </p>
            )}
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
            <p className="muted small" data-testid="deposit-rules">
              What arrives before your payment is locked becomes Platform credits; anything above the minimum stays in your account's balance. A payment that
              arrives after that, or one too small to count, stays at this address: Settings, Recover funds, can send it to any Dash address or add it to an
              account. This page is watching the network; keep it open until it finishes.
            </p>
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
        <div className="notice-box" role="status" data-testid="late-payment">
          <p>
            {formatDuffs(view.lateDuffs)} arrived at {view.address} after the asset lock was made. It was not used and is still there; only your recovery phrase
            (or key) controls that address, and ordinary wallets don't show it.
          </p>
          {view.state === 'done' ? (
            <RecoverLink onClick={closeSheet}>Recover it: send it to a Dash address or add it to an account</RecoverLink>
          ) : (
            <p className="small">Once this finishes, Settings, Recover funds can send it to a Dash address or add it to an account.</p>
          )}
        </div>
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

/** A lock Platform can never register as this create (permanent: no retry). It can still top up an existing identity. */
function TooSmall(p: {
  error: LockTooSmallError | KeyConflictError;
  offerTopUp: boolean;
  wallet: SeedWallet | null;
  problem: string | null;
  initialId: string;
  onTopUp(identityId: string): void;
  /** Start over with a new payment for a new account (at the next free identity index). */
  onPayAgain?(): void;
}) {
  const { error, offerTopUp, problem, onTopUp } = p;
  const { platform } = useAuth();
  const [open, setOpen] = useState(!!problem);
  const [id, setId] = useState(p.initialId);
  const [bad, setBad] = useState(false);
  // This phrase's own identities: one click, no id to copy (and no stranger's id by mistake).
  const [mine, setMine] = useState<FoundIdentity[]>([]);
  useEffect(() => {
    if (!offerTopUp || !p.wallet) return;
    let live = true;
    platform()
      .then((port) => discoverIdentities(p.wallet!, port))
      .then((f) => live && setMine(f), () => {});
    return () => void (live = false);
  }, [offerTopUp, p.wallet, platform]);
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
      {offerTopUp && mine.length > 0 && (
        <div className="form-actions">
          {mine.map((f) => (
            <button key={f.identityId} type="button" className="btn" onClick={() => onTopUp(f.identityId)} data-testid="recover-mine">
              Top up this phrase's identity #{f.identityIndex} ({f.identityId.slice(0, 8)}…)
            </button>
          ))}
        </div>
      )}
      {offerTopUp &&
        (open ? (
          <form className="form" onSubmit={submit}>
            <label>
              Identity to top up
              <input value={id} onChange={(e) => {
                  setId(e.target.value);
                  setBad(false);
                }} placeholder="identity id (base58)" spellCheck={false} autoComplete="off" data-testid="recover-identity" />
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
            Use these funds to top up {mine.length ? 'another' : 'an existing'} identity
          </button>
        ))}
      {p.onPayAgain && p.error instanceof LockTooSmallError && p.error.kind === 'create' && (
        <button type="button" className="btn btn-quiet" onClick={p.onPayAgain} data-testid="pay-again">
          Pay again for a new account
        </button>
      )}
    </div>
  );
}

function ErrorBox({ text, retry, onRecover }: { text: string; retry(): void; onRecover(): void }) {
  return (
    <div className="auth-error" role="alert">
      <p>{text}</p>
      <p className="muted small">
        Your progress is saved in this browser. Retrying continues where it stopped; nothing is paid twice. On another device, or if this keeps failing,{' '}
        <RecoverLink onClick={onRecover}>Recover funds</RecoverLink> finds the payment from your recovery phrase alone.
      </p>
      <button type="button" className="btn" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
