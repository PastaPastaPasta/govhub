// Passkey sign-in and the passkey list (add / remove). A passkey is used only for its WebAuthn PRF output; the session (seed or
// key) is sealed to the X25519 key derived from it and kept in a `forum.vault` document on Platform (@govhub/auth vault).
// Without PRF support nothing is written: the provider is told to drop the new passkey and the user keeps their phrase.
import { identifierBytes, localPasskeys, openVault, prfInput, removePasskey, toBase64, wipe, type VaultEntryDoc } from '@govhub/auth';
import { forgetPasskey, getPasskeyPrf, PRF_UNAVAILABLE_MESSAGE } from '@govhub/auth/webauthn';
import { useState } from 'react';
import { useAuth } from './context.tsx';
import { errorText, rpId } from './runtime.ts';
import { isCancelled, usePasskeyCreate, usePrfSupport } from './usePasskeyCreate.ts';
import { stashPasskeyUnlock } from '../voting/stash.ts';

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
  const { session, refreshBalance } = useAuth();
  // an open masternode keyring gets a new passkey as an unlocker too
  const { support, step, error, setError, create, confirm, entries, setEntries, ctx } = usePasskeyCreate({
    onSaved: (prf, identityId) => stashPasskeyUnlock(identityId, prf, 'add'),
  });

  if (!session) return <p className="muted">Sign in first.</p>;
  const mine = new Set(localPasskeys.list(localStorage, session.identityId));

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
