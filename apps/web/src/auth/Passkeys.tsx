// Passkey sign-in and the passkey list (add / remove). A passkey is used only for its WebAuthn PRF output; the session (seed or
// key) is sealed to the X25519 key derived from it and kept in a `forum.vault` document on Platform (@govhub/auth vault).
// Without PRF support nothing is written: the provider is told to drop the new passkey and the user keeps their phrase.
import {
  identifierBytes, listPasskeys, localPasskeys, openVault, prfInput, removePasskey, storeInVault, toBase64, waitForEntry, wipe, type VaultEntryDoc,
} from '@govhub/auth';
import { bytesEqual } from '@govhub/verify';
import { createPasskey, forgetPasskey, getPasskeyPrf, PasskeyError, prfSupport, PRF_UNAVAILABLE_MESSAGE, userHandleFor } from '@govhub/auth/webauthn';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './context.tsx';
import { errorText, rpId } from './runtime.ts';
import { stashPasskeyUnlock } from '../voting/stash.ts';

const isCancelled = (e: unknown): boolean => e instanceof PasskeyError && e.code === 'cancelled';

function usePrfSupport() {
  const [s, setS] = useState<'yes' | 'no' | 'unknown' | null>(null);
  useEffect(() => void prfSupport().then(setS), []);
  return s;
}

export function PasskeySignIn() {
  const { forumContractId, platform, signIn, closeSheet } = useAuth();
  const support = usePrfSupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      const a = await getPasskeyPrf({ rpId: rpId(), prfInput: prfInput(identifierBytes(forumContractId)) });
      try {
        const s = await openVault({ platform: await platform(), contractId: forumContractId }, a);
        // the same PRF output opens the masternode keyring (voting/stash.ts): no second passkey prompt
        stashPasskeyUnlock(s.identityId, a.prfOutput);
        signIn(s);
      } finally {
        wipe(a.prfOutput);
      }
      closeSheet();
    } catch (e) {
      setError(isCancelled(e) ? null : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {support === 'no' ? (
        <p className="notice-box">This browser can't use passkeys to keep a govhub sign-in. Use your recovery phrase instead.</p>
      ) : (
        <>
          <p>Choose the passkey you added to govhub. Your device unlocks the key it keeps; nothing is sent to a server.</p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>
              {busy ? <><span className="spinner" aria-hidden="true" /> Opening…</> : 'Use a passkey'}
            </button>
          </div>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export function Passkeys() {
  const { session, forumContractId, platform, refreshBalance } = useAuth();
  const support = usePrfSupport();
  const [entries, setEntries] = useState<VaultEntryDoc[] | null>(null);
  const [step, setStep] = useState<'idle' | 'confirm' | 'saving' | 'done'>('idle');
  const [created, setCreated] = useState<{ credentialId: Uint8Array; prf: Uint8Array | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctx = useCallback(async () => ({ platform: await platform(), contractId: forumContractId }), [platform, forumContractId]);

  const reload = useCallback(() => {
    if (!session) return;
    ctx()
      .then((c) => listPasskeys(c, session.identityId))
      .then(setEntries, (e) => setError(errorText(e)));
  }, [ctx, session]);
  useEffect(reload, [reload]);
  useEffect(() => () => wipe(created?.prf), [created]);

  if (!session) return <p className="muted">Sign in first.</p>;
  const mine = new Set(localPasskeys.list(localStorage, session.identityId));
  const pi = prfInput(identifierBytes(forumContractId));

  const create = async () => {
    setError(null);
    try {
      const c = await createPasskey({
        rpId: rpId(), rpName: 'govhub', userHandle: userHandleFor(session.identityId, forumContractId), userName: `govhub ${session.identityId.slice(0, 10)}…`, prfInput: pi,
        exclude: entries?.map((e) => e.credentialId),
      });
      setCreated({ credentialId: c.credentialId, prf: c.prfOutput });
      setStep('confirm');
    } catch (e) {
      if (!isCancelled(e)) setError(errorText(e));
    }
  };
  // A second ceremony restricted to the new passkey: the PRF it gives is what the entry is sealed to (and must equal the create-time one).
  const confirm = async () => {
    if (!created) return;
    setError(null);
    let prf: Uint8Array | null = null;
    try {
      const a = await getPasskeyPrf({ rpId: rpId(), prfInput: pi, allow: [created.credentialId] });
      prf = a.prfOutput;
      // compared as bytes: a base64 string copy of the PRF output could never be wiped
      if (created.prf && !bytesEqual(created.prf, prf)) throw new PasskeyError('This passkey gave two different keys. It cannot be used.', 'failed');
      setStep('saving');
      const c = await ctx();
      const recipient = await storeInVault(c, session, a);
      // an open masternode keyring gets this passkey as an unlocker too
      stashPasskeyUnlock(session.identityId, a.prfOutput, 'add');
      await waitForEntry(c, session.identityId, created.credentialId, recipient);
      localPasskeys.add(localStorage, session.identityId, toBase64(created.credentialId));
      setStep('done');
      refreshBalance();
      reload();
    } catch (e) {
      if (e instanceof PasskeyError && e.code === 'no-prf') {
        await forgetPasskey(rpId(), created.credentialId);
        setError(PRF_UNAVAILABLE_MESSAGE);
        setStep('idle');
      } else if (isCancelled(e)) {
        // keep the confirm button
      } else {
        setError(errorText(e));
        setStep('confirm');
      }
    } finally {
      wipe(prf);
    }
  };
  const remove = async (entry: VaultEntryDoc) => {
    setError(null);
    try {
      await removePasskey(await ctx(), session, entry);
      setEntries((l) => l?.filter((x) => x !== entry) ?? null);
      const id = toBase64(entry.credentialId);
      localPasskeys.remove(localStorage, session.identityId, id);
      if (mine.has(id)) await forgetPasskey(rpId(), entry.credentialId);
      refreshBalance();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="passkeys">
      <p>
        A passkey keeps your {session.wallet ? 'recovery phrase' : 'sign-in key'} encrypted on Platform so you can sign in on any device with that passkey. Only the passkey can open it. Saving
        costs about 0.0005 DASH of credit.
      </p>
      {support === 'no' && <p className="notice-box">{PRF_UNAVAILABLE_MESSAGE}</p>}
      {step === 'idle' && support !== 'no' && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={create}>
            Add a passkey
          </button>
        </div>
      )}
      {step === 'confirm' && (
        <div className="notice-box">
          <p>Passkey created. Confirm it once more so govhub can lock your key to it.</p>
          <button type="button" className="btn btn-primary" onClick={confirm}>
            Confirm with the passkey
          </button>
        </div>
      )}
      {step === 'saving' && (
        <p className="muted" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Saving the encrypted entry on Platform…
        </p>
      )}
      {step === 'done' && <p className="notice" data-testid="passkey-saved">Passkey added. You can now sign in with it.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <h3>Passkeys for this identity</h3>
      {entries === null ? (
        <p className="muted small">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="passkey-list">
          {entries.map((e) => (
            <li key={e.id}>
              <span className="mono-ish">{toBase64(e.credentialId).slice(0, 12)}…</span>
              <span className="muted small">
                {mine.has(toBase64(e.credentialId)) ? 'this device' : 'another device'}
                {e.createdAt ? ` · added ${new Date(e.createdAt).toLocaleDateString()}` : ''}
              </span>
              <button type="button" className="btn btn-quiet" onClick={() => remove(e)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {entries && entries.some((e) => !mine.has(toBase64(e.credentialId))) && (
        <p className="muted small">Remove any passkey you don't recognise: anyone who once held one of your keys could have added it.</p>
      )}
    </div>
  );
}
