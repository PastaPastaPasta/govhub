// "Get a free starter": a masternode owner (voting key) or a proposal owner (payment address) proves it to the starter issuer, gets a
// sealed (blind-signed) token for the new account's one-time funding address, and the faucet pays that address. The ordinary funding
// watcher (FundingPanel, kind create) then makes the asset lock with this browser's own key and creates the identity.
//
// The voting key (pasted, or the keyring's copy) and the pasted proposal signature are dropped as soon as the token request has been
// sent; the token is stored only encrypted under the funding key (store.ts) until the identity exists. The faucet is asked only once
// the deposit watcher is live (IS-locks are never replayed).
//
// The issuer records a masternode or proposal before it answers, and signs a repeat of the SAME blinded message again: the prepared
// request is kept across attempts (only a new challenge is fetched), and stored encrypted (store.ts) just before it is sent, so an
// answer lost on the way, a reload or a crash is not a lost starter. It is dropped once the token is saved.
import type { SeedWallet } from '@govhub/auth';
import type { StarterKind } from '@govhub/badge';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useAuth } from '../auth/context.tsx';
import { FundingPanel } from '../auth/FundingPanel.tsx';
import { errorText, formatDuffs } from '../auth/runtime.ts';
import { SecretField } from '../auth/SecretField.tsx';
import type { Proposal } from '../data/types.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { useNow } from '../ui/vote/common.tsx';
import { keyCopy } from '../voting/gate.ts';
import {
  checkProposalSignature, checkWif, fundingTarget, isLowerHex64, paymentAddressProblem, pickRedeemDelayMs, prepareStarterRequest, redeemStarter, renewChallenge, requestMnStarter, signWithKey, signWithWif,
  StarterError, starterErrorText, submitProposalStarter, tokenExpired, type PendingStarter, type Redeemed, type StarterDeps, type StarterToken,
} from './client.ts';
import { starterConfig } from './config.ts';
import { liveStarterDeps } from './live.ts';
import { starterOnLegacyKey, starterSealer, type StarterSealer, type StoredStarter } from './store.ts';

export interface StarterPanelProps {
  wallet: SeedWallet;
  identityIndex: number;
  /** a token an earlier visit got for this account setup (redeemed at its due time) */
  resume?: StoredStarter;
  /** token requests an earlier visit sent (or was about to send) without getting the answer, one per masternode/proposal: each is
   * continued with its own blinding */
  resumeRequests?: readonly PendingStarter[];
  /** same as the other funding paths: sign in to the new identity */
  onDone(identityId: string, identityIndex: number): void;
  /** "Pay with DASH instead" (back to the funding choice) */
  onPayInstead?(): void;
  /** tests only */
  deps?: StarterDeps;
}

type Timing = 'now' | 'later';
type Phase = 'proof' | 'waiting' | 'funding';

const timeText = (ms: number): string => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
};

/** Plain-language privacy note (starter-spec "Privacy rules"). */
function StarterPrivacyNote() {
  return (
    <details className="learn" open data-testid="starter-privacy">
      <summary>Who sees what</summary>
      <p className="small">
        The issuer checks that you own the masternode or proposal and gives this browser a sealed token. It never sees your new account. The faucet sees the token and
        your new account, never which masternode or proposal it came from.
      </p>
      <p className="small">
        The same team runs both, so redeeming right away would let us match the two by time. We keep no logs that would allow it. Redeeming later at a random time
        removes that timing link, but not the link by IP address: the issuer and the faucet both see your IP address, and Cloudflare carries the traffic of both.
        For the strongest privacy, use Tor or a VPN.
      </p>
      <p className="small">
        Anyone can see that the faucet paid your account, which says it belongs to some masternode or proposal owner (not which one).
      </p>
    </details>
  );
}

export function StarterPanel(p: StarterPanelProps) {
  const { registry } = useApp();
  const { network, store } = useAuth();
  const cfg = useMemo(() => starterConfig(registry), [registry]);
  const deps = useMemo(() => p.deps ?? (cfg ? liveStarterDeps(registry, cfg) : null), [p.deps, cfg, registry]);
  // a setup whose token or request was made for the hardened key used until 2026-10-25 finishes with that key (the token is bound to it)
  const legacy = useMemo(() => starterOnLegacyKey(localStorage, p.wallet, p.identityIndex), [p.wallet, p.identityIndex]);
  const target = useMemo(() => fundingTarget(p.wallet, p.identityIndex, legacy), [p.wallet, p.identityIndex, legacy]);
  const [entry, setEntry] = useState<StoredStarter | null>(p.resume ?? null);
  // a resumed setup the faucet already paid goes straight to the funding watcher, whatever the due time said
  const [phase, setPhase] = useState<Phase>(() => {
    if (!p.resume) return 'proof';
    const paid = store.list().some((r) => r.address === target.address && (r.deposits.length > 0 || !!r.lock));
    return paid || p.resume.dueAt <= Date.now() ? 'funding' : 'waiting';
  });
  const [timing, setTiming] = useState<Timing>('now');
  // read when the token arrives (the radios stay usable while the request runs)
  const timingRef = useRef(timing);
  timingRef.current = timing;
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // Derived while the wallet is alive: a token that arrives after the sheet closed (wallet wiped) is still saved.
  const sealer = useRef<Promise<StarterSealer> | null>(null);
  useEffect(() => {
    const s = starterSealer(localStorage, p.wallet, p.identityIndex);
    s.catch(() => {});
    sealer.current = s;
  }, [p.wallet, p.identityIndex]);

  // "later": move on at the due time while the page is open
  useEffect(() => {
    if (phase !== 'waiting' || !entry) return;
    const t = setTimeout(() => setPhase('funding'), Math.max(0, Math.min(entry.dueAt - Date.now(), 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [phase, entry]);

  // Requests that may have reached the issuer (sent in this visit, or kept from an earlier one) and are not finally refused: paying
  // with DASH now would give up that starter, so it asks first.
  const unanswered = useRef(new Set((p.resumeRequests ?? []).map((r) => `${r.kind}:${r.subject}`)));
  if (!deps) {
    return (
      <p className="notice" data-testid="starter-unavailable">
        Free starters are not available on {network} yet. Pay with a little DASH instead.
      </p>
    );
  }

  const getSealer = () => sealer.current ?? starterSealer(localStorage, p.wallet, p.identityIndex);
  /** Keeps the request about to be sent (best effort: a browser that cannot store still gets its token if the answer arrives). */
  const savePending = async (x: PendingStarter): Promise<void> => {
    unanswered.current.add(`${x.kind}:${x.subject}`);
    await (await getSealer()).savePending(x).catch(() => {});
  };
  const forgetPending = (kind: PendingStarter['kind'], subject: string) => {
    unanswered.current.delete(`${kind}:${subject}`);
    void sealer.current?.then((s) => s.forgetPending(kind, subject)).catch(() => {});
  };
  const payInsteadFromProof = p.onPayInstead
    ? () => {
        if (
          unanswered.current.size === 0 ||
          confirm(
            'A starter request from this browser may already have reached the issuer, which then counts that masternode or proposal as served. ' +
              'If you pay with DASH now, that free starter is not used. Pay with DASH anyway?',
          )
        )
          p.onPayInstead!();
      }
    : undefined;
  const save = async (e: StoredStarter): Promise<boolean> => {
    try {
      await (await getSealer()).save(e);
      return true;
    } catch {
      return false;
    }
  };
  const gotToken = async (token: StarterToken) => {
    const dueAt = timingRef.current === 'now' ? Date.now() : Date.now() + pickRedeemDelayMs();
    const e: StoredStarter = { v: 1, token, dueAt };
    if (!(await save(e))) setSaveNote('This browser could not save the token: keep this page open until your account is ready.');
    setEntry(e);
    setPhase(dueAt > Date.now() ? 'waiting' : 'funding');
  };
  const redeemNow = async () => {
    if (!entry) return;
    const e = { ...entry, dueAt: Date.now() };
    await save(e); // a reload resumes at once too
    setEntry(e);
    setPhase('funding');
  };
  const forget = () => void sealer.current?.then((s) => s.forget(), () => {});
  const done = (identityId: string, index: number) => {
    forget();
    p.onDone(identityId, index);
  };

  return (
    <div className="starter" data-testid="starter-panel">
      <StarterSteps phase={phase} entry={entry} />
      {saveNote && <p className="muted small">{saveNote}</p>}
      {phase === 'proof' && (
        <Proof
          deps={deps}
          pubKeyHash={target.pubKeyHash}
          timing={timing}
          setTiming={setTiming}
          onToken={gotToken}
          onPayInstead={payInsteadFromProof}
          resumeRequests={p.resumeRequests ?? []}
          savePending={savePending}
          forgetPending={forgetPending}
        />
      )}
      {phase === 'waiting' && entry && (
        <div className="notice-box" role="status" data-testid="starter-waiting">
          <p>
            <b>Your sealed token is ready.</b> It is redeemed at a random time, around <b>{timeText(entry.dueAt)}</b>. Keep this page open, or close it and come back
            after that time: sign in with your recovery phrase and it continues.
          </p>
          <p className="muted small">The token can be redeemed until about {timeText(entry.token.validUntil)}.</p>
          <button type="button" className="btn" onClick={redeemNow}>
            Redeem now instead
          </button>
        </div>
      )}
      {phase === 'funding' && entry && <Redeem deps={deps} token={entry.token} expected={target.address} legacy={legacy} wallet={p.wallet} identityIndex={p.identityIndex} onDone={done} onExpired={forget} />}
    </div>
  );
}

function StarterSteps({ phase, entry }: { phase: Phase; entry: StoredStarter | null }) {
  if (phase === 'funding') return null; // the funding panel shows its own steps from here
  const steps: Array<{ id: string; label: ReactNode; status: 'done' | 'now' | 'todo' }> = [
    { id: 'prove', label: 'Prove you own a masternode or proposal', status: phase === 'proof' ? 'now' : 'done' },
    { id: 'token', label: 'Sealed token received', status: entry ? 'done' : 'todo' },
    ...(phase === 'waiting' && entry ? [{ id: 'wait', label: <>Waiting until {timeText(entry.dueAt)}</>, status: 'now' as const }] : []),
    { id: 'fund', label: 'The faucet pays your new account', status: 'todo' },
    { id: 'signin', label: 'Account created, you are signed in', status: 'todo' },
  ];
  return (
    <ol className="fund-steps" aria-label="Free starter">
      {steps.map((s) => (
        <li key={s.id} data-status={s.status}>
          <span className="fund-dot" aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// ---- proof -------------------------------------------------------------------------------------------------------------------

interface ProofProps {
  deps: StarterDeps;
  pubKeyHash: Uint8Array;
  timing: Timing;
  setTiming(t: Timing): void;
  onToken(t: StarterToken): Promise<void>;
  onPayInstead?(): void;
  /** earlier unanswered requests, one per (kind, subject) */
  resumeRequests: readonly PendingStarter[];
  /** keeps the request (encrypted) before it is sent; a request for another subject is never replaced */
  savePending(p: PendingStarter): Promise<void>;
  /** drops one subject's request after a final refusal (nothing to resend) */
  forgetPending(kind: PendingStarter['kind'], subject: string): void;
}

const shortHash = (h: string) => `${h.slice(0, 10)}…`;

function Proof(p: ProofProps) {
  const [kind, setKind] = useState<StarterKind | null>(p.resumeRequests[0]?.kind ?? null);
  const [error, setError] = useState<unknown>(null);
  const waiting = p.resumeRequests.filter((r) => r.kind === kind);
  const pickKind = (k: StarterKind) => {
    setKind(k);
    setError(null);
  };
  return (
    <div className="form">
      {waiting.length > 0 && (
        <div className="notice-box" role="status" data-testid="starter-resume-request">
          <p>
            <b>An earlier request for this account may have reached the issuer</b> without its answer coming back ({kind === 'mn' ? 'masternode' : 'proposal'}{' '}
            {waiting.map((r) => shortHash(r.subject)).join(', ')}). Continue it with the same {kind === 'mn' ? 'masternode (its voting key signs again)' : 'proposal (sign the new message again)'}:
            the issuer then sends the same token. Trying another one first does not lose it; it stays here until this account has its starter.
          </p>
        </div>
      )}
      <fieldset>
        <legend>What do you own?</legend>
        <div className="radios">
          <label className="check">
            <input type="radio" name="starter-kind" checked={kind === 'mn'} onChange={() => pickKind('mn')} data-testid="starter-kind-mn" /> I own a masternode
          </label>
          <label className="check">
            <input type="radio" name="starter-kind" checked={kind === 'proposal'} onChange={() => pickKind('proposal')} data-testid="starter-kind-proposal" /> I own a
            proposal
          </label>
        </div>
        <p className="muted small">Each masternode gets one starter ever, and each proposal one.</p>
      </fieldset>
      {kind && (
        <fieldset>
          <legend>When to redeem</legend>
          <label className="check">
            <input type="radio" name="starter-timing" checked={p.timing === 'now'} onChange={() => p.setTiming('now')} data-testid="starter-now" /> Redeem now (default)
          </label>
          <label className="check">
            <input type="radio" name="starter-timing" checked={p.timing === 'later'} onChange={() => p.setTiming('later')} data-testid="starter-later" /> Redeem later at a
            random time (more private)
          </label>
          {p.timing === 'later' && (
            <p className="muted small">
              Between 15 minutes and 6 hours from now, picked at random. It needs this page open then; or come back later and sign in with your recovery phrase to
              continue.
            </p>
          )}
        </fieldset>
      )}
      {kind === 'mn' && <MnProof {...p} setError={setError} />}
      {kind === 'proposal' && <ProposalProof {...p} setError={setError} />}
      {error != null && <StarterErrorBox error={error} onPayInstead={p.onPayInstead} />}
      <StarterPrivacyNote />
    </div>
  );
}

const canRetry = (e: unknown): boolean => !(e instanceof StarterError) || e.retry;

/** An error with "Try again" (when that can work) and "Pay with DASH instead". */
function StarterErrorBox({ error, onRetry, onPayInstead, testId }: { error: unknown; onRetry?(): void; onPayInstead?(): void; testId?: string }) {
  const used = error instanceof StarterError && error.code === 'already-issued';
  const retry = !!onRetry && canRetry(error);
  return (
    <div className="auth-error" role="alert" data-testid={testId ?? (used ? 'starter-already-used' : 'starter-error')}>
      <p>{starterErrorText(error, errorText)}</p>
      {(retry || onPayInstead) && (
        <div className="form-actions">
          {retry && (
            <button type="button" className="btn" onClick={onRetry}>
              Try again
            </button>
          )}
          {onPayInstead && (
            <button type="button" className={retry ? 'btn btn-quiet' : 'btn'} onClick={onPayInstead}>
              Pay with DASH instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The prepared request survives an error unless the error says it can never be answered: another epoch or key, or a final refusal
 * that happens before the issuer records anything (unauthorized, not eligible) or says another request took the starter. A lost or
 * garbled answer keeps it: only a resend of the same blinded message gets the starter the issuer may already have recorded.
 */
const FINAL_REFUSALS: ReadonlySet<string> = new Set(['already-issued', 'unauthorized', 'not-eligible']);
const keepPending = (e: unknown): boolean => !(e instanceof StarterError) || (!e.stale && !FINAL_REFUSALS.has(e.code));

function MnProof(p: ProofProps & { setError(e: unknown): void }) {
  const kr = useKeyring();
  const { network } = useAuth();
  // the keyring's masternodes, when it is open and on the network the starter checks (the Dev profile reads mainnet Core data)
  const owned = kr.status === 'open' && kr.keyring && kr.coreNetwork === network ? kr.mns.owned.filter((m) => m.valid) : [];
  const resumedMn = p.resumeRequests.filter((r) => r.kind === 'mn');
  const resumed = resumedMn[0] ?? null;
  const [pick, setPick] = useState<string>(resumed && owned.some((m) => m.proTxHash === resumed.subject) ? resumed.subject : resumed ? 'paste' : '');
  const fromKeyring = owned.length > 0 && pick !== 'paste';
  const chosen = fromKeyring ? (owned.find((m) => m.proTxHash === pick) ?? owned[0]!) : null;
  const [proTxHash, setProTxHash] = useState(resumed?.subject ?? '');
  const [wif, setWif] = useState('');
  const [busy, setBusy] = useState(false);
  // each masternode's last request (also stored encrypted before it is sent): a retry for the same masternode reuses its blinding,
  // and trying another one never drops it
  const pending = useRef(new Map<string, PendingStarter>(resumedMn.map((r) => [r.subject, r])));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    p.setError(null);
    setBusy(true);
    const pro = chosen ? chosen.proTxHash : proTxHash;
    const subject = pro.trim().toLowerCase();
    try {
      let sign: (request: string) => string;
      if (chosen) {
        sign = (request) => {
          const k = keyCopy(kr.keyring?.content.keys[chosen.keyIndex]);
          if (!k || k.privateKey.every((x) => x === 0)) throw new StarterError('The keyring was locked meanwhile. Unlock it and try again.', 'input');
          try {
            return signWithKey(request, k);
          } finally {
            k.wipe();
          }
        };
      } else {
        const key = wif;
        checkWif(key, network); // a malformed or other-network key is refused before anything is sent
        sign = (request) => signWithWif(request, key, network);
      }
      const token = await requestMnStarter(p.deps, {
        proTxHash: pro,
        pubKeyHash: p.pubKeyHash,
        sign,
        pending: pending.current.get(subject) ?? null,
        onPending: (x) => {
          pending.current.set(x.subject, x);
          return p.savePending(x);
        },
      });
      pending.current.clear();
      await p.onToken(token); // saving the token drops the stored requests
    } catch (err) {
      if (!keepPending(err)) {
        pending.current.delete(subject);
        p.forgetPending('mn', subject);
      }
      p.setError(err);
    } finally {
      setWif(''); // the voting key is dropped after the request, whatever its outcome
      setBusy(false);
    }
  };
  const ready = !!chosen || (isLowerHex64(proTxHash.trim().toLowerCase()) && !!wif.trim());
  return (
    <form className="form" onSubmit={submit} data-testid="starter-mn">
      {owned.length > 0 && (
        <label>
          Masternode from your keyring
          <select value={fromKeyring ? (chosen?.proTxHash ?? '') : 'paste'} onChange={(e) => setPick(e.target.value)} disabled={busy} data-testid="starter-mn-pick">
            {owned.map((m) => (
              <option key={m.proTxHash} value={m.proTxHash}>
                {m.type === 'evo' ? 'Evonode' : 'Masternode'} {m.proTxHash.slice(0, 12)}… ({m.votingAddress})
              </option>
            ))}
            <option value="paste">Another masternode: paste its voting key</option>
          </select>
        </label>
      )}
      {!fromKeyring && (
        <>
          <label>
            proTxHash
            <input value={proTxHash} onChange={(e) => setProTxHash(e.target.value)} placeholder="64 hex characters" spellCheck={false} autoComplete="off" disabled={busy} data-testid="starter-protx" />
          </label>
          <SecretField label="Voting key (WIF)" what="the voting key" value={wif} onChange={setWif} testId="starter-wif" disabled={busy} />
        </>
      )}
      <p className="muted small">
        {chosen
          ? 'The keyring signs the request with this masternode’s voting key, here in your browser.'
          : 'The voting key signs the request here in your browser and is forgotten right after; it is never sent anywhere. The voting key can only vote, it cannot move funds.'}
      </p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? <><span className="spinner" aria-hidden="true" /> Getting your token…</> : 'Get my starter'}
        </button>
      </div>
    </form>
  );
}

function ProposalProof(p: ProofProps & { setError(e: unknown): void }) {
  const { gov, source } = useApp();
  const { network } = useAuth();
  // the app's proposal data is usable only when it is on the network the starter checks
  const sameNet = source.coreNetwork === network;
  const active = useMemo(() => (sameNet ? (gov.active.data ?? []).map((s) => s.value) : []), [sameNet, gov.active.data]);
  const resumedProposals = p.resumeRequests.filter((r) => r.kind === 'proposal');
  const [pick, setPick] = useState('');
  const [hash, setHash] = useState(resumedProposals[0]?.subject ?? '');
  const [manualAddress, setManualAddress] = useState('');
  const [looked, setLooked] = useState<{ hash: string; proposal: Proposal | null } | null>(null);
  // one request per proposal; a resumed request's challenge is treated as expired: "Get a new message" renews it for the same
  // blinded message. Looking at another proposal never drops one.
  const [pendings, setPendings] = useState<ReadonlyMap<string, PendingStarter>>(() => new Map(resumedProposals.map((r) => [r.subject, { ...r, expiresAt: 0 }])));
  const setFor = (subject: string, f: (x: PendingStarter | undefined) => PendingStarter | undefined) =>
    setPendings((m) => {
      const n = new Map(m);
      const v = f(m.get(subject));
      if (v) n.set(subject, v);
      else n.delete(subject);
      return n;
    });
  const [sig, setSig] = useState('');
  const [busy, setBusy] = useState(false);

  const pasted = pick === '' || pick === 'paste' ? hash.trim().toLowerCase() : '';
  const picked = active.find((x) => x.govHash === pick) ?? null;
  // a pasted hash: its payment address from the app's proposal data (looked up), or typed in on another network
  useEffect(() => {
    if (!sameNet || !isLowerHex64(pasted) || active.some((x) => x.govHash === pasted)) return;
    let live = true;
    source.proposal(pasted).then(
      (r) => live && setLooked({ hash: pasted, proposal: r?.value ?? null }),
      () => live && setLooked({ hash: pasted, proposal: null }),
    );
    return () => void (live = false);
  }, [sameNet, pasted, active, source]);
  const proposal: Proposal | null = picked ?? active.find((x) => x.govHash === pasted) ?? (looked?.hash === pasted ? looked.proposal : null);
  const govHash = picked?.govHash ?? pasted;
  const address = sameNet ? (proposal?.paymentAddress ?? '') : manualAddress.trim();
  const addrProblem = address ? paymentAddressProblem(address, network) : null;
  const notFound = sameNet && !picked && isLowerHex64(pasted) && looked?.hash === pasted && !looked.proposal;

  // the message shown belongs to one proposal: another one hides it (a retry for the same one reuses its blinding)
  const shown = pendings.get(govHash) ?? null;
  // the challenge clock: display only, the issuer decides (this browser's clock may be off)
  const now = useNow(15_000, !!shown);
  const expired = !!shown && now >= shown.expiresAt;

  const getMessage = async () => {
    p.setError(null);
    setBusy(true);
    setSig('');
    try {
      const next = shown ? await renewChallenge(p.deps, shown) : await prepareStarterRequest(p.deps, { kind: 'proposal', subject: govHash, pubKeyHash: p.pubKeyHash });
      setFor(next.subject, () => next);
    } catch (e) {
      p.setError(e);
    } finally {
      setBusy(false);
    }
  };
  const sigOk = !!shown && !!sig.trim() && checkProposalSignature(address, sig, shown.request, network);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shown || !sigOk) return;
    p.setError(null);
    setBusy(true);
    try {
      await p.savePending(shown); // kept before it is sent (the signature was checked above: sigOk)
      const token = await submitProposalStarter(p.deps, shown, address, sig);
      setPendings(new Map());
      setSig(''); // the signature is dropped once the token is in hand
      await p.onToken(token);
    } catch (err) {
      if (err instanceof StarterError && err.code === 'expired') setFor(shown.subject, (x) => (x ? { ...x, expiresAt: 0 } : x));
      else if (!keepPending(err)) {
        setFor(shown.subject, () => undefined);
        p.forgetPending('proposal', shown.subject);
      }
      // kept otherwise (not a secret): "Get my starter" sends the same signed request again
      p.setError(err);
    } finally {
      setBusy(false);
    }
  };
  const canAsk = isLowerHex64(govHash) && !!address && !addrProblem;

  return (
    <form className="form claim-form" onSubmit={submit} data-testid="starter-proposal">
      <fieldset>
        <legend>1. Your proposal</legend>
        {active.length > 0 && (
          <label>
            Active proposal
            <select value={pick || 'paste'} onChange={(e) => setPick(e.target.value)} disabled={busy} data-testid="starter-proposal-pick">
              <option value="paste">Another proposal: paste its hash</option>
              {active.map((x) => (
                <option key={x.govHash} value={x.govHash}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!picked && (
          <label>
            Proposal hash
            <input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="64 hex characters" spellCheck={false} autoComplete="off" disabled={busy} data-testid="starter-govhash" />
          </label>
        )}
        {!sameNet && (
          <label>
            Its payment address ({network})
            <input value={manualAddress} onChange={(e) => setManualAddress(e.target.value)} spellCheck={false} autoComplete="off" disabled={busy} data-testid="starter-payaddr" />
          </label>
        )}
        {sameNet && proposal && (
          <p className="small">
            Payment address <span className="mono-ish break">{proposal.paymentAddress}</span>
          </p>
        )}
        {notFound && <p className="error small">This app does not know a proposal with this hash on {network}.</p>}
        {addrProblem && <p className="error small">{addrProblem}</p>}
        {!shown && (
          <div className="form-actions">
            <button type="button" className="btn" onClick={getMessage} disabled={busy || !canAsk} data-testid="starter-get-message">
              {busy ? <><span className="spinner" aria-hidden="true" /> Preparing…</> : 'Get the message to sign'}
            </button>
          </div>
        )}
      </fieldset>
      {shown && (
        <>
          <fieldset>
            <legend>2. Sign this exact message with the payment address</legend>
            <pre className="code break" data-testid="starter-message">
              {shown.request}
            </pre>
            <ul className="small sign-howto">
              <li>
                Dash Core, Window → Console: <code className="break">signmessage "{address}" "{shown.request}"</code>
              </li>
              <li>
                dash-cli: <code className="break">dash-cli signmessage "{address}" "{shown.request}"</code>
              </li>
              <li>Dash Masternode Tool or a hardware wallet: use its "Sign message" tool with the address above and paste the message exactly, without a trailing newline.</li>
            </ul>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(shown.request)}>
                Copy message
              </button>
            </div>
            {expired ? (
              <p className="error small" data-testid="starter-expired">
                This message has expired.{' '}
                <button type="button" className="btn btn-quiet" onClick={getMessage} disabled={busy}>
                  Get a new message
                </button>
              </p>
            ) : (
              <p className="muted small">
                Valid until about {timeText(shown.expiresAt)}, as the issuer set it.{' '}
                <button type="button" className="btn btn-quiet" onClick={getMessage} disabled={busy}>
                  Get a new message
                </button>
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend>3. Paste the signature</legend>
            <label>
              Signature (base64, as Dash Core prints it)
              <textarea rows={2} className="code" value={sig} onChange={(e) => setSig(e.target.value)} spellCheck={false} disabled={busy} data-testid="starter-sig" />
            </label>
            {sig.trim() && (
              <p className={sigOk ? 'notice' : 'error'} data-testid="starter-sig-status">
                {sigOk ? `Signature checks out for ${address}.` : `This signature does not verify for ${address} and this message.`}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !sigOk}>
                {busy ? <><span className="spinner" aria-hidden="true" /> Getting your token…</> : 'Get my starter'}
              </button>
            </div>
          </fieldset>
        </>
      )}
    </form>
  );
}

// ---- redeem ------------------------------------------------------------------------------------------------------------------

type RedeemState = { s: 'idle' } | { s: 'asking' } | { s: 'paid'; r: Redeemed } | { s: 'error'; e: unknown };

function Redeem(p: { deps: StarterDeps; token: StarterToken; expected: string; legacy: boolean; wallet: SeedWallet; identityIndex: number; onDone(id: string, index: number): void; onExpired(): void }) {
  const [st, setSt] = useState<RedeemState>({ s: 'idle' });
  const [payInstead, setPayInstead] = useState(false);
  // a retry of the watcher fires again while a call may still run: only the newest answer counts
  const seq = useRef(0);
  const { deps, token, expected, onExpired } = p;
  const run = useCallback(
    async (addr: string) => {
      const n = ++seq.current;
      if (addr !== expected) return setSt({ s: 'error', e: new StarterError('The funding address does not match the token.', 'input') });
      setSt({ s: 'asking' });
      try {
        const r = await redeemStarter(deps, token, addr);
        if (n === seq.current) setSt({ s: 'paid', r });
      } catch (e) {
        if (n === seq.current) setSt({ s: 'error', e });
        // A refusal is final only once Platform's PROVED core height is past the token's redeem window: an issuer or faucet that is
        // briefly behind (a fresh epoch's key not listed yet), or a clock estimate, must never cost the user their one starter.
        if (e instanceof StarterError && e.code === 'faucet-rejected' && (await tokenExpired(deps, token).catch(() => false))) onExpired();
      }
    },
    [deps, token, expected, onExpired],
  );
  const payWithDash = () => {
    // the token pays this same address: paying it yourself means the starter is not used, and a payout the faucet left unresolved
    // may still arrive here later (it stays yours, as a late payment at the one-time address)
    const unresolved = st.s === 'error' && st.e instanceof StarterError && (st.e.code === 'faucet-busy' || st.e.code === 'unreachable');
    const msg =
      'Pay with your own DASH instead? Your free starter will then not be used: its token is for this same account, which your payment creates.' +
      (unresolved ? ' The faucet may still pay its starter to this address later; that money stays yours (it shows up as a late payment you can move with your recovery phrase).' : '');
    if (confirm(msg)) setPayInstead(true);
  };
  const deposit = payInstead ? undefined : <StarterDeposit st={st} onRetry={() => run(expected)} onPayInstead={payWithDash} />;
  return <FundingPanel kind="create" wallet={p.wallet} identityIndex={p.identityIndex} legacy={p.legacy} onDone={p.onDone} onAwaitingDeposit={run} deposit={deposit} />;
}

function StarterDeposit({ st, onRetry, onPayInstead }: { st: RedeemState; onRetry(): void; onPayInstead(): void }) {
  if (st.s === 'paid') {
    return (
      <p className="notice" role="status" data-testid="starter-paid">
        The faucet sent {st.r.amountSats ? formatDuffs(st.r.amountSats) : 'your starter'} to your account’s one-time address{st.r.replay ? ' (already sent earlier)' : ''}. Waiting for
        it to arrive; this page is watching the network, keep it open until it finishes.
      </p>
    );
  }
  if (st.s === 'error') {
    return (
      <>
        <StarterErrorBox error={st.e} onRetry={onRetry} onPayInstead={onPayInstead} testId="starter-redeem-error" />
        {canRetry(st.e) && <p className="muted small">Trying again is safe: the faucet never pays the same token twice.</p>}
      </>
    );
  }
  return (
    <p className="muted" data-testid="starter-asking">
      <span className="spinner" aria-hidden="true" /> Asking the faucet for your starter…
    </p>
  );
}
