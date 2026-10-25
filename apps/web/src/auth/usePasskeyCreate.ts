// The "add a passkey" ceremony, shared by Settings → Passkeys and the masternode keyring's Unlock methods card. Creating the passkey
// is not enough: a passkey that carries the govhub user handle but has no vault entry would break passkey sign-in on other devices,
// so a second ceremony restricted to the new credential gives the PRF output its entry is sealed to (it must equal the create-time one).
import { identifierBytes, listPasskeys, localPasskeys, prfInput, storeInVault, toBase64, waitForEntry, wipe, type VaultEntryDoc } from '@govhub/auth';
import { bytesEqual } from '@govhub/verify';
import { createPasskey, forgetPasskey, getPasskeyPrf, PasskeyError, prfSupport, PRF_UNAVAILABLE_MESSAGE, userHandleFor } from '@govhub/auth/webauthn';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './context.tsx';
import { errorText, rpId } from './runtime.ts';

export const isCancelled = (e: unknown): boolean => e instanceof PasskeyError && e.code === 'cancelled';

export function usePrfSupport() {
  const [s, setS] = useState<'yes' | 'no' | 'unknown' | null>(null);
  useEffect(() => void prfSupport().then(setS), []);
  return s;
}

export type PasskeyCreateStep = 'idle' | 'confirm' | 'saving' | 'done';

/**
 * The add-a-passkey ceremony plus the identity's vault entries (loaded up front: `create` must start straight from the click, since
 * Safari drops a passkey prompt that comes after a slow await, so it never fetches; the entries are what it excludes from the create
 * dialog). `onSaved` gets the new passkey's PRF output once its entry is on Platform (the hook wipes it afterwards, so a caller
 * keeps nothing but what it derives). If it throws, the passkey stays a working sign-in and the error says so.
 */
export function usePasskeyCreate({ onSaved }: { onSaved?(prfOutput: Uint8Array, identityId: string): void | Promise<void> } = {}) {
  const { session, forumContractId, platform, refreshBalance } = useAuth();
  const support = usePrfSupport();
  const [step, setStep] = useState<PasskeyCreateStep>('idle');
  const [created, setCreated] = useState<{ credentialId: Uint8Array; prf: Uint8Array | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VaultEntryDoc[] | null>(null);
  // the latest callback, not the one from the render of the click: the save below can take a while
  const saved = useRef(onSaved);
  useEffect(() => {
    saved.current = onSaved;
    // a card that is gone (the keyring locked or changed meanwhile) must not add the unlocker from stale closures
    return () => void (saved.current = undefined);
  }, [onSaved]);
  // a second click while a ceremony runs would open a second prompt (and `confirm` pay for a second vault write)
  const inflight = useRef(false);
  useEffect(() => () => wipe(created?.prf), [created]);

  const ctx = useCallback(async () => ({ platform: await platform(), contractId: forumContractId }), [platform, forumContractId]);
  const identityId = session?.identityId;
  const reload = useCallback(() => {
    if (!identityId) return;
    ctx()
      .then((c) => listPasskeys(c, identityId))
      .then(setEntries, (e) => setError(errorText(e)));
  }, [ctx, identityId]);
  useEffect(reload, [reload]);
  const pi = prfInput(identifierBytes(forumContractId));

  const create = async () => {
    if (!session || inflight.current) return;
    inflight.current = true;
    setError(null);
    try {
      const c = await createPasskey({
        rpId: rpId(), rpName: 'govhub', userHandle: userHandleFor(session.identityId, forumContractId), userName: `govhub ${session.identityId.slice(0, 10)}…`,
        prfInput: pi, exclude: entries?.map((e) => e.credentialId),
      });
      setCreated({ credentialId: c.credentialId, prf: c.prfOutput });
      setStep('confirm');
    } catch (e) {
      if (!isCancelled(e)) setError(errorText(e));
    } finally {
      inflight.current = false;
    }
  };

  // A second ceremony restricted to the new passkey: the PRF it gives is what the entry is sealed to (and must equal the create-time one).
  const confirm = async () => {
    if (!created || !session || inflight.current) return;
    inflight.current = true;
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
      await waitForEntry(c, session.identityId, created.credentialId, recipient);
      localPasskeys.add(localStorage, session.identityId, toBase64(created.credentialId));
      refreshBalance();
      reload();
      setCreated(null);
      try {
        await saved.current?.(prf, session.identityId);
        setStep('done');
      } catch (e) {
        setError(`The passkey was added for sign-in, but not finished: ${errorText(e)}`);
        setStep('idle');
      }
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
      inflight.current = false;
    }
  };

  return { support, step, error, setError, create, confirm, entries, setEntries, reload, ctx };
}
