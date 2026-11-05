// /masternodes: the keyring ("add my masternodes"). A main column with your masternodes (grouped by the voting key they came from)
// and your votes; a quieter side column with the MN badge, the keyring settings (how it opens and locks) and what others can see.
// Adding the first key is one flow (paste the key, see its masternodes, confirm) that also asks for the MN badge (one switch, on
// by default) and keeps the key saved encrypted on Platform unless "Don't save my key"; it ends in a slim banner above the page.
import { useRouteTitle } from '../app/title.ts';
import { bytesToHex, UnlockerType } from '@govhub/auth';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Link } from '../ui/Link.tsx';
import { useAuth } from '../auth/context.tsx';
import { badgeWif, pickBadgeMn, useMnBadge, type MnBadge } from '../badge/flow.ts';
import { BadgeChoice, KeyringBadgeRow } from '../badge/MnBadgeOption.tsx';
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

/** "your recovery phrase or 2 passkeys" ('' when nothing can open it) */
function opensWith(ring: NonNullable<ReturnType<typeof useKeyring>['keyring']>): string {
  const seeds = ring.content.unlockers.filter((u) => u.type === UnlockerType.SEED).length;
  const passkeys = ring.content.unlockers.length - seeds;
  return [seeds ? 'your recovery phrase' : '', passkeys ? `${passkeys} passkey${passkeys > 1 ? 's' : ''}` : ''].filter(Boolean).join(' or ');
}

const idleText = (mins: number) => (mins < 60 ? `${mins} minutes` : `${mins / 60} hour${mins === 60 ? '' : 's'}`);

/**
 * "Unlocked. Locks after 15 minutes idle." (how it opens is under Keyring settings). `badgeKeyKept`: a pending badge request holds
 * its own copy of a voting key (the memory-only line must not say "nothing").
 */
function statusLine(k: ReturnType<typeof useKeyring>, badgeKeyKept: boolean): string {
  const ring = k.keyring!;
  const idle = idleText(ring.content.idleLockMinutes);
  if (k.demo) return 'Demo keyring: sample masternodes, and votes aren’t sent';
  if (k.memoryOnly) return `Unlocked, memory only: ${badgeKeyKept ? 'nothing is saved but the pending badge request’s key copy' : 'nothing is saved'}. Cleared after ${idle} idle.`;
  if (!opensWith(ring)) return `Unlocked. Nothing can open it again yet: add a passkey in Keyring settings.`;
  return `Unlocked. Locks after ${idle} idle.`;
}

function Header({ adding, badgeKeyKept }: { adding: boolean; badgeKeyKept: boolean }) {
  const k = useKeyring();
  const open = k.status === 'open' && !!k.keyring && !adding;
  return (
    <header className="kr-head dh-page-header">
      <div className="kr-head-text">
        <h1 className="dh-page-header__title" id="mn-page-title">My masternodes</h1>
        {open ? (
          <p className="kr-state" data-testid="keyring-status">
            <span className={`vdot${k.demo ? '' : ' vdot-on'}`} aria-hidden="true" />
            {statusLine(k, badgeKeyKept)}
          </p>
        ) : (
          <p className="dh-page-header__lede">Vote on proposals and name contests with your masternodes' voting keys. Never the owner or collateral key.</p>
        )}
      </div>
      {open && (
        <div className="kr-head-actions">
          <Link className="btn dh-btn btn-primary dh-btn--primary" to="/votes">
            Vote on proposals
          </Link>
          {!k.demo && (
            <button type="button" className="btn dh-btn" onClick={k.lock} data-testid="keyring-lock">
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
  // the passkey that signed in does not open the keyring: say so, and lead with the phrase (the way to add that passkey afterwards)
  const passkeyNot = k.lockedReason === 'passkey-not-unlocker';
  return (
    <section className="kr-card dh-card kr-gate" aria-labelledby="unlock-title">
      <h2 id="unlock-title">Unlock your keyring</h2>
      {passkeyNot && (
        <p className="kr-reason" data-testid="keyring-locked-reason">
          Your passkey signs you in, but it isn’t set up to unlock your masternode keys yet. Unlock once with your recovery phrase, then add this passkey so it works next time.
        </p>
      )}
      {session?.source === 'key' && (
        <p className="small muted" data-testid="keyring-keypaste">
          You signed in with a pasted key, which cannot open a saved keyring. Use your recovery phrase or a passkey, or memory-only keys.
        </p>
      )}
      {!passkeyNot && (
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary" onClick={() => void k.unlockWithPasskey().catch(() => {})} disabled={!!k.busy}>
          Unlock with a passkey
        </button>
      )}
      <form onSubmit={submit} className="kr-form">
        <label className="kr-field dh-field__label">
          <span>{passkeyNot ? 'Your recovery phrase' : 'Or type your recovery phrase'}</span>
          <input className="dh-input" type="password" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} data-testid="unlock-phrase" />
        </label>
        <div className="kr-row">
          <button type="submit" className={passkeyNot ? 'btn dh-btn btn-primary dh-btn--primary' : 'btn dh-btn'} disabled={!phrase.trim() || !!k.busy} data-testid="unlock-phrase-submit">
            Unlock with the phrase
          </button>
          {passkeyNot && (
            <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={() => void k.unlockWithPasskey().catch(() => {})} disabled={!!k.busy}>
              Try another passkey
            </button>
          )}
          <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={onMemoryOnly} disabled={!!k.busy} data-testid="unlock-memory-only">
            Use memory-only keys instead
          </button>
        </div>
      </form>
    </section>
  );
}

type FlowStep = 'key' | 'found' | 'done';

/** What the flow's confirm did: the banner says it once, and the badge card celebrates when `asked` (the badge's status is shown there only). */
interface Added {
  n: number;
  saved: boolean;
  asked: boolean;
  note: string | null;
}

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
function AddMasternodes({ step, setStep, b, savedLocked, onAdded }: { step: FlowStep | null; setStep(s: FlowStep | null): void; b: MnBadge; savedLocked: boolean; onAdded(r: Added): void }) {
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
      if (b.availability?.state === 'error') note = 'The badge was not requested: the issuer’s keys could not be checked. Switch it on later in the MN badge card.';
      else if (!b.canRequest) note = 'The badge was not requested: the issuer is not issuing yet. Switch it on later in the MN badge card.';
      else if (!mn) note = 'The badge was not requested: none of these masternodes can vote right now.';
      else {
        try {
          badge = { wif: badgeWif(k.keyring?.content.keys[idx], k.coreNetwork), pro: mn.proTxHash };
        } catch (e) {
          note = `The badge was not requested: ${errText(e)}`;
        }
      }
    }
    if (!save && k.needsTopUp) k.dismissError(); // memory-only: the failed save is moot
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
    onAdded({ n, saved: save, asked, note });
    setConfirming(false);
    setStep('done');
  };

  const found = step === 'found' && idx >= 0;
  return (
    <section className="kr-card dh-card kr-gate kr-flow" aria-labelledby="create-title" data-testid="add-flow">
      <h2 id="create-title">Add your masternodes</h2>
      <ol className="kr-steps dh-steps" aria-label="Steps">
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
          <p>Paste a masternode voting key once; Governance finds every masternode it votes for.</p>
          <label className="kr-field dh-field__label">
            <span>Voting private key ({k.coreNetwork}, as Dash Core shows it)</span>
            <input className="dh-input" type="password" value={wif} onChange={(e) => setWif(e.target.value)} autoComplete="off" spellCheck={false} data-testid="flow-key-input" aria-describedby="flow-key-warn" />
          </label>
          <p className="kr-inline-warn small" id="flow-key-warn">
            Only the voting key. Never an owner, payout or collateral key: a voting key can only vote.
          </p>
          <label className="kr-field dh-field__label">
            <span>Name (optional)</span>
            <input className="dh-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={32} placeholder="e.g. rack 2" data-testid="flow-key-label" />
          </label>
          <div className="kr-row">
            {refused && (
              <p className="small vwarn" role="alert">
                {refused}
              </p>
            )}
            <button type="submit" className="btn dh-btn btn-primary dh-btn--primary" disabled={!wif.trim() || !!k.busy || addAfterOpen} data-testid="flow-find">
              {k.busy || addAfterOpen ? 'Checking…' : 'Find my masternodes'}
            </button>
            {savedLocked && k.status !== 'open' && (
              <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={() => setStep(null)}>
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
                <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={k.refreshMasternodes}>
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
                    <span className="tag dh-badge tag-done">{m.type === 'evo' ? 'Evonode' : 'Regular'}</span> <dashhq-hash value={m.proTxHash} label="ProTx hash" href={window.dashhq?.href('radar', '/mn/' + m.proTxHash, { network: k.coreNetwork })}>{m.proTxHash}</dashhq-hash>
                    {!m.valid && <span className="tag dh-badge tag-fail dh-badge--bad">PoSe-banned</span>}
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
            <label className="check small kr-dont-save dh-field__label">
              <input
                type="checkbox"
                checked={!save}
                onChange={(e) => {
                  setDontSave(e.target.checked);
                  // "Nothing was saved. Top up" is about saving on Platform: it no longer applies once the key stays in memory only
                  if (e.target.checked && k.needsTopUp) k.dismissError();
                }}
                disabled={!canSave}
                data-testid="flow-dont-save"
              />
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
              className="btn dh-btn btn-primary dh-btn--primary"
              onClick={() => void confirm()}
              disabled={confirming || !!k.busy || mns === null || n === 0 || (badgeWanted && b.availability?.state === 'checking')}
              data-testid="flow-confirm"
            >
              {confirming ? 'Adding…' : `Add ${n > 0 ? `${n} ` : ''}masternode${n === 1 ? '' : 's'}${badgeWanted && b.canRequest && b.status.kind === 'none' ? ' and get the badge' : ''}`}
            </button>
            <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={() => void differentKey()} disabled={confirming || !!k.busy}>
              Use a different key
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** "Add a voting key", opened from the masternodes card: the form, then what the new key found. */
function AddKey({ onClose }: { onClose(): void }) {
  const k = useKeyring();
  const [wif, setWif] = useState('');
  const [label, setLabel] = useState('');
  const [added, setAdded] = useState<{ keyId: string; label: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
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
    <section className="kr-addkey" aria-labelledby="addkey-title" data-testid="addkey">
      <h3 id="addkey-title">Add a voting key</h3>
      <form className="kr-form" onSubmit={submit} aria-label="Add a voting key">
        <div className="kr-fields">
          <label className="kr-field dh-field__label">
            <span>Voting private key ({k.coreNetwork}, as Dash Core shows it)</span>
            <input className="dh-input" ref={input} type="password" value={wif} onChange={(e) => setWif(e.target.value)} autoComplete="off" spellCheck={false} data-testid="voting-key-input" aria-describedby="addkey-warn" />
          </label>
          <label className="kr-field dh-field__label">
            <span>Name (optional)</span>
            <input className="dh-input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={32} placeholder="e.g. rack 2" data-testid="voting-key-label" />
          </label>
        </div>
        <p className="kr-inline-warn small" id="addkey-warn">
          Only the voting key. Never an owner, payout or collateral key: a voting key can only vote.
        </p>
        {k.demo && <p className="small muted">The demo keyring has its keys already.</p>}
        <div className="kr-row">
          <button type="submit" className="btn dh-btn btn-primary dh-btn--primary" disabled={!wif.trim() || !!k.busy || k.demo} data-testid="voting-key-add">
            {adding ? 'Adding…' : 'Add key'}
          </button>
          <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={onClose} data-testid="addkey-close">
            {added ? 'Done' : 'Cancel'}
          </button>
        </div>
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
      className="kr-label-input dh-input"
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

/** How far govhub checked that this masternode is yours: a short word on the row, the sentence behind it. */
function proofOf(m: OwnedMasternode): { short: string; full: string } {
  if (m.provenance.key === 'sml' && m.provenance.collateral === 'protx') return { short: 'Verified', full: 'Confirmed: its key matches the masternode list, and its registration proves the rest.' };
  if (m.provenance.key === 'sml') return { short: 'Partly verified', full: 'Key matches the masternode list; its registration is not checked yet.' };
  return { short: 'Not verified yet', full: 'Not confirmed against the masternode list yet.' };
}

function MnRow({ m, label }: { m: OwnedMasternode; label: string }) {
  const k = useKeyring();
  const [why, setWhy] = useState(false);
  const proofId = useId();
  const proof = proofOf(m);
  return (
    <li className="kr-mn" data-testid="mn-row" data-protx={m.proTxHash}>
      <div className="kr-mn-top">
        <NodeLabel pro={m.proTxHash} value={label} />
        <span className="kr-mn-tags">
          <span className="tag dh-badge tag-done">{m.type === 'evo' ? 'Evonode ×4' : 'Regular'}</span>
          {m.valid ? <span className={`tag dh-badge ${m.provenance.key === 'sml' ? 'tag-pass dh-badge--good' : 'tag-done'}`}>Can vote</span> : <span className="tag dh-badge tag-fail dh-badge--bad">PoSe-banned: cannot vote</span>}
        </span>
      </div>
      <div className="kr-mn-facts small">
        <span className="kr-fact">
          <span className="kr-fact-k">ProTx</span>
          <dashhq-hash value={m.proTxHash} label="ProTx hash" href={window.dashhq?.href('radar', '/mn/' + m.proTxHash, { network: k.coreNetwork })}>{m.proTxHash}</dashhq-hash>
        </span>
        <span className="kr-fact">
          <Link to={`/masternodes/${m.proTxHash.toLowerCase()}`} data-testid="mn-votes-link">
            Its votes
          </Link>
        </span>
        <span className="kr-fact">
          <span className="kr-fact-k">Payout</span>
          {m.payoutAddress ? <HashCopy value={m.payoutAddress} label="payout address" n={6} /> : <span className="kr-fact-none">not read yet</span>}
        </span>
        <button
          type="button"
          className="kr-proof"
          aria-label={`${proof.short}: how masternode ${m.proTxHash.slice(0, 8)} was checked`}
          aria-expanded={why}
          aria-controls={proofId}
          onClick={() => setWhy(!why)}
          data-testid="mn-proof"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7.25v4M8 4.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {proof.short}
        </button>
      </div>
      <p id={proofId} className="kr-mn-proof small" hidden={!why}>
        {proof.full}
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

/** The side column's MN badge card: asks with one of the keyring's masternodes (a valid one, list-confirmed first). */
function BadgeRow({ b, celebrate }: { b: MnBadge; celebrate: boolean }) {
  const k = useKeyring();
  const mn = pickBadgeMn(k.mns.owned);
  let why: string | null = null;
  if (!k.demo) {
    if (k.mns.phase === 'loading' || k.mns.phase === 'idle') why = 'Finding your masternodes first…';
    else if (!mn) why = 'None of your masternodes can ask for a badge (none found, or all PoSe-banned).';
  }
  const request = mn && !why ? () => b.request(badgeWif(k.keyring?.content.keys[mn.keyIndex], k.coreNetwork), mn.proTxHash) : null;
  return <KeyringBadgeRow b={b} request={request} why={why} celebrate={celebrate} />;
}

function Masternodes() {
  const k = useKeyring();
  const labels = useLabels();
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const closeAdd = () => {
    setAddOpen(false);
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const loading = k.mns.phase === 'loading';
  const total = k.mns.owned.length;
  return (
    <section className="kr-card dh-card kr-mns" aria-labelledby="mns-title" aria-busy={loading}>
      <header className="kr-card-head">
        <h2 id="mns-title">Your masternodes</h2>
        {k.mns.phase === 'ready' && (
          <span className="kr-count dh-badge">
            {total}
            <span className="visually-hidden"> found</span>
          </span>
        )}
        <span className="kr-card-actions">
          <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet" onClick={k.refreshMasternodes} disabled={loading || !k.keyInfos.length}>
            Refresh
          </button>
          {!addOpen && (
            <button ref={addButton} type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => setAddOpen(true)} data-testid="addkey-open">
              Add a voting key
            </button>
          )}
        </span>
      </header>
      {addOpen && <AddKey onClose={closeAdd} />}
      <LookupProgress />
      {k.mns.phase === 'error' && (
        <div className="kr-alert" role="alert" data-testid="mn-error">
          <p>
            <b>Your masternodes could not be looked up.</b> {k.mns.error}
          </p>
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={k.refreshMasternodes} data-testid="mn-retry">
            Retry
          </button>
        </div>
      )}
      {k.mns.warning && k.mns.phase === 'ready' && (
        <div className="vwarn small" data-testid="mn-warning">
          <p>{k.mns.warning}</p>
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={k.refreshMasternodes}>
            Retry
          </button>
        </div>
      )}
      {!!k.mns.missing.length && <p className="vwarn small">{k.mns.missing.length} masternode(s) for your keys are in the masternode list but not in the bridge’s list yet; they can vote once the bridge catches up.</p>}
      {!!k.mns.mismatch.length && <p className="kr-alert small">The bridge named a wrong collateral for {k.mns.mismatch.length} masternode(s); they are hidden.</p>}
      {!k.keyInfos.length ? (
        <div className="vempty-line kr-mns-empty" data-testid="mn-empty">
          <p>No voting keys yet. Add one and its masternodes show up here.</p>
        </div>
      ) : (
        <div className="kr-keys" data-testid="key-list">
          {k.keyInfos.map((key, i) => {
            const address = votingAddressOfInfo(key, k.coreNetwork);
            const mine = k.mns.owned.filter((m) => m.keyIndex === i);
            const known = k.mns.phase === 'ready' || (loading && mine.length > 0);
            const name = key.label || `Voting key ${i + 1}`;
            return (
              <section key={address} className="kr-key" aria-label={`Voting key ${key.label || i + 1}`} data-testid="key-group">
                <header className="kr-key-head">
                  <span className="kr-key-name">{name}</span>
                  <span className="kr-key-addr">
                    <span className="mono-ish" title={address}>
                      {shortAddress(address)}
                    </span>
                    <span className="visually-hidden">{address}</span>
                    <CopyButton text={address} label="Copy voting address" />
                  </span>
                  <span data-testid="key-count">
                    {known ? `controls ${mine.length} masternode${mine.length === 1 ? '' : 's'}` : k.mns.phase === 'error' ? 'not looked up' : 'looking up…'}
                  </span>
                  {!k.demo &&
                    (confirmRemove === i ? (
                      <span className="kr-key-remove">
                        <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-danger dh-btn--destructive" onClick={() => void k.removeKey(i).catch(() => {}).finally(() => setConfirmRemove(null))} disabled={!!k.busy}>
                          Remove key
                        </button>
                        <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet" onClick={() => setConfirmRemove(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet kr-key-remove" onClick={() => setConfirmRemove(i)} aria-label={`Remove ${key.label || `voting key ${i + 1}`}`}>
                        Remove
                      </button>
                    ))}
                </header>
                {mine.length > 0 ? (
                  <ul className="kr-mn-list">
                    {mine.map((m) => (
                      <MnRow key={m.proTxHash} m={m} label={labels.get(m.proTxHash.toLowerCase()) ?? ''} />
                    ))}
                  </ul>
                ) : loading ? (
                  <ul className="kr-mn-list" aria-hidden="true">
                    <li className="kr-mn kr-skel" />
                  </ul>
                ) : k.mns.phase === 'ready' ? (
                  <p className="kr-key-empty small muted" data-testid="key-empty">
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

/** Memory-only keys: the one thing worth asking for in the side column. */
function KeepKeys() {
  const k = useKeyring();
  return (
    <section className="kr-card dh-card kr-side-card" aria-labelledby="store-title">
      <h2 id="store-title">Keep these keys</h2>
      <p className="small">Memory-only keys are gone when you sign out. Save them encrypted on Platform to get them back with your recovery phrase.</p>
      <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => void k.saveToPlatform().catch(() => {})} disabled={!!k.busy}>
        Save encrypted on Platform
      </button>
    </section>
  );
}

/** How the saved keyring opens (recovery phrase, passkeys) and when it locks, folded: open by itself only when the list needs confirming. */
function KeyringSettings() {
  const k = useKeyring();
  const ring = k.keyring!;
  const passkeys = ring.content.unlockers.filter((u) => u.type !== UnlockerType.SEED);
  const seeds = ring.content.unlockers.filter((u) => u.type === UnlockerType.SEED);
  const openedBy = ring.openedBy ? bytesToHex(ring.openedBy) : null;
  const opens = opensWith(ring);
  // open by itself when the list needs confirming, and still open after "These are mine"
  const [open, setOpen] = useState(k.needsConfirm);
  useEffect(() => {
    if (k.needsConfirm) setOpen(true);
  }, [k.needsConfirm]);
  const row = (u: (typeof ring.content.unlockers)[number], name: string) => {
    const id = bytesToHex(u.recipientKey);
    return (
      <li key={id} className="kr-unlock">
        <span className="kr-unlock-name">
          {name}
          {openedBy === id && <span className="tag dh-badge tag-info dh-badge--info">opened it now</span>}
        </span>
        <span className="small muted">added {new Date(u.addedAt * 1000).toLocaleDateString()}</span>
        {ring.content.unlockers.length > 1 && (
          <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet" onClick={() => void k.removeUnlockerKey(u.recipientKey).catch(() => {})} disabled={!!k.busy} aria-label={`Remove ${name}`}>
            Remove
          </button>
        )}
      </li>
    );
  };
  return (
    <details className="kr-fold" data-testid="keyring-settings" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="kr-fold-title">Keyring settings</span>
        <span className="small muted">
          {opens ? `Opens with ${opens}.` : 'Nothing can open it again yet.'} Locks after {idleText(ring.content.idleLockMinutes)} idle.
        </span>
      </summary>
      <div className="kr-fold-body">
        {k.needsConfirm && (
          <div className="vwarn small" data-testid="confirm-unlockers">
            <p>
              This keyring could not be verified as yours{ring.authenticated === null ? ' (only your recovery phrase can verify it)' : ''}. Anyone listed here can open it and every key you add. Remove what you do not recognise, then confirm.
            </p>
            <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={k.confirmUnlockers} disabled={!!k.busy}>
              These are mine
            </button>
          </div>
        )}
        <p className="kr-fold-sub">Unlock methods</p>
        <ul className="kr-unlocks" data-testid="unlockers">
          {seeds.map((u) => row(u, 'Recovery phrase'))}
          {passkeys.map((u, i) => row(u, passkeys.length > 1 ? `Passkey ${i + 1}` : 'Passkey'))}
        </ul>
        <div className="kr-passkey">
          <AddPasskey />
        </div>
        <label className="kr-setting dh-field__label">
          <span>Lock after being idle for</span>
          <select className="dh-select" value={ring.content.idleLockMinutes} onChange={(e) => void k.setIdleMinutes(Number(e.target.value)).catch(() => {})} disabled={!!k.busy}>
            {IDLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  );
}

function Privacy() {
  return (
    <details className="kr-fold kr-privacy">
      <summary>
        <span className="kr-fold-title">What’s visible to others</span>
        <span className="small muted">Platform, DAPI evonodes and the relays.</span>
      </summary>
      <ul className="kr-fold-body small">
        <li>Platform sees that you have a keyring, its size class and when it changes; not your keys, nor how many masternodes you have.</li>
        <li>DAPI evonodes you ask about your masternodes see your IP with those masternodes.</li>
        <li>The relay sees which votes came from your IP, and when. Once broadcast, a vote is public like any masternode vote.</li>
      </ul>
    </details>
  );
}

/**
 * "Also open your masternodes with your passkey?": after a keyring was first saved in a passkey session, or the phrase opened it
 * because that passkey could not. One click, one passkey prompt (the passkey that signed in); never on its own.
 */
function PasskeyOffer() {
  const k = useKeyring();
  const [done, setDone] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (k.passkeyOffer) setDone(false);
  }, [k.passkeyOffer]);
  if (done)
    return (
      <p className="kr-offer kr-offer-done small" role="status" data-testid="passkey-offer-done">
        <span>Done. Signing in with your passkey now unlocks your masternodes too.</span>
        <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet" onClick={() => setDone(false)}>
          Dismiss
        </button>
      </p>
    );
  if (!k.passkeyOffer) return null;
  const use = async () => {
    setWorking(true);
    try {
      await k.addPasskeyUnlocker({ signedIn: true });
      setDone(true);
    } catch {
      /* shown by the provider */
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="kr-offer" aria-labelledby="passkey-offer-title" data-testid="passkey-offer">
      <svg className="kr-offer-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="7.5" cy="9" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M11 9h7M15.5 9v2.75M17.75 9v2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <div className="kr-offer-text">
        <p id="passkey-offer-title">
          <b>{k.passkeyOffer === 'unlocked' ? 'Use your passkey to unlock next time?' : 'Also open your masternodes with your passkey?'}</b>
        </p>
        <p className="small muted">One passkey prompt now. After that, signing in with this passkey unlocks your masternodes too, no recovery phrase needed.</p>
      </div>
      <div className="kr-offer-actions">
        <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-primary dh-btn--primary" onClick={() => void use()} disabled={working || !!k.busy} data-testid="passkey-offer-use">
          {working ? 'Waiting for the passkey…' : 'Use my passkey'}
        </button>
        <button type="button" className="btn dh-btn btn-s dh-btn--sm btn-quiet dh-btn--quiet" onClick={k.dismissPasskeyOffer} disabled={working} data-testid="passkey-offer-dismiss">
          Not now
        </button>
      </div>
    </section>
  );
}

/** After "Add your masternodes": one line saying what happened to the key, with a dismiss. The badge's own status is in its card only. */
function AddedBanner({ added, onClose }: { added: Added; onClose(): void }) {
  const { n, saved, asked, note } = added;
  return (
    <section className="kr-done" role="status" aria-labelledby="flow-done-title" data-testid="flow-done">
      <svg className="kr-done-mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path d="M6 10.4l2.6 2.6L14.2 7.4" fill="none" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="kr-done-text">
        <p id="flow-done-title">
          <b>
            {n} masternode{n === 1 ? '' : 's'} added.
          </b>{' '}
          {saved
            ? 'Your voting key is saved encrypted on Platform.'
            : `Your voting key is in memory only: it is gone when you sign out or close the tab${asked ? ', except the badge request’s own copy (never in plain text), deleted once it is sent or cancelled' : ''}.`}
        </p>
        {note && (
          <p className="kr-done-note small" data-testid="flow-badge-note">
            {note}
          </p>
        )}
      </div>
      <button type="button" className="btn dh-btn btn-s dh-btn--sm kr-done-close" onClick={onClose} data-testid="flow-close">
        Dismiss
      </button>
    </section>
  );
}

/**
 * Signed out: what each way of voting needs, before anything is asked for. A keyring that keeps voting keys belongs to an account (a
 * Platform identity); offline signing and voting keys pasted for one tab need none.
 */
function WaysToVote() {
  const k = useKeyring();
  return (
    <section className="kr-card dh-card kr-gate vote-ways" aria-labelledby="vote-ways-title" data-testid="vote-ways">
      <h2 id="vote-ways-title">Three ways to vote</h2>
      <ol className="vote-ways-list">
        <li>
          <h3>Proposals, from your account</h3>
          <p>
            Needs an account here and each masternode's voting key. The account is a Dash Platform identity: create one for about 0.005 DASH,
            or sign in with one you have. It keeps your voting keys in an encrypted keyring that comes back when you sign in again, or only in
            this tab's memory if you prefer. Votes are signed in your browser.
          </p>
          <button type="button" className="btn dh-btn" onClick={openSignIn} data-testid="vote-ways-signin">
            Sign in or create an account
          </button>
        </li>
        <li>
          <h3>Proposals, without an account</h3>
          <p>
            Each open proposal has <b>Vote on this proposal</b>. Sign the vote offline:{' '}
            {k.coreNetwork === 'testnet'
              ? 'on Testnet, sign its vote hash with your own tooling (Dash Core’s signmessage can’t make that signature), or broadcast it yourself with voteraw.'
              : 'the page gives the Dash Core signmessage command, or the text for a hardware wallet.'}{' '}
            Or paste the voting key there: it stays in that tab’s memory and is forgotten after 15 minutes idle.
          </p>
          <Link to="/">Choose a proposal</Link>
        </li>
        <li>
          <h3>Name contests, without an account</h3>
          <p>Paste a voting key on a contest's page. It stays in this tab's memory, signs only contest votes, and is wiped after 15 minutes idle.</p>
          <Link to="/names">Open name contests</Link>
        </li>
      </ol>
      <p className="small muted">Masternode owners with an account can also show an MN badge next to their name in discussions.</p>
    </section>
  );
}

export function MasternodesPage() {
  useRouteTitle('/masternodes');
  const k = useKeyring();
  const { openSheet } = useAuth();
  const b = useMnBadge();
  const { hash, search, key: navKey } = useLocation();
  const requestedProTx = new URLSearchParams(search).get('proTx') || '';
  const proTx = /^[a-f0-9]{64}$/i.test(requestedProTx) ? requestedProTx.toLowerCase() : null;
  // Radar's older links (/masternodes?proTx=<hash>) land on the masternode's own page, with the rest of the query (the network) kept
  // the flow stays on screen while the key it adds opens the keyring (null: not adding)
  const [flow, setFlow] = useState<FlowStep | null>(null);
  // what the flow's confirm did, for the banner it ends in
  const [added, setAdded] = useState<Added | null>(null);
  // "Use memory-only keys instead" on a locked keyring starts the same flow, memory only (null: not asked)
  const [fromUnlock, setFromUnlock] = useState(false);
  useEffect(() => {
    if (k.status === 'signed-out' || k.status === 'checking') {
      setFlow(null);
      setFromUnlock(false);
    }
    // locked (Lock now, the idle lock) while the "added" banner shows: back to Unlock, not into a new add flow
    else if (k.status !== 'open') setFlow((f) => (f === 'done' ? null : f));
  }, [k.status]);
  const fromLocked = (k.status === 'locked' || k.status === 'error') && flow !== null && flow !== 'done';
  const adding = k.status === 'absent' || fromLocked || (k.status === 'open' && flow !== null && flow !== 'done');
  const showGrid = k.status === 'open' && !!k.keyring && (flow === null || flow === 'done');
  // "Get an MN badge" links land here (#mn-badge): the flow, or the badge card; once per navigation
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (hash !== '#mn-badge' || scrolled.current === navKey) return;
    const el = document.getElementById(adding ? 'create-title' : 'mn-badge');
    if (!el) return; // not rendered yet (the keyring is still being looked for)
    scrolled.current = navKey;
    el.scrollIntoView({ block: 'start' });
  }, [hash, navKey, adding, showGrid]);
  if (proTx) {
    const rest = new URLSearchParams(search);
    rest.delete('proTx');
    return <Navigate replace to={{ pathname: `/masternodes/${proTx}`, search: rest.toString() ? `?${rest}` : '' }} />;
  }
  return (
    <section className="kr-page" aria-labelledby="mn-page-title">
      <Header adding={adding} badgeKeyKept={b.status.kind === 'pending' && b.status.job.signer.kind === 'wif'} />
      {k.busy && (
        <p className="kr-busy small" role="status">
          <span className="spinner" aria-hidden="true" /> {k.busy}…
        </p>
      )}
      {k.error && (
        <div className="kr-alert" role="alert" data-testid="keyring-error">
          <p>{k.error}</p>
          {k.needsTopUp && (
            <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => openSheet('topup')} data-testid="keyring-topup">
              Top up
            </button>
          )}
        </div>
      )}
      {k.status === 'signed-out' && <WaysToVote />}
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
      {adding && <AddMasternodes step={flow} setStep={setFlow} b={b} savedLocked={fromUnlock} onAdded={setAdded} />}
      {showGrid && flow === 'done' && added && <AddedBanner added={added} onClose={() => setFlow(null)} />}
      {showGrid && <PasskeyOffer />}
      {showGrid && (
        <div className="kr-grid">
          <div className="kr-main">
            <Masternodes />
            <VotesList />
          </div>
          <aside className="kr-side" aria-label="MN badge and keyring settings">
            <BadgeRow b={b} celebrate={flow === 'done' && !!added?.asked} />
            {k.memoryOnly && !k.demo && <KeepKeys />}
            <div className="kr-card dh-card kr-folds">
              {!k.memoryOnly && !k.demo && <KeyringSettings />}
              <Privacy />
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
