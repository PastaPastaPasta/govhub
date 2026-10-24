// Hand-off of a passkey unlocker from the passkey screens (auth/Passkeys.tsx) to the keyring provider. The sign-in ceremony's PRF
// output opens both the vault and the keyring, so a passkey sign-in restores the masternode keys without a second prompt, and a
// passkey added while the keyring is open becomes one of its unlockers. Only the derived X25519 key is kept (never the PRF output),
// for one identity, and it is wiped once used or after 60 s.
import { passkeyUnlockKey, type UnlockKey } from '@govhub/auth';

export const KEYRING_STASH_EVENT = 'govhub:keyring-stash';
export type StashPurpose = 'unlock' | 'add';

let stashed: { identityId: string; purpose: StashPurpose; key: UnlockKey; timer: ReturnType<typeof setTimeout> } | null = null;

export function stashPasskeyUnlock(identityId: string, prfOutput: Uint8Array, purpose: StashPurpose = 'unlock'): void {
  clearStash();
  stashed = { identityId, purpose, key: passkeyUnlockKey(prfOutput), timer: setTimeout(clearStash, 60_000) };
  globalThis.dispatchEvent?.(new Event(KEYRING_STASH_EVENT));
}

/** Takes the stashed key for `identityId` (the caller wipes it). */
export function takeStash(identityId: string): { purpose: StashPurpose; key: UnlockKey } | null {
  if (!stashed || stashed.identityId !== identityId) return null;
  const { purpose, key, timer } = stashed;
  clearTimeout(timer);
  stashed = null;
  return { purpose, key };
}

export function clearStash(): void {
  if (!stashed) return;
  clearTimeout(stashed.timer);
  stashed.key.wipe();
  stashed = null;
}
