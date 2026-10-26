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

  const what = session.wallet ? 'recovery phrase' : 'sign-in key';
  return (
    <div className="passkeys">
      <div className="passkeys-intro">
        <p>Sign in on any device with a passkey, instead of typing your {what}.</p>
        <p className="muted small">
          Your {what} is stored encrypted on Platform, and only the passkey can open it. Adding one costs about 0.0005 DASH from your balance.
        </p>
      </div>
      {support === 'no' && <p className="notice-box">{PRF_UNAVAILABLE_MESSAGE}</p>}

      <section className="passkeys-box" aria-labelledby="passkeys-mine">
        <h3 id="passkeys-mine">Your passkeys</h3>
        {entries === null ? (
          <p className="muted small passkeys-empty">
            <span className="spinner" aria-hidden="true" /> Loading…
          </p>
        ) : entries.length === 0 ? (
          <p className="muted small passkeys-empty">No passkeys yet.</p>
        ) : (
          <ul className="passkey-list">
            {entries.map((e) => {
              const here = mine.has(toBase64(e.credentialId));
              return (
                <li key={e.id}>
                  <div className="passkey-what">
                    <b>{here ? 'This device' : 'Another device'}</b>
                    <span className="muted small">
                      {e.createdAt ? `Added ${new Date(e.createdAt).toLocaleDateString()} · ` : ''}
                      <span className="mono-ish">{toBase64(e.credentialId).slice(0, 12)}…</span>
                    </span>
                  </div>
                  <button type="button" className="btn btn-quiet btn-s" onClick={() => remove(e)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {entries && entries.some((e) => !mine.has(toBase64(e.credentialId))) && (
        <p className="muted small">Remove any passkey you don't recognise: anyone who once held one of your keys could have added it.</p>
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
      {step === 'idle' && support !== 'no' && (
        <div className="form-actions passkeys-actions">
          <button type="button" className="btn btn-primary" onClick={create}>
            Add a passkey
          </button>
        </div>
      )}
    </div>
  );
}
