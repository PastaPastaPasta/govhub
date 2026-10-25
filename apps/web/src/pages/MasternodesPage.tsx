// /masternodes: the keyring ("add my masternodes"). Your masternodes grouped by the voting key they came from, your votes, adding
// a key, and how the keyring opens and locks. Adding the first key is one flow (paste the key, see its masternodes, confirm) that
// also asks for the MN badge (one switch, on by default) and keeps the key saved encrypted on Platform unless "Don't save my key".
import { bytesToHex, UnlockerType } from '@govhub/auth';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/context.tsx';
import { badgeWif, pickBadgeMn, useMnBadge, type MnBadge } from '../badge/flow.ts';
import { BadgeChoice, BadgeProgress, KeyringBadgeRow } from '../badge/MnBadgeOption.tsx';
import { errText, shortAddress } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { CopyButton, HashCopy, useLabels, useNow } from '../ui/vote/common.tsx';
import { AddPasskey } from '../ui/vote/AddPasskey.tsx';
import { VotesList } from '../ui/vote/VotesList.tsx';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { STEP_NAME } from '../voting/lookup.ts';
import { votingAddressOfInfo, type OwnedMasternode } from '../voting/masternodes.ts';
import '../voting/voting.css';

const IDLE_CHOICES = [5, 15, 30, 60, 240];

/** "Unlocked · opens with your recovery phrase · locks after 15 min" */
function statusLine(k: ReturnType<typeof useKeyring>): string {
  const ring = k.keyring!;
  const mins = ring.content.idleLockMinutes;
  if (k.demo) return 'Demo keyring: sample masternodes, and votes aren’t sent';
  if (k.memoryOnly) return `Unlocked · memory only, nothing is saved · wiped after ${mins} idle min`;
  const seeds = ring.content.unlockers.filter((u) => u.type === UnlockerType.SEED).length;
  const passkeys = ring.content.unlockers.length - seeds;
  const opens = [seeds ? 'your recovery phrase' : '', passkeys ? `${passkeys} passkey${passkeys > 1 ? 's' : ''}` : ''].filter(Boolean).join(' or ');
  return `Unlocked · opens with ${opens || 'nothing (add an unlocker)'} · locks after ${mins} min`;
}

function Header({ adding }: { adding: boolean }) {
  const k = useKeyring();
  const open = k.status === 'open' && !!k.keyring && !adding;
  return (
    <header className="kr-head">
      <div className="kr-head-text">
        <h1 id="mn-page-title">My masternodes</h1>
        {open ? (
          <p className="kr-state" data-testid="keyring-status">
            <span className={`vdot${k.demo ? '' : ' vdot-on'}`} aria-hidden="true" />
            {statusLine(k)}
          </p>
        ) : (
          <p className="kr-state muted">Vote with your masternodes from any proposal. Only the voting key is needed.</p>
        )}
      </div>
      {open && (
        <div className="kr-head-actions">
          <Link className="btn btn-primary" to="/votes">
            Vote on proposals
          </Link>
          {!k.demo && (
            <button type="button" className="btn" onClick={k.lock} data-testid="keyring-lock">
              Lock now
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function Unlock({ onMemoryOnly }: { onMemoryOnly(): void }) {
  const k = useKeyring();
  const { session } = useAuth();
  const [phrase, setPhrase] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await k.unlockWithPhrase(phrase).catch(() => {});
    setPhrase('');
  };
  return (
    <section className="kr-card kr-gate" aria-labelledby="unlock-title">
      <h2 id="unlock-title">Unlock your keyring</h2>
      {session?.source === 'key' && (
        <p className="small muted" data-testid="keyring-keypaste">
          You signed in with a pasted key, which cannot open a saved keyring. Use your recovery phrase or a passkey, or memory-only keys.
        </p>
      )}
      <button type="button" className="btn btn-primary" onClick={() => void k.unlockWithPasskey().catch(() => {})} disabled={!!k.busy}>
        Unlock with a passkey
      </button>
      <form onSubmit={submit} className="kr-form">
        <label className="kr-field">
          <span>Or type your recovery phrase</span>
          <input type="password" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} data-testid="unlock-phrase" />
        </label>
        <div className="kr-row">
          <button type="submit" className="btn" disabled={!phrase.trim() || !!k.busy}>
            Unlock with the phrase
          </button>
          <button type="button" className="btn btn-quiet" onClick={onMemoryOnly} disabled={!!k.busy} data-testid="unlock-memory-only">
            Use memory-only keys instead
          </button>
        </div>
      </form>
    </section>
  );
}

type FlowStep = 'key' | 'found' | 'done';

/** The masternodes `keyId` controls, once the lookup that includes it is done (null while it runs). */
function foundFor(k: ReturnType<typeof useKeyring>, keyId: string | null): { idx: number; mns: OwnedMasternode[] | null } {
  const idx = keyId ? k.keyInfos.findIndex((x) => x.keyId === keyId) : -1;
  const ready = idx >= 0 && k.mns.forKeys.split(',').includes(keyId!) && k.mns.phase !== 'loading';
  return { idx, mns: ready ? k.mns.owned.filter((m) => m.keyIndex === idx) : null };
}

/**
 * "Add your masternodes": 1. paste the voting key (it goes into a memory-only keyring, after the masternode-list check), 2. see
 * its masternodes and choose (MN badge on by default; saved encrypted on Platform unless "Don't save my key"), 3. confirm: one
 * Platform save at most, then the badge request with the same key from the keyring. The pasted text is dropped once the key is in
 * the keyring; the badge job keeps its own encrypted copy until its request is sent, then deletes it (badge/client.ts wipe).
 */
function AddMasternodes({ step, setStep, b, savedLocked }: { step: FlowStep | null; setStep(s: FlowStep | null): void; b: MnBadge; savedLocked: boolean }) {
  const k = useKeyring();
  const { session } = useAuth();
  // a locked saved keyring takes keys only once unlocked (a pasted-key session cannot open one): memory only then
  const canSave = !!session?.wallet && !savedLocked;
  const [wif, setWif] = useState('');
  const [label, setLabel] = useState('');
  const [keyId, setKeyId] = useState<string | null>(null);
  const [addAfterOpen, setAddAfterOpen] = useState(false);
  const [badgeOn, setBadgeOn] = useState(true);
  const [dontSave, setDontSave] = useState(!canSave);
  const save = canSave && !dontSave;
  const [refused, setRefused] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ saved: boolean; badge: boolean; asked: boolean; note: string | null } | null>(null);
  const { idx, mns } = foundFor(k, keyId);

  const add = async () => {
    try {
      const id = await k.addKey(wif, label);
      setWif(''); // the key is in the keyring now (and wiped with it)
      setKeyId(id);
      setStep('found');
    } catch {
      /* shown by the provider */
    }
  };
  // the keyring's callbacks see memory-only only after it opened and rendered: add the key then, not from the same closure
  useEffect(() => {
    if (!addAfterOpen || k.status !== 'open' || !k.memoryOnly) return;
    setAddAfterOpen(false);
    void add();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addAfterOpen, k.status, k.memoryOnly]);

  const find = async (e: FormEvent) => {
    e.preventDefault();
    setStep('key'); // keeps this flow on screen once the keyring opens
    setRefused(null);
    if (k.status === 'open') {
      // only this flow's own memory-only keyring takes the key before the confirm step
      if (!k.memoryOnly) return setRefused('Your saved keyring is open: add the key with “Add a voting key” on this page instead.');
      return void add();
    }
    try {
      await k.createKeyring(true);
      setAddAfterOpen(true);
    } catch {
      /* shown by the provider */
    }
  };

  const differentKey = async () => {
    if (idx >= 0) await k.removeKey(idx).catch(() => {});
    setKeyId(null);
    setStep('key');
  };

  const n = mns?.length ?? 0;
  const badgeWanted = badgeOn && b.usable;
  const confirm = async () => {
    setConfirming(true);
    // the badge's key copy is taken from the keyring now: a save that merges into an existing saved keyring closes (zeroes) this one
    let badge: { wif: string; pro: string } | null = null;
    let note: string | null = null;
    if (badgeWanted && b.status.kind === 'none') {
      const mn = pickBadgeMn(mns ?? [], idx);
      if (b.availability?.state === 'error') note = 'The badge was not requested: the issuer’s keys could not be checked. Switch it on from “MN badge” on this page later.';
      else if (!b.canRequest) note = 'The badge was not requested: the issuer is not issuing yet (see above). Switch it on from “MN badge” on this page later.';
      else if (!mn) note = 'The badge was not requested: none of these masternodes can vote right now.';
      else {
        try {
          badge = { wif: badgeWif(k.keyring?.content.keys[idx], k.coreNetwork), pro: mn.proTxHash };
        } catch (e) {
          note = `The badge was not requested: ${errText(e)}`;
        }
      }
    }
    try {
      if (save) await k.saveToPlatform();
    } catch {
      setConfirming(false);
      return; // shown by the provider (with Top up when credits are short)
    }
    let asked = false;
    if (badge) {
      try {
        await b.request(badge.wif, badge.pro);
        asked = true;
      } catch (e) {
        note = `The badge was not requested: ${errText(e)}`;
      }
    }
    setResult({ saved: save, badge: badgeWanted, asked, note });
    setConfirming(false);
    setStep('done');
  };

  if (step === 'done' && result) {
    return (
      <section className="kr-card kr-flow kr-flow-done" aria-labelledby="flow-done-title" data-testid="flow-done">
        <header className="kr-card-head">
          <h2 id="flow-done-title">Your masternodes are added</h2>
          <button type="button" className="btn btn-s btn-quiet" onClick={() => setStep(null)} data-testid="flow-close">
            Done
          </button>
        </header>
        <p className="kr-found small">
          ✓ {n} masternode{n === 1 ? '' : 's'} ·{' '}
          {result.saved
            ? 'key saved encrypted on Platform'
            : `key in memory only: gone when you sign out or close the tab${result.asked ? ', except the badge request’s own copy (never in plain text), deleted once it is sent or cancelled' : ''}`}
        </p>
        {result.badge ? (
          <>
            <BadgeProgress b={b} celebrate={result.asked} />
            {result.note && <p className="small vwarn" data-testid="flow-badge-note">{result.note}</p>}
          </>
        ) : (
          <p className="small muted" data-testid="flow-badge-off">
            MN badge: off. Switch it on any time from “MN badge” below.
          </p>
        )}
      </section>
    );
  }

  const found = step === 'found' && idx >= 0;
  return (
    <section className="kr-card kr-gate kr-flow" aria-labelledby="create-title" data-testid="add-flow">
      <h2 id="create-title">Add your masternodes</h2>
      <ol className="kr-steps" aria-label="Steps">
        <li className={found ? 'done' : 'now'} aria-current={found ? undefined : 'step'}>
          Paste your voting key
        </li>
        <li className={found ? 'now' : ''} aria-current={found ? 'step' : undefined}>
          Check your masternodes
        </li>
        <li>Confirm</li>
      </ol>
      {!found ? (
        <form className="kr-form" onSubmit={(e) => void find(e)} aria-label="Paste your voting key">
          <p>Paste a masternode voting key once; govhub finds every masternode it votes for.</p>
          <label className="kr-field">
            <span>Voting private key ({k.coreNetwork}, as Dash Core shows it)</span>
            <input type="password" value={wif} onChange={(e) => setWif(e.target.value)} autoComplete="off" spellCheck={false} data-testid="flow-key-input" aria-describedby="flow-key-warn" />
          </label>
          <p className="kr-inline-warn small" id="flow-key-warn">
            Only the voting key. Never an owner, payout or collateral key: a voting key can only vote.
          </p>
          <label className="kr-field">
            <span>Name (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={32} placeholder="e.g. rack 2" data-testid="flow-key-label" />
          </label>
          <div className="kr-row">
            {refused && (
              <p className="small vwarn" role="alert">
                {refused}
              </p>
            )}
            <button type="submit" className="btn btn-primary" disabled={!wif.trim() || !!k.busy || addAfterOpen} data-testid="flow-find">
              {k.busy || addAfterOpen ? 'Checking…' : 'Find my masternodes'}
            </button>
            {savedLocked && k.status !== 'open' && (
              <button type="button" className="btn btn-quiet" onClick={() => setStep(null)}>
                Back to unlocking
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="kr-form" data-testid="flow-found">
          {mns === null ? (
            k.mns.phase === 'error' ? (
              <div className="kr-alert" role="alert">
                <p>
                  <b>Your masternodes could not be looked up.</b> {k.mns.error}
                </p>
                <button type="button" className="btn btn-s" onClick={k.refreshMasternodes}>
                  Retry
                </button>
              </div>
            ) : (
              <LookupProgress />
            )
          ) : (
            <div data-testid="flow-mns">
              <p className="kr-found">
                <span>
                  ✓ {k.keyInfos[idx]?.label || 'This key'} votes for {n} masternode{n === 1 ? '' : 's'}.
                </span>
              </p>
              <ul className="kr-flow-mns small">
                {mns.map((m) => (
                  <li key={m.proTxHash}>
                    <span className="chip kr-type">{m.type === 'evo' ? 'Evonode' : 'Regular'}</span> <span className="mono-ish">{m.proTxHash.slice(0, 12)}…</span>
                    {!m.valid && <span className="chip chip-bad">PoSe-banned</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <BadgeChoice b={b} on={badgeOn} onChange={setBadgeOn} />
          <fieldset className="kr-store" data-testid="flow-store">
            <legend>Where your key lives</legend>
            {save ? (
              <p className="small">
                <b>Saved encrypted on Platform</b> (recommended). Encrypted in this browser to your recovery phrase (and passkeys you add). Back on any device when you sign in.
                About 0.003 DASH in credits for each save.
              </p>
            ) : (
              <p className="small">
                <b>Memory only.</b> Nothing is saved on Platform, not even the votes you sign. Gone when you sign out or close the tab.
                {badgeWanted && ' The badge request still keeps its own copy of the key in this browser, never in plain text, until it is sent.'}
              </p>
            )}
            <label className="check small kr-dont-save">
              <input type="checkbox" checked={!save} onChange={(e) => setDontSave(e.target.checked)} disabled={!canSave} data-testid="flow-dont-save" />
              <span>Don’t save my key (memory only)</span>
            </label>
            {!canSave && (
              <p className="vwarn small">
                {savedLocked
                  ? 'To save keys in your saved keyring, unlock it first (recovery phrase or passkey). A pasted-key sign-in cannot open it.'
                  : 'Saving needs your recovery phrase in this session (sign in with it, or with a passkey that keeps it).'}
              </p>
            )}
          </fieldset>
          <div className="kr-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void confirm()}
              disabled={confirming || !!k.busy || mns === null || n === 0 || (badgeWanted && b.availability?.state === 'checking')}
              data-testid="flow-confirm"
            >
              {confirming ? 'Adding…' : `Add ${n > 0 ? `${n} ` : ''}masternode${n === 1 ? '' : 's'}${badgeWanted && b.canRequest && b.status.kind === 'none' ? ' and get the badge' : ''}`}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => void differentKey()} disabled={confirming || !!k.busy}>
              Use a different key
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function AddKey() {
  const k = useKeyring();
  const [wif, setWif] = useState('');
  const [label, setLabel] = useState('');
  const [added, setAdded] = useState<{ keyId: string; label: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const keyId = await k.addKey(wif, label);
      setAdded({ keyId, label: label.trim() });
      setWif('');
      setLabel('');
    } catch {
      /* shown by the provider */
    }
  };
  // what the new key found, once the lookup that includes it is done
  const idx = added ? k.keyInfos.findIndex((x) => x.keyId === added.keyId) : -1;
  const ready = added && idx >= 0 && k.mns.forKeys.includes(added.keyId) && k.mns.phase !== 'loading';
  const found = ready ? k.mns.owned.filter((m) => m.keyIndex === idx).length : 0;
  const adding = k.busy === 'Adding the voting key';
  return (
    <section className="kr-card" aria-labelledby="addkey-title">
      <h2 id="addkey-title">Add a voting key</h2>
      <form className="kr-form" onSubmit={submit} aria-label="Add a voting key">
        <label className="kr-field">
          <span>Voting private key ({k.coreNetwork}, as Dash Core shows it)</span>
          <input type="password" value={wif} onChange={(e) => setWif(e.target.value)} autoComplete="off" spellCheck={false} data-testid="voting-key-input" aria-describedby="addkey-warn" />
        </label>
        <p className="kr-inline-warn small" id="addkey-warn">
          Only the voting key. Never an owner, payout or collateral key: a voting key can only vote.
        </p>
        <label className="kr-field">
          <span>Name (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={32} placeholder="e.g. rack 2" data-testid="voting-key-label" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!wif.trim() || !!k.busy || k.demo} data-testid="voting-key-add">
          {adding ? 'Adding…' : 'Add key'}
        </button>
        {k.demo && <p className="small muted">The demo keyring has its keys already.</p>}
      </form>
      {added && idx >= 0 && (
        <p className={`kr-found small ${ready && !found ? 'vwarn' : ''}`} role="status" data-testid="addkey-result">
          {!ready ? (
            <>
              <span className="spinner" aria-hidden="true" /> Looking up the masternodes for {added.label || 'this key'}…
            </>
          ) : found ? (
            <>
              ✓ {added.label || 'This key'} controls {found} masternode{found === 1 ? '' : 's'}.
            </>
          ) : (
            <>{added.label || 'This key'} does not vote for any registered masternode. Check that it is the voting key, not the owner key.</>
          )}
        </p>
      )}
    </section>
  );
}

function NodeLabel({ pro, value }: { pro: string; value: string }) {
  const k = useKeyring();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = () => v.trim() !== value && void k.setNodeLabel(pro, v).catch(() => setV(value));
  return (
    <input
      className="kr-label-input"
      aria-label={`Name for masternode ${pro.slice(0, 8)}`}
      value={v}
      maxLength={32}
      placeholder="Add a name"
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
      disabled={k.demo}
    />
  );
}

function MnCard({ m, label }: { m: OwnedMasternode; label: string }) {
  return (
    <li className="kr-mn" data-testid="mn-row" data-protx={m.proTxHash}>
      <div className="kr-mn-top">
        <NodeLabel pro={m.proTxHash} value={label} />
        <span className="chip kr-type">{m.type === 'evo' ? 'Evonode ×4' : 'Regular'}</span>
        {m.valid ? <span className={`chip ${m.provenance.key === 'sml' ? 'chip-funded' : 'chip-neutral'}`}>Can vote</span> : <span className="chip chip-bad">PoSe-banned: cannot vote</span>}
      </div>
      <dl className="kr-mn-facts">
        <div>
          <dt>ID</dt>
          <dd>
            <HashCopy value={m.proTxHash} label="masternode ID" />
          </dd>
        </div>
        <div>
          <dt>Payout</dt>
          <dd>{m.payoutAddress ? <HashCopy value={m.payoutAddress} label="payout address" n={6} /> : <span className="muted">not read yet</span>}</dd>
        </div>
      </dl>
      <p className="kr-mn-proof small muted">
        {m.provenance.key === 'sml' && m.provenance.collateral === 'protx'
          ? 'Confirmed: its key matches the masternode list, and its registration proves the rest.'
          : m.provenance.key === 'sml'
            ? 'Key matches the masternode list; its registration is not checked yet.'
            : 'Not confirmed against the masternode list yet.'}
      </p>
    </li>
  );
}

function LookupProgress() {
  const k = useKeyring();
  const loading = k.mns.phase === 'loading';
  const now = useNow(1000, loading);
  if (!loading) return null;
  const secs = Math.max(0, Math.round((now - (k.mns.startedAt ?? now)) / 1000));
  const step = STEP_NAME[k.mns.step ?? 'bridge'];
  return (
    <p className="kr-progress small" role="status" data-testid="mn-progress">
      <span className="spinner" aria-hidden="true" /> {step[0]!.toUpperCase() + step.slice(1)}… <span className="muted" aria-hidden="true">{secs} s</span>
      {secs >= 15 && <span className="muted"> Slower than usual; it gives up and says so within a minute.</span>}
    </p>
  );
}

/** The keyring card's "MN badge" row: asks with one of the keyring's masternodes (a valid one, list-confirmed first). */
function BadgeRow({ b, hideProgress }: { b: MnBadge; hideProgress: boolean }) {
  const k = useKeyring();
  const mn = pickBadgeMn(k.mns.owned);
  let why: string | null = null;
  if (!k.demo) {
    if (k.mns.phase === 'loading' || k.mns.phase === 'idle') why = 'Finding your masternodes first…';
    else if (!mn) why = 'None of your masternodes can ask for a badge (none found, or all PoSe-banned).';
  }
  const request = mn && !why ? () => b.request(badgeWif(k.keyring?.content.keys[mn.keyIndex], k.coreNetwork), mn.proTxHash) : null;
  return <KeyringBadgeRow b={b} request={request} why={why} hideProgress={hideProgress} />;
}

function Masternodes({ b, hideBadgeProgress }: { b: MnBadge; hideBadgeProgress: boolean }) {
  const k = useKeyring();
  const labels = useLabels();
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const loading = k.mns.phase === 'loading';
  const total = k.mns.owned.length;
  return (
    <section className="kr-card kr-mns" aria-labelledby="mns-title" aria-busy={loading}>
      <header className="kr-card-head">
        <h2 id="mns-title">Your masternodes</h2>
        {k.mns.phase === 'ready' && <span className="small muted">{total} found</span>}
        <button type="button" className="btn btn-s btn-quiet kr-refresh" onClick={k.refreshMasternodes} disabled={loading || !k.keyInfos.length}>
          Refresh
        </button>
      </header>
      <BadgeRow b={b} hideProgress={hideBadgeProgress} />
      <LookupProgress />
      {k.mns.phase === 'error' && (
        <div className="kr-alert" role="alert" data-testid="mn-error">
          <p>
            <b>Your masternodes could not be looked up.</b> {k.mns.error}
          </p>
          <button type="button" className="btn btn-s" onClick={k.refreshMasternodes} data-testid="mn-retry">
            Retry
          </button>
        </div>
      )}
      {k.mns.warning && k.mns.phase === 'ready' && (
        <div className="vwarn small" data-testid="mn-warning">
          <p>{k.mns.warning}</p>
          <button type="button" className="btn btn-s" onClick={k.refreshMasternodes}>
            Retry
          </button>
        </div>
      )}
      {!!k.mns.missing.length && <p className="vwarn small">{k.mns.missing.length} masternode(s) for your keys are in the masternode list but not in the bridge’s list yet; they can vote once the bridge catches up.</p>}
      {!!k.mns.mismatch.length && <p className="kr-alert small">The bridge named a wrong collateral for {k.mns.mismatch.length} masternode(s); they are hidden.</p>}
      {!k.keyInfos.length ? (
        <div className="vempty-line" data-testid="mn-empty">
          <p>No voting keys yet. Add one and its masternodes show up here.</p>
        </div>
      ) : (
        <div className="kr-keys" data-testid="key-list">
          {k.keyInfos.map((key, i) => {
            const address = votingAddressOfInfo(key, k.coreNetwork);
            const mine = k.mns.owned.filter((m) => m.keyIndex === i);
            const known = k.mns.phase === 'ready' || (loading && mine.length > 0);
            return (
              <section key={address} className="kr-key" aria-label={`Voting key ${key.label || i + 1}`} data-testid="key-group">
                <header className="kr-key-head">
                  <div className="kr-key-id">
                    <span className="kr-key-name">{key.label || `Voting key ${i + 1}`}</span>
                    <span className="kr-key-addr">
                      <span className="mono-ish" title={address}>
                        {shortAddress(address)}
                      </span>
                      <span className="visually-hidden">{address}</span>
                      <CopyButton text={address} label="Copy voting address" />
                    </span>
                  </div>
                  <span className="small muted kr-key-count" data-testid="key-count">
                    {known ? `controls ${mine.length} masternode${mine.length === 1 ? '' : 's'}` : k.mns.phase === 'error' ? 'not looked up' : 'looking up…'}
                  </span>
                  {!k.demo &&
                    (confirmRemove === i ? (
                      <span className="kr-key-remove">
                        <button type="button" className="btn btn-s btn-danger" onClick={() => void k.removeKey(i).catch(() => {}).finally(() => setConfirmRemove(null))} disabled={!!k.busy}>
                          Remove key
                        </button>
                        <button type="button" className="btn btn-s btn-quiet" onClick={() => setConfirmRemove(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-s btn-quiet kr-key-remove" onClick={() => setConfirmRemove(i)} aria-label={`Remove ${key.label || `voting key ${i + 1}`}`}>
                        Remove
                      </button>
                    ))}
                </header>
                {mine.length > 0 ? (
                  <ul className="kr-mn-list">
                    {mine.map((m) => (
                      <MnCard key={m.proTxHash} m={m} label={labels.get(m.proTxHash.toLowerCase()) ?? ''} />
                    ))}
                  </ul>
                ) : loading ? (
                  <ul className="kr-mn-list" aria-hidden="true">
                    <li className="kr-mn kr-skel" />
                  </ul>
                ) : k.mns.phase === 'ready' ? (
                  <p className="vempty-line small muted" data-testid="key-empty">
                    No registered masternode votes with this key. Check that it is the voting key (not the owner key) of a {k.coreNetwork} masternode.
                  </p>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function UnlockMethods() {
  const k = useKeyring();
  const ring = k.keyring!;
  if (k.demo) return null;
  if (k.memoryOnly) {
    return (
      <section className="kr-card" aria-labelledby="store-title">
        <h2 id="store-title">Keep these keys</h2>
        <p className="small">Memory-only keys are gone when you sign out. Save them encrypted on Platform to get them back with your recovery phrase.</p>
        <button type="button" className="btn" onClick={() => void k.saveToPlatform().catch(() => {})} disabled={!!k.busy}>
          Save encrypted on Platform
        </button>
      </section>
    );
  }
  const passkeys = ring.content.unlockers.filter((u) => u.type !== UnlockerType.SEED);
  const seeds = ring.content.unlockers.filter((u) => u.type === UnlockerType.SEED);
  const openedBy = ring.openedBy ? bytesToHex(ring.openedBy) : null;
  const row = (u: (typeof ring.content.unlockers)[number], name: string) => {
    const id = bytesToHex(u.recipientKey);
    return (
      <li key={id} className="kr-unlock">
        <span className="kr-unlock-name">
          {name}
          {openedBy === id && <span className="chip kr-now">opened it now</span>}
        </span>
        <span className="small muted">added {new Date(u.addedAt * 1000).toLocaleDateString()}</span>
        {ring.content.unlockers.length > 1 && (
          <button type="button" className="btn btn-s btn-quiet" onClick={() => void k.removeUnlockerKey(u.recipientKey).catch(() => {})} disabled={!!k.busy} aria-label={`Remove ${name}`}>
            Remove
          </button>
        )}
      </li>
    );
  };
  return (
    <section className="kr-card" aria-labelledby="unlockers-title">
      <h2 id="unlockers-title">Unlock methods</h2>
      {k.needsConfirm && (
        <div className="vwarn small" data-testid="confirm-unlockers">
          <p>
            This keyring could not be verified as yours{ring.authenticated === null ? ' (only your recovery phrase can verify it)' : ''}. Anyone listed here can open it and every key you add. Remove what you do not recognise, then confirm.
          </p>
          <button type="button" className="btn btn-s" onClick={k.confirmUnlockers} disabled={!!k.busy}>
            These are mine
          </button>
        </div>
      )}
      <ul className="kr-unlocks" data-testid="unlockers">
        {seeds.map((u) => row(u, 'Recovery phrase'))}
        {passkeys.map((u, i) => row(u, passkeys.length > 1 ? `Passkey ${i + 1}` : 'Passkey'))}
      </ul>
      <AddPasskey />
      <label className="kr-setting">
        <span>Lock after being idle for</span>
        <select value={ring.content.idleLockMinutes} onChange={(e) => void k.setIdleMinutes(Number(e.target.value)).catch(() => {})} disabled={!!k.busy}>
          {IDLE_CHOICES.map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} min` : `${m / 60} h`}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

function Privacy() {
  return (
    <details className="kr-card kr-privacy">
      <summary>What’s visible to others</summary>
      <ul className="small">
        <li>Platform sees that you have a keyring, its size class and when it changes; not your keys, nor how many masternodes you have.</li>
        <li>DAPI evonodes you ask about your masternodes see your IP with those masternodes.</li>
        <li>The relay sees which votes came from your IP, and when. Once broadcast, a vote is public like any masternode vote.</li>
      </ul>
    </details>
  );
}

export function MasternodesPage() {
  const k = useKeyring();
  const { openSheet } = useAuth();
  const b = useMnBadge();
  const { hash, key: navKey } = useLocation();
  // the flow stays on screen while the key it adds opens the keyring (null: not adding)
  const [flow, setFlow] = useState<FlowStep | null>(null);
  // "Use memory-only keys instead" on a locked keyring starts the same flow, memory only (null: not asked)
  const [fromUnlock, setFromUnlock] = useState(false);
  useEffect(() => {
    if (k.status === 'signed-out' || k.status === 'checking') {
      setFlow(null);
      setFromUnlock(false);
    }
  }, [k.status]);
  const fromLocked = (k.status === 'locked' || k.status === 'error') && flow !== null;
  const adding = k.status === 'absent' || fromLocked || (k.status === 'open' && flow !== null);
  const showGrid = k.status === 'open' && !!k.keyring && (flow === null || flow === 'done');
  // "Get an MN badge" links land here (#mn-badge): the flow, or the keyring card's badge row; once per navigation
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (hash !== '#mn-badge' || scrolled.current === navKey) return;
    const el = document.getElementById(adding ? 'create-title' : 'mn-badge');
    if (!el) return; // not rendered yet (the keyring is still being looked for)
    scrolled.current = navKey;
    el.scrollIntoView({ block: 'start' });
  }, [hash, navKey, adding, showGrid]);
  return (
    <section className="kr-page" aria-labelledby="mn-page-title">
      <Header adding={adding && flow !== 'done'} />
      {k.busy && (
        <p className="kr-busy small" role="status">
          <span className="spinner" aria-hidden="true" /> {k.busy}…
        </p>
      )}
      {k.error && (
        <div className="kr-alert" role="alert" data-testid="keyring-error">
          <p>{k.error}</p>
          {k.needsTopUp && (
            <button type="button" className="btn btn-s" onClick={() => openSheet('topup')} data-testid="keyring-topup">
              Top up
            </button>
          )}
        </div>
      )}
      {k.status === 'signed-out' && (
        <section className="kr-card kr-gate">
          <h2>Sign in to add your masternodes</h2>
          <p>Your voting keys are kept in an encrypted keyring that comes back whenever you sign in again. Masternode owners can also show an MN badge next to their name.</p>
          <button type="button" className="btn btn-primary" onClick={openSignIn}>
            Sign in
          </button>
        </section>
      )}
      {k.status === 'checking' && (
        <p className="kr-progress" role="status">
          <span className="spinner" aria-hidden="true" /> Looking for your keyring on Platform…
        </p>
      )}
      {(k.status === 'locked' || k.status === 'error') && !fromLocked && (
        <Unlock
          onMemoryOnly={() => {
            setFromUnlock(true);
            setFlow('key');
          }}
        />
      )}
      {adding && <AddMasternodes step={flow} setStep={setFlow} b={b} savedLocked={fromUnlock} />}
      {showGrid && (
        <div className="kr-grid">
          <div className="kr-main">
            <Masternodes b={b} hideBadgeProgress={flow === 'done'} />
            <VotesList />
          </div>
          <aside className="kr-side" aria-label="Keyring settings">
            <AddKey />
            <UnlockMethods />
            <Privacy />
          </aside>
        </div>
      )}
    </section>
  );
}
