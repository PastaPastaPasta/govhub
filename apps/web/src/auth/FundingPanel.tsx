// Funding screen: QR for the one-time deposit address, live status, IS-lock, done. The address is only shown once the DAPI
// deposit watcher is subscribed (runFunding calls onUpdate after the streams are live), because IS-locks are never replayed.
import { runFunding, type FundingView, type SeedWallet } from '@govhub/auth';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from './context.tsx';
import { Qr } from './Qr.tsx';
import { errorText, formatDuffs } from './runtime.ts';

export interface FundingPanelProps {
  kind: 'create' | 'topup';
  wallet: SeedWallet | null;
  identityIndex: number;
  topUp?: { identityId: string; index: number };
  sessionKey?: Uint8Array;
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
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = useRef(p.onDone);
  done.current = p.onDone;

  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    (async () => {
      const port = await platform();
      const r = await runFunding({
        wallet: p.wallet, dapi: dapi(), platform: port, store, kind: p.kind, identityIndex: p.identityIndex, topUp: p.topUp, sessionKey: p.sessionKey,
        signal: ac.signal, onUpdate: (v) => !ac.signal.aborted && setView(v),
      });
      if (!ac.signal.aborted) done.current(r.identityId);
    })().catch((e) => !ac.signal.aborted && setError(errorText(e)));
    return () => ac.abort();
    // The funding is keyed by what it funds; a new attempt is an explicit retry.
  }, [p.kind, p.identityIndex, p.topUp?.identityId, p.topUp?.index, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => setAttempt((a) => a + 1);

  if (!view) {
    return (
      <div className="funding" data-state="connecting">
        {error ? <ErrorBox text={error} retry={retry} /> : <p className="muted"><span className="spinner" aria-hidden="true" /> Connecting to the Dash network…</p>}
      </div>
    );
  }
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
            <p>
              Send at least <b>{formatDuffs(view.minDuffs)}</b> to this one-time address. Any Dash wallet works.
            </p>
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
            {view.receivedDuffs > 0n && <p className="notice">Received {formatDuffs(view.receivedDuffs)} so far.</p>}
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
      {view.lockTxid && (
        <p className="muted small break">
          Asset lock transaction {view.lockTxid}
          {view.identityId && p.kind === 'create' && <> · identity {view.identityId}</>}
        </p>
      )}
      {error && <ErrorBox text={error} retry={retry} />}
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
