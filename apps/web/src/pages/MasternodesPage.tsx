// /masternodes: the keyring ("add my masternodes"). Your masternodes grouped by the voting key they came from, your votes, adding
// a key, and how the keyring opens and locks.
import { bytesToHex, UnlockerType } from '@govhub/auth';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/context.tsx';
import { shortAddress } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { CopyButton, HashCopy, useLabels, useNow } from '../ui/vote/common.tsx';
import { VotesList } from '../ui/vote/VotesList.tsx';
import { KeyCheckError, useKeyring } from '../voting/KeyringContext.tsx';
import { STEP_NAME } from '../voting/lookup.ts';
import { votingAddressOf, votingKeyId, type OwnedMasternode } from '../voting/masternodes.ts';
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

function Header() {
  const k = useKeyring();
  const open = k.status === 'open' && !!k.keyring;
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

function Unlock() {
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
          <button type="button" className="btn btn-quiet" onClick={() => void k.createKeyring(true).catch(() => {})} disabled={!!k.busy}>
            Use memory-only keys instead
          </button>
        </div>
      </form>
    </section>
  );
}

function Create() {
  const k = useKeyring();
  const { session } = useAuth();
  const canSave = !!session?.wallet;
  return (
    <section className="kr-card kr-gate" aria-labelledby="create-title">
      <h2 id="create-title">Add your masternodes</h2>
      <p>Paste a masternode voting key once; govhub finds every masternode it votes for. Choose where the key lives:</p>
      <div className="kr-choice">
        <div>
          <button type="button" className="btn btn-primary" onClick={() => void k.createKeyring(false).catch(() => {})} disabled={!canSave || !!k.busy} data-testid="create-keyring">
            Save encrypted on Platform
          </button>
          <p className="small muted">Encrypted in this browser to your recovery phrase (and passkeys you add). Back on any device when you sign in. About 0.003 DASH in credits for each save.</p>
        </div>
        <div>
          <button type="button" className="btn" onClick={() => void k.createKeyring(true).catch(() => {})} disabled={!!k.busy} data-testid="memory-keyring">
            Memory only
          </button>
          <p className="small muted">Nothing is stored, not even the votes you sign. Gone when you sign out or close the tab.</p>
        </div>
      </div>
      {!canSave && <p className="vwarn small">Saving needs your recovery phrase in this session (sign in with it, or with a passkey that keeps it).</p>}
    </section>
  );
}

function AddKey() {
  const k = useKeyring();
  const [wif, setWif] = useState('');
  const [label, setLabel] = useState('');
  const [added, setAdded] = useState<{ keyId: string; label: string } | null>(null);
  /** the masternode-list check refused the key but it may be added anyway (it votes for no masternode in the list) */
  const [canForce, setCanForce] = useState(false);
  const add = async (force: boolean) => {
    setCanForce(false);
    try {
      const keyId = await k.addKey(wif, label, { force });
      setAdded({ keyId, label: label.trim() });
      setWif('');
      setLabel('');
    } catch (e) {
      /* shown by the provider */
      setCanForce(e instanceof KeyCheckError && e.canForce);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add(false);
  };
  // what the new key found, once the lookup that includes it is done
  const ring = k.keyring;
  const idx = added && ring ? ring.content.keys.findIndex((x) => votingKeyId(x.privateKey, x.compressed) === added.keyId) : -1;
  const ready = added && idx >= 0 && k.mns.forKeys.includes(added.keyId) && k.mns.phase !== 'loading';
  const found = ready ? k.mns.owned.filter((m) => m.keyIndex === idx).length : 0;
  const adding = k.busy === 'Adding the voting key';
  return (
    <section className="kr-card" aria-labelledby="addkey-title">
      <h2 id="addkey-title">Add a voting key</h2>
      <form className="kr-form" onSubmit={submit} aria-label="Add a voting key">
        <label className="kr-field">
          <span>Voting private key ({k.coreNetwork}, as Dash Core shows it)</span>
          <input type="password" value={wif} onChange={(e) => (setWif(e.target.value), setCanForce(false))} autoComplete="off" spellCheck={false} data-testid="voting-key-input" aria-describedby="addkey-warn" />
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
        {canForce && wif.trim() && (
          <button type="button" className="btn btn-s btn-quiet" onClick={() => void add(true)} disabled={!!k.busy} data-testid="voting-key-force">
            I’m sure it is a voting key: add it anyway
          </button>
        )}
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

function Masternodes() {
  const k = useKeyring();
  const ring = k.keyring!;
  const labels = useLabels();
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const loading = k.mns.phase === 'loading';
  const total = k.mns.owned.length;
  return (
    <section className="kr-card kr-mns" aria-labelledby="mns-title" aria-busy={loading}>
      <header className="kr-card-head">
        <h2 id="mns-title">Your masternodes</h2>
        {k.mns.phase === 'ready' && <span className="small muted">{total} found</span>}
        <button type="button" className="btn btn-s btn-quiet kr-refresh" onClick={k.refreshMasternodes} disabled={loading || !ring.content.keys.length}>
          Refresh
        </button>
      </header>
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
      {!ring.content.keys.length ? (
        <div className="vempty-line" data-testid="mn-empty">
          <p>No voting keys yet. Add one and its masternodes show up here.</p>
        </div>
      ) : (
        <div className="kr-keys" data-testid="key-list">
          {ring.content.keys.map((key, i) => {
            const address = votingAddressOf(key.privateKey, key.compressed, k.coreNetwork);
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
      <button type="button" className="btn btn-s" onClick={() => void k.addPasskeyUnlocker().catch(() => {})} disabled={!!k.busy}>
        Add a passkey
      </button>
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
  return (
    <section className="kr-page" aria-labelledby="mn-page-title">
      <Header />
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
          <p>Your voting keys are kept in an encrypted keyring that comes back whenever you sign in again.</p>
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
      {(k.status === 'locked' || k.status === 'error') && <Unlock />}
      {k.status === 'absent' && <Create />}
      {k.status === 'open' && k.keyring && (
        <div className="kr-grid">
          <div className="kr-main">
            <Masternodes />
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
