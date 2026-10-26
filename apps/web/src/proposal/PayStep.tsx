// Step 4: the fee. First the backup file (the fee is burned once paid, so the way back has to exist before any money moves), then
// one of two ways to pay: from any wallet through a one-time deposit address this browser watches (path b), or with Dash Core's own
// `gobject prepare` (path a), whose txid the browser then checks over DAPI.
import {
  addressOf, coinType, newCollateralFunding, proposalDepositKey, proposalDepositPath, publicKeyOf, wipe, type CollateralFundingView, type DepositKey, type DepositKeySource,
} from '@govhub/auth';
import { duffsToDash, GOV_CHAIN_PARAMS, GOVERNANCE_PROPOSAL_FEE_DUFFS, gobjectPrepareCommand, isCollateralChangeAddress } from '@govhub/verify';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { useAuth } from '../auth/context.tsx';
import { Qr } from '../auth/Qr.tsx';
import { errText } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { CopyButton } from '../ui/vote/common.tsx';
import { backupFile, backupMilestone, draftStore, feeUnit, nextDepositIndex, payNowProblem, type BackupMilestone, type ProposalDraft } from './draft.ts';
import { demoDepositKey, demoDepositSource, type CollateralCheck, type WizardServices } from './services.ts';

export interface PayProps {
  draft: ProposalDraft;
  /** Saves synchronously and throws when it could not (nothing is paid then). */
  commit(f: (d: ProposalDraft) => ProposalDraft): ProposalDraft;
  services: WizardServices;
}

export function downloadBackup(d: ProposalDraft): void {
  const f = backupFile(d);
  const url = URL.createObjectURL(new Blob([f.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BACKUP_HAS_TX = 'It now includes the fee transaction. With it, this proposal can be submitted from any device, or with Dash Core, even if this browser forgets it.';
const BACKUP_WHY: Record<BackupMilestone, string> = {
  locked: 'Once the fee is paid it is gone. This file holds everything needed to submit the proposal from any device, or with Dash Core, even if this browser forgets it. It contains no keys.',
  deposit: 'It now includes the deposit address, so a payment to it can be found from any device.',
  signed: BACKUP_HAS_TX,
  paid: BACKUP_HAS_TX,
};

export function BackupBox({ draft, commit, compact = false }: Pick<PayProps, 'draft' | 'commit'> & { compact?: boolean }) {
  const [showText, setShowText] = useState(false);
  const mark = () => commit((d) => ({ ...d, backup: { at: Date.now(), milestone: backupMilestone(d) } }));
  const milestone = backupMilestone(draft);
  // a backup from an earlier step lacks what came after (the deposit address, the signed fee transaction, its txid)
  const done = draft.backup?.milestone === milestone;
  return (
    <section className={`pw-backup${done ? ' pw-backup-done' : ''}`} aria-labelledby="pw-backup-title" data-testid="p-backup">
      <h3 id="pw-backup-title">{done ? '✓ Backup saved' : draft.backup ? 'Save the backup again' : 'First, save a backup'}</h3>
      {!compact && !done && <p className="small">{BACKUP_WHY[milestone]}</p>}
      <div className="form-actions">
        <button
          type="button"
          className={done ? 'btn btn-s' : 'btn btn-primary'}
          data-testid="p-backup-download"
          onClick={() => {
            downloadBackup(draft);
            mark();
          }}
        >
          Download backup
        </button>
        <button type="button" className="btn btn-s btn-quiet" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Hide the text' : "Can't download? Copy it instead"}
        </button>
      </div>
      {showText && (
        <div className="pw-backup-text">
          <textarea readOnly rows={6} value={backupFile(draft).text} aria-label="Backup file contents" />
          <span className="vwin-copy" onClick={mark}>
            Copy <CopyButton text={backupFile(draft).text} label="Copy the backup" />
          </span>
        </div>
      )}
    </section>
  );
}

export function PayStep({ draft, commit, services }: PayProps) {
  const { gov, source } = useApp();
  const ready = !!draft.backup;
  const method = draft.payment?.method;
  const problem = payNowProblem(draft.lock!, gov.height.data?.value ?? null, source.now(), GOV_CHAIN_PARAMS[services.network].maturityWindow);
  if (problem && !draft.payment?.funding) {
    return (
      <div className="pw-form" data-testid="p-pay">
        <p className="error" role="alert" data-testid="p-pay-too-late">
          Don't pay for this proposal: {problem} Nothing has been paid. Start a new proposal (it is free until you pay) with later dates.
        </p>
        <BackupBox draft={draft} commit={commit} />
      </div>
    );
  }
  return (
    <div className="pw-form" data-testid="p-pay">
      <BackupBox draft={draft} commit={commit} />
      <section className={`pw-methods${ready ? '' : ' pw-locked'}`} aria-labelledby="pw-pay-title" aria-disabled={!ready}>
        <h3 id="pw-pay-title">Pay the {duffsToDash(GOVERNANCE_PROPOSAL_FEE_DUFFS)} {feeUnit(services.network)} fee</h3>
        {!ready && <p className="muted small">Save the backup first.</p>}
        {ready && !method && (
          <div className="pw-choices">
            <button type="button" className="choice" data-testid="p-pay-browser" onClick={() => commit((d) => ({ ...d, payment: { method: 'browser' } }))}>
              <b>From any Dash wallet</b>
              <span className="small muted">Scan a QR code with DashPay, Dash Core or any wallet. This page builds the fee transaction and sends what is left back to you.</span>
            </button>
            <button type="button" className="choice" data-testid="p-pay-core" onClick={() => commit((d) => ({ ...d, payment: { method: 'core' } }))}>
              <b>With Dash Core</b>
              <span className="small muted">Run one command in Dash Core's console with a funded wallet, then paste the transaction id here.</span>
            </button>
          </div>
        )}
        {ready && method === 'browser' && <BrowserPay draft={draft} commit={commit} services={services} />}
        {ready && method === 'core' && <CorePay draft={draft} commit={commit} services={services} />}
        {ready && method && !draft.payment?.funding && (
          <button type="button" className="btn btn-s btn-quiet" onClick={() => commit((d) => ({ ...d, payment: undefined }))} data-testid="p-pay-change">
            Choose another way to pay
          </button>
        )}
      </section>
    </div>
  );
}

/** The deposit key for this draft from whoever is signed in (seed, pasted key, or the demo), and its default refund address. */
function useDepositSigner(services: WizardServices) {
  const { session: forumSession } = useForum();
  const auth = useAuth();
  const { source } = useApp();
  const network = services.network;
  const s = auth.session;
  return useMemo(() => {
    if (services.demo) {
      const id = forumSession?.identityId;
      if (!id) return { error: 'sign-in' as const };
      const key = (src: DepositKeySource) => demoDepositKey(id, src.index);
      const fresh = (index: number) => demoDepositSource(id, index);
      return { key, fresh, refund: addressOf(demoDepositKey(id, 999).publicKey, network), refundLabel: 'your demo address' };
    }
    if (!s || s.ended) return { error: 'sign-in' as const };
    if (s.network !== network || source.registry.platformNetwork !== network) return { error: 'network' as const };
    const secret = { wallet: s.wallet, sessionKey: s.privateKey };
    const key = (src: DepositKeySource): DepositKey => proposalDepositKey(src, secret, network);
    const fresh = (index: number): DepositKeySource => (s.wallet ? { kind: 'seed', index } : { kind: 'session', index, identityId: s.identityId });
    let refund: string;
    let refundLabel: string;
    if (s.wallet) {
      const k = s.wallet.derive(`m/44'/${coinType(network)}'/0'/0/0`);
      refund = addressOf(k.publicKey, network);
      wipe(k.privateKey);
      refundLabel = "your recovery phrase's first wallet address (m/44'/…/0'/0/0, which DashPay and Dash Core find when they restore it)";
    } else {
      refund = addressOf(publicKeyOf(s.privateKey), network);
      refundLabel = 'the address of the key you signed in with (import that key into a wallet to spend it). That key is public on Dash Platform, so this ties the payment to your identity on chain; enter another address to avoid that';
    }
    return { key, fresh, refund, refundLabel };
  }, [services.demo, forumSession?.identityId, s, network, source.registry.platformNetwork]);
}

function BrowserPay({ draft, commit, services }: PayProps) {
  const signer = useDepositSigner(services);
  const funding = draft.payment?.funding;
  const [refund, setRefund] = useState('');
  const [view, setView] = useState<CollateralFundingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const network = services.network;
  const { gov, source } = useApp();
  // read when the fee transaction is about to be built (a payment can arrive much later than the address was shown)
  const problemRef = useRef<() => string | null>(() => null);
  problemRef.current = () => payNowProblem(draft.lock!, gov.height.data?.value ?? null, source.now(), GOV_CHAIN_PARAMS[network].maturityWindow);

  const keyMismatch = useMemo(() => {
    if (!funding || 'error' in signer) return false;
    const k = signer.key(funding.source);
    try {
      return addressOf(k.publicKey, network) !== funding.address;
    } finally {
      wipe(k.privateKey);
    }
  }, [funding, signer, network]);

  // run (or resume) the deposit watcher and the collateral, once a record exists and the signer matches it
  useEffect(() => {
    if (!funding || (funding.state === 'broadcast' && draft.payment?.txid)) return;
    if ('error' in signer || keyMismatch) return;
    const ac = new AbortController();
    const key = signer.key(funding.source);
    setError(null);
    services
      .fundCollateral({
        record: structuredClone(funding),
        key,
        signal: ac.signal,
        guard: () => problemRef.current(),
        onUpdate: (v) => !ac.signal.aborted && setView(v),
        save: (r) => void commitRef.current((d) => ({ ...d, payment: { ...d.payment!, funding: structuredClone(r) } })),
      })
      .then(({ txid }) => {
        if (!ac.signal.aborted) commitRef.current((d) => ({ ...d, payment: { ...d.payment!, txid } }));
      })
      .catch((e) => !ac.signal.aborted && setError(errText(e)))
      .finally(() => wipe(key.privateKey));
    return () => ac.abort();
    // the record changes on every save; the run is keyed by its address (and an explicit retry)
  }, [funding?.address, keyMismatch, attempt, 'error' in signer]); // eslint-disable-line react-hooks/exhaustive-deps

  if ('error' in signer) {
    return signer.error === 'network' ? (
      <p className="notice-box small" data-testid="p-pay-network">
        Paying from the browser needs a network profile whose Platform and Core networks match (Testnet or Mainnet in Settings). Pay with Dash Core instead.
      </p>
    ) : (
      <div className="notice-box" data-testid="p-pay-signin">
        <p className="small">
          Paying from the browser needs a govhub sign-in: the one-time deposit address is derived from your recovery phrase (or signed-in key), so whatever is sent to it can
          always be recovered, on any device.
        </p>
        <button type="button" className="btn btn-s" onClick={openSignIn}>
          Sign in
        </button>
      </div>
    );
  }
  if (funding && keyMismatch) {
    return (
      <p className="error" data-testid="p-pay-wrong-key">
        This payment was started with another sign-in (deposit address {funding.address}). Sign in with the same {funding.source.kind === 'seed' ? 'recovery phrase' : 'key'} to continue it.
      </p>
    );
  }
  if (!funding) {
    const value = refund || signer.refund;
    const refundOk = isCollateralChangeAddress(value.trim(), network);
    const start = () => {
      setError(null);
      try {
        const drafts = draftStore(localStorage).list(network);
        const index = nextDepositIndex(drafts, (i) => {
          const k = signer.key(signer.fresh(i));
          try {
            return addressOf(k.publicKey, network);
          } finally {
            wipe(k.privateKey);
          }
        });
        const depositSource = signer.fresh(index);
        const k = signer.key(depositSource);
        try {
          const rec = newCollateralFunding({ network, source: depositSource, key: k, govHashRaw: draft.lock!.govHashRaw, refundAddress: value.trim() });
          commit((d) => ({ ...d, payment: { method: 'browser', funding: rec } }));
        } finally {
          wipe(k.privateKey);
        }
      } catch (e) {
        setError(errText(e));
      }
    };
    return (
      <div className="pw-form">
        <div className="pw-field">
          <label htmlFor="p-refund">Send what is left over to</label>
          <input id="p-refund" data-testid="p-refund" value={value} spellCheck={false} autoComplete="off" onChange={(e) => setRefund(e.target.value)} />
          {refundOk ? (
            <p className="muted small">{value === signer.refund ? `Default: ${signer.refundLabel}.` : 'Your address.'} Anything above the fee comes back here in the same transaction.</p>
          ) : (
            <p className="error small">Enter an ordinary Dash address of this network (one starting with {network === 'mainnet' ? 'X' : 'y'}): Dash Core refuses a fee transaction that pays any other kind.</p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={!refundOk} onClick={start} data-testid="p-pay-start">
            Show the payment address
          </button>
        </div>
      </div>
    );
  }
  return <Deposit draft={draft} view={view} error={error} retry={() => setAttempt((a) => a + 1)} services={services} />;
}

const STEPS: Array<{ id: string; label: string }> = [
  { id: 'awaiting-deposit', label: 'Waiting for your payment' },
  { id: 'building', label: 'Payment received; fee transaction built and saved' },
  { id: 'broadcast', label: 'Fee transaction sent to the network' },
];

function Deposit({ draft, view, error, retry, services }: { draft: ProposalDraft; view: CollateralFundingView | null; error: string | null; retry(): void; services: WizardServices }) {
  const f = draft.payment!.funding!;
  const unit = feeUnit(services.network);
  const fmt = (d: bigint) => `${duffsToDash(d)} ${unit}`;
  const at = STEPS.findIndex((s) => s.id === (view?.state ?? f.state));
  if (!view && !error) {
    return (
      <p className="muted" data-testid="p-pay-connecting">
        <span className="spinner" aria-hidden="true" /> Connecting to the Dash network…
      </p>
    );
  }
  const seen = view ? view.receivedDuffs + view.pendingDuffs : 0n;
  return (
    <div className="funding" aria-live="polite" data-testid="p-deposit" data-state={view?.state ?? f.state}>
      {view && view.state === 'awaiting-deposit' && (
        <div className="deposit">
          <Qr text={view.uri} label={`Dash payment request to ${view.address}`} />
          <div className="deposit-text">
            {seen > 0n && view.remainingDuffs > 0n ? (
              <p data-testid="p-underpaid">
                Received <b>{fmt(seen)}</b>, still need <b>{fmt(view.remainingDuffs)}</b>. Send the rest to the same address.
              </p>
            ) : seen > 0n ? (
              <p>
                Received <b>{fmt(seen)}</b>: enough. Waiting for InstantSend or a block.
              </p>
            ) : (
              <p>
                Send at least <b data-testid="p-deposit-amount">{fmt(view.neededDuffs)}</b> to this one-time address. More is fine: the rest comes back to {f.refundAddress}.
              </p>
            )}
            <p className="muted small">Keep this page open until the fee transaction is sent (a few seconds after your payment is confirmed by InstantSend).</p>
          </div>
        </div>
      )}
      {view && view.state === 'awaiting-deposit' && (
        <div className="deposit-addr">
          <p className="address" data-testid="p-deposit-address">
            {view.address}
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-s" onClick={() => navigator.clipboard?.writeText(view.address)}>
              Copy address
            </button>
            <a className="btn btn-s" href={view.uri}>
              Open in wallet
            </a>
            {services.simulatePayment && (
              <button type="button" className="btn btn-s btn-primary" onClick={services.simulatePayment} data-testid="p-demo-pay">
                Simulate the payment (demo)
              </button>
            )}
          </div>
        </div>
      )}
      <ol className="fund-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} data-status={f.state === 'broadcast' || i < at ? 'done' : i === at ? 'now' : 'todo'}>
            <span className="fund-dot" aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ol>
      {view?.note && <p className="muted small">{view.note}</p>}
      {f.tx && (
        <p className="muted small break" data-testid="p-fee-tx">
          Fee transaction {f.tx.txid}: burns {fmt(BigInt(f.tx.burnDuffs))}, network fee {fmt(BigInt(f.tx.feeDuffs))}
          {BigInt(f.tx.changeDuffs) > 0n && <>, {fmt(BigInt(f.tx.changeDuffs))} back to {f.refundAddress}</>}.
        </p>
      )}
      {view && view.lateDuffs > 0n && (
        <p className="notice-box small">
          {fmt(view.lateDuffs)} arrived after the fee transaction was made and is still at {view.address}. Your sign-in controls it: Settings → Recover funds finds it and sends it back.
        </p>
      )}
      {error && (
        <div className="auth-error" role="alert">
          <p>{error}</p>
          <p className="muted small">Progress is saved. Trying again continues where it stopped; the fee is never paid twice.</p>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      <details className="pw-details">
        <summary>Details</summary>
        <p className="small muted">
          The deposit address is derived from your {f.source.kind === 'seed' ? `recovery phrase at ${proposalDepositPath(services.network, f.source.index)}` : `signed-in key (govhub derivation, index ${f.source.index})`}.
          Only payments that InstantSend locked or a block confirmed are spent. The fee transaction is [OP_RETURN with the proposal hash, worth {duffsToDash(GOVERNANCE_PROPOSAL_FEE_DUFFS)} {unit}] plus your change, and it is saved in this
          browser before it is sent.
        </p>
      </details>
    </div>
  );
}

function CorePay({ draft, commit, services }: PayProps) {
  const lock = draft.lock!;
  const [txid, setTxid] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CollateralCheck | null>(null);
  const prepare = gobjectPrepareCommand(lock);
  const clean = txid.trim().toLowerCase();
  const valid = /^[0-9a-f]{64}$/.test(clean);
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await services.checkCollateral(lock, clean);
      setResult(r);
      if (r.state === 'mempool' || r.state === 'mined') commit((d) => ({ ...d, payment: { method: 'core', txid: clean } }));
    } catch (e) {
      setResult({ state: 'error', confirmations: 0, basis: 'reported', final: false, message: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pw-form" data-testid="p-core">
      <ol className="pw-howto">
        <li>Open Dash Core with a wallet holding at least {duffsToDash(GOVERNANCE_PROPOSAL_FEE_DUFFS + 10_000n)} {feeUnit(services.network)} (Window → Console, or dash-cli).</li>
        <li>
          Run this command. It pays the fee and prints a transaction id.
          <pre className="pw-code" data-testid="p-prepare">
            {prepare}
          </pre>
          <span className="vwin-copy">
            Copy <CopyButton text={prepare} label="Copy the gobject prepare command" />
          </span>
        </li>
        <li>
          Paste the transaction id:
          <div className="pw-inline">
            <input aria-label="Collateral transaction id" data-testid="p-txid" value={txid} onChange={(e) => setTxid(e.target.value)} spellCheck={false} autoComplete="off" placeholder="64 hex characters" />
            <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void check()} data-testid="p-txid-check">
              {busy ? 'Checking…' : 'Check'}
            </button>
          </div>
        </li>
      </ol>
      {result && result.state === 'invalid' && (
        <p className="error" role="alert" data-testid="p-txid-invalid">
          This transaction does not pay the fee for this proposal: {result.message}. Run the exact command above: any change to the time or the data is a different proposal.
        </p>
      )}
      {result && result.state === 'not-found' && <p className="notice-box small">No DAPI node knows this transaction yet. Wait a few seconds and check again, or check the id.</p>}
      {result && result.state === 'error' && <p className="error small">Could not check it: {result.message}</p>}
      <p className="muted small">Dash Core keeps the proposal too: `gobject list-prepared` shows it, with the time and data, if you lose this page and the backup.</p>
    </div>
  );
}
