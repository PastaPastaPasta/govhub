// "Add a passkey" in the keyring's Unlock methods card. It creates a new passkey (the same ceremony as Settings → Passkeys, which
// also gives the passkey its sign-in entry on Platform) and makes it an unlocker; a passkey the user already has is the quieter option.
import { PRF_UNAVAILABLE_MESSAGE } from '@govhub/auth/webauthn';
import { errorText } from '../../auth/runtime.ts';
import { usePasskeyCreate } from '../../auth/usePasskeyCreate.ts';
import { useKeyring } from '../../voting/KeyringContext.tsx';

export function AddPasskey() {
  const k = useKeyring();
  const { support, step, error, create, confirm, entries } = usePasskeyCreate({
    onSaved: (prf) =>
      k.addPasskeyUnlockerFrom(prf).catch((e) => {
        throw new Error(`${errorText(e)} The passkey itself is saved: "Use a passkey I already have" adds it to this keyring.`);
      }),
  });
  const working = step === 'confirm' || step === 'saving';
  if (support === 'no') return <p className="notice-box small">{PRF_UNAVAILABLE_MESSAGE}</p>;
  return (
    <>
      {!working && (
        <>
          <p className="small muted">A new passkey keeps your sign-in encrypted on Platform too. Saving costs about 0.0005 DASH of credit.</p>
          {k.needsConfirm && <p className="small muted">Confirm the list above first.</p>}
          <button type="button" className="btn btn-s" onClick={() => void create()} disabled={!!k.busy || k.needsConfirm || !entries} data-testid="create-passkey">
            Add a passkey
          </button>
        </>
      )}
      {step === 'confirm' && (
        <div className="notice-box small">
          <p>Passkey created. Confirm it once more so govhub can lock your key to it.</p>
          <button type="button" className="btn btn-s btn-primary" onClick={() => void confirm()} disabled={!!k.busy}>
            Confirm with the passkey
          </button>
        </div>
      )}
      {step === 'saving' && (
        <p className="muted small" role="status">
          <span className="spinner" aria-hidden="true" /> Saving the encrypted entry on Platform…
        </p>
      )}
      {step === 'done' && (
        <p className="notice small" data-testid="keyring-passkey-saved">
          Passkey added. It now opens this keyring and signs you in.
        </p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {!working && (
        <button type="button" className="btn btn-s btn-quiet" onClick={() => void k.addPasskeyUnlocker().catch(() => {})} disabled={!!k.busy} data-testid="existing-passkey">
          Use a passkey I already have
        </button>
      )}
    </>
  );
}
