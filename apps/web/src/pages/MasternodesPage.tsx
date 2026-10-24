// /masternodes: the keyring ("add my masternodes"). Voting keys, the masternodes each one controls, labels, how the keyring is
// stored and unlocked, and offline signing.
import { bytesToHex, UnlockerType } from '@govhub/auth';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { useAuth } from '../auth/context.tsx';
import { shortHash } from '../lib/format.ts';
import { openSignIn } from '../ui/SignIn.tsx';
import { WatchedList } from '../ui/VotePanel.tsx';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { votingAddressOf } from '../voting/masternodes.ts';
import '../voting/voting.css';

const IDLE_CHOICES = [5, 15, 30, 60, 240];

function KeyringStatusLine() {
  const k = useKeyring();
  const { session } = useAuth();
  const ring = k.keyring;
  if (k.status === 'fixtures') return <p className="notice-box">Voting needs live data. Switch to live data in Settings.</p>;
  if (k.status === 'signed-out')
    return (
      <div className="notice-box">
        <p>Sign in to keep your masternode voting keys in an encrypted keyring that comes back whenever you sign in again.</p>
        <button type="button" className="btn btn-primary" onClick={openSignIn}>
          Sign in
        </button>
      </div>
    );
  if (k.status === 'checking') return <p className="muted"><span className="spinner" aria-hidden="true" /> Looking for your keyring on Platform…</p>;
  if (k.status === 'open' && ring) {
    const seeds = ring.content.unlockers.filter((u) => u.type === UnlockerType.SEED).length;
    const passkeys = ring.content.unlockers.length - seeds;
    return (
      <p className="notice-box" data-testid="keyring-status">
        {k.memoryOnly ? (
          <span>
            <b>Memory only.</b> Neither the keys nor the votes you sign are saved anywhere; they are wiped when you sign out, close the tab or after {ring.content.idleLockMinutes} idle minutes.
          </span>
        ) : (
          <span>
            <b>Saved on Platform, encrypted in this browser.</b> It opens with {seeds ? 'your recovery phrase' : ''}
            {seeds && passkeys ? ' and ' : ''}
            {passkeys ? `${passkeys} passkey${passkeys > 1 ? 's' : ''}` : ''}. govhub never sees the keys. It locks after {ring.content.idleLockMinutes} idle minutes.
          </span>
        )}
      </p>
    );
  }
  if (k.status === 'locked' && session?.source === 'key')
    return (
      <p className="notice-box" data-testid="keyring-keypaste">
        You signed in with a pasted key. A saved keyring is encrypted to your recovery phrase and passkeys, so a pasted key cannot open it. Unlock it with your phrase or a passkey below, or use a memory-only keyring.
      </p>
    );
  return null;
}

function Unlock() {
  const k = useKeyring();
  const [phrase, setPhrase] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await k.unlockWithPhrase(phrase).catch(() => {});
    setPhrase('');
  };
  return (
    <section className="form" aria-labelledby="unlock-title">
      <h2 id="unlock-title">Unlock your keyring</h2>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => void k.unlockWithPasskey().catch(() => {})} disabled={!!k.busy}>
          Unlock with a passkey
        </button>
      </div>
      <form onSubmit={submit} className="form">
        <label>
          Or type your recovery phrase
          <input type="password" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} data-testid="unlock-phrase" />
        </label>
        <div className="form-actions">
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
    <section className="form" aria-labelledby="create-title">
      <h2 id="create-title">Add your masternodes</h2>
      <p>
        Paste a masternode <b>voting key</b>. govhub finds every masternode that key votes for, and you can vote with all of them from any proposal.
      </p>
      <ul className="small muted">
        <li>
          <b>Save encrypted on Platform</b>: the keys are encrypted in this browser to your recovery phrase (and any passkeys you add) and stored in a document only you can open. Sign in again on any device and they are back.
        </li>
        <li>
          <b>Memory only</b>: nothing is stored, not even the votes you sign; the keys are gone when you sign out or close the tab.
        </li>
      </ul>
      <p className="small muted">Saving writes an encrypted document with your identity's credits: about 0.0016 DASH the first time, and a little for each change.</p>
      {!canSave && <p className="notice-box small">Saving needs your recovery phrase in this session (sign in with it, or with a passkey that keeps it). A pasted key cannot open a saved keyring.</p>}
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => void k.createKeyring(false).catch(() => {})} disabled={!canSave || !!k.busy} data-testid="create-keyring">
          Save encrypted on Platform
        </button>
        <button type="button" className="btn" onClick={() => void k.createKeyring(true).catch(() => {})} disabled={!!k.busy} data-testid="memory-keyring">
          Memory only
        </button>
      </div>
    </section>
  );
}

function AddKey() {
  const k = useKeyring();
  const [wif, setWif] = useState('');
  const [label, setLabel] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await k.addKey(wif, label);
      setWif('');
      setLabel('');
    } catch {
      /* shown by the provider */
    }
  };
  return (
    <form className="form vote-addkey" onSubmit={submit} aria-label="Add a voting key">
      <label>
        Voting key ({k.coreNetwork} WIF)
        <input type="password" value={wif} onChange={(e) => setWif(e.target.value)} autoComplete="off" spellCheck={false} data-testid="voting-key-input" />
      </label>
      <label>
        Label (optional)
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={32} data-testid="voting-key-label" />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!wif.trim() || !!k.busy} data-testid="voting-key-add">
          {k.busy === 'Adding the voting key' ? 'Adding…' : 'Add key'}
        </button>
      </div>
      <p className="small muted">Only the voting key. Never paste an owner, collateral or payout key here: a voting key can only vote.</p>
    </form>
  );
}

function NodeLabel({ pro, value }: { pro: string; value: string }) {
  const k = useKeyring();
  const [v, setV] = useState(value);
  return (
    <input
      className="vote-label-input"
      aria-label={`Label for ${shortHash(pro)}`}
      value={v}
      maxLength={32}
      placeholder="label"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && void k.setNodeLabel(pro, v).catch(() => {})}
    />
  );
}

function Masternodes() {
  const k = useKeyring();
  const ring = k.keyring!;
  const labels = new Map(ring.content.labels.map((l) => [l.proTxHash, l.label]));
  return (
    <section aria-labelledby="mns-title">
      <h2 id="mns-title">
        Masternodes {k.mns.loading && <span className="spinner" aria-hidden="true" />}
        <button type="button" className="btn btn-s btn-quiet" onClick={k.refreshMasternodes}>
          Refresh
        </button>
      </h2>
      {k.mns.error && <p className="error small">{k.mns.error}</p>}
      {!!k.mns.missing.length && <p className="small muted">{k.mns.missing.length} masternode(s) for your keys are in the masternode list but not in the bridge's list yet; they can vote once the bridge catches up.</p>}
      {!!k.mns.mismatch.length && <p className="error small">The bridge named a wrong collateral for {k.mns.mismatch.length} masternode(s); they are hidden.</p>}
      {k.mns.smlNodes > 0 && <p className="small muted">Matched against the masternode list {k.mns.smlNodes} DAPI nodes agreed on; collateral outpoints proved from each ProRegTx.</p>}
      <div className="vote-table-wrap">
        <table className="vote-table" data-testid="mn-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>proTxHash</th>
              <th>Type</th>
              <th>Status</th>
              <th>Payout (registered)</th>
              <th>Key</th>
            </tr>
          </thead>
          <tbody>
            {k.mns.owned.map((m) => (
              <tr key={m.proTxHash} data-testid="mn-row">
                <td>
                  <NodeLabel pro={m.proTxHash} value={labels.get(m.proTxHash) ?? ''} />
                </td>
                <td className="mono-ish" title={m.proTxHash}>
                  {shortHash(m.proTxHash, 8)}
                  {m.provenance.key === 'bridge' && <span className="chip" title="Only the bridge says this key votes for this masternode (no DAPI masternode list available)">bridge</span>}
                </td>
                <td>{m.type === 'evo' ? 'Evonode (4 votes)' : 'Regular'}</td>
                <td>{m.valid ? 'Valid' : <span className="chip chip-bad">PoSe-banned: cannot vote</span>}</td>
                <td className="mono-ish small">{m.payoutAddress ?? '—'}</td>
                <td className="small">{ring.content.keys[m.keyIndex]?.label || `key ${m.keyIndex + 1}`}</td>
              </tr>
            ))}
            {!k.mns.owned.length && !k.mns.loading && (
              <tr>
                <td colSpan={6} className="muted">
                  {ring.content.keys.length ? 'No registered masternode uses these voting keys.' : 'Add a voting key above.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Keys() {
  const k = useKeyring();
  const ring = k.keyring!;
  const count = (i: number) => k.mns.owned.filter((m) => m.keyIndex === i).length;
  return (
    <section aria-labelledby="keys-title">
      <h2 id="keys-title">Voting keys</h2>
      <ul className="vote-keys" data-testid="key-list">
        {ring.content.keys.map((key, i) => (
          <li key={i}>
            <span className="mono-ish">{votingAddressOf(key.privateKey, key.compressed, k.coreNetwork)}</span> {key.label && <b>{key.label}</b>}{' '}
            <span className="muted small">{count(i)} masternode(s)</span>{' '}
            <button type="button" className="btn btn-s btn-danger" onClick={() => void k.removeKey(i).catch(() => {})} disabled={!!k.busy}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Unlockers() {
  const k = useKeyring();
  const ring = k.keyring!;
  if (k.memoryOnly) {
    return (
      <section className="form" aria-labelledby="store-title">
        <h2 id="store-title">Keep these keys</h2>
        <p>Save them encrypted on Platform so they come back when you sign in again with your recovery phrase.</p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => void k.saveToPlatform().catch(() => {})} disabled={!!k.busy}>
            Save encrypted on Platform
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="form" aria-labelledby="unlockers-title">
      <h2 id="unlockers-title">Who can open this keyring</h2>
      {k.needsConfirm && (
        <div className="notice-box" data-testid="confirm-unlockers">
          <p>
            This keyring could not be verified as yours{ring.authenticated === null ? ' (only your recovery phrase can verify it)' : ''}. Anyone in this list can open it and every key you add. Remove what you do not recognise, then confirm.
          </p>
          <button type="button" className="btn" onClick={k.confirmUnlockers}>
            These are mine
          </button>
        </div>
      )}
      <ul className="vote-keys" data-testid="unlockers">
        {ring.content.unlockers.map((u) => (
          <li key={bytesToHex(u.recipientKey)}>
            {u.type === UnlockerType.SEED ? 'Recovery phrase' : 'Passkey'} <span className="mono-ish small muted">{bytesToHex(u.recipientKey).slice(0, 16)}</span>{' '}
            {ring.openedBy && bytesToHex(ring.openedBy) === bytesToHex(u.recipientKey) && <span className="chip">opened it now</span>}{' '}
            <span className="small muted">added {new Date(u.addedAt * 1000).toLocaleDateString()}</span>{' '}
            {ring.content.unlockers.length > 1 && (
              <button type="button" className="btn btn-s btn-quiet" onClick={() => void k.removeUnlockerKey(u.recipientKey).catch(() => {})} disabled={!!k.busy}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => void k.addPasskeyUnlocker().catch(() => {})} disabled={!!k.busy}>
          Add a passkey that can open it
        </button>
        <label>
          Lock after{' '}
          <select value={ring.content.idleLockMinutes} onChange={(e) => void k.setIdleMinutes(Number(e.target.value)).catch(() => {})} disabled={!!k.busy}>
            {IDLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>{' '}
          idle
        </label>
      </div>
      <p className="small muted">
        What Platform can see: that you have a keyring, its size class (up to 32 keys, or up to 96) and when it changes. Not how many keys or masternodes you have. To check which masternodes your keys control, this browser asks DAPI evonodes for their registration transactions: those nodes see your IP with those masternodes.
      </p>
    </section>
  );
}

export function MasternodesPage() {
  const k = useKeyring();
  const { registry } = useApp();
  return (
    <section className="list-section vote-page" aria-labelledby="mn-page-title">
      <h1 id="mn-page-title">My masternodes</h1>
      <KeyringStatusLine />
      {k.busy && (
        <p className="muted" role="status">
          <span className="spinner" aria-hidden="true" /> {k.busy}…
        </p>
      )}
      {k.error && (
        <p className="error" role="alert" data-testid="keyring-error">
          {k.error}
        </p>
      )}
      {!registry.relays.length && k.status === 'open' && <p className="notice-box small">No relay is configured, so votes cannot be sent. Add one in Settings.</p>}
      {(k.status === 'locked' || k.status === 'error') && <Unlock />}
      {k.status === 'absent' && <Create />}
      {k.status === 'open' && k.keyring && (
        <>
          <div className="form-actions">
            <Link className="btn btn-primary" to="/votes">
              Vote on active proposals
            </Link>
            <button type="button" className="btn" onClick={k.lock} data-testid="keyring-lock">
              Lock now
            </button>
          </div>
          <AddKey />
          {!!k.keyring.content.keys.length && <Keys />}
          <Masternodes />
          <Unlockers />
          <WatchedList />
        </>
      )}
    </section>
  );
}
