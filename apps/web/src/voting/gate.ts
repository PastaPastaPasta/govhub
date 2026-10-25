// Small pieces of the keyring provider's session rules, kept pure so they can be tested without React.
import type { VotingKeyEntry } from '@govhub/auth';
import { onSessionEnd } from '../session/end.ts';
import type { OwnedMasternode } from './masternodes.ts';
import { mnId } from './plan.ts';

/**
 * Which session locked the saved keyring (Lock now, or the idle lock). While that session lasts, only the recovery phrase or a passkey
 * reopens it: not the session's own seed, whatever happens meanwhile (memory-only keys then "Save encrypted", a profile switch,
 * D-015). A new session (sign-in) starts unlocked.
 */
export class KeyringLock {
  #by: object | null = null;
  lock(session: object | null): void {
    if (session) this.#by = session;
  }
  unlock(): void {
    this.#by = null;
  }
  /** Locked in this session: the seed must not open the saved keyring. Forgets a lock of another session. */
  lockedIn(session: object | null): boolean {
    if (this.#by !== session) this.#by = null;
    return this.#by !== null;
  }
}

type MnRef = Pick<OwnedMasternode, 'collateralTxid' | 'collateralIndex'>;
/** Our masternode with this collateral, if any. */
export const ownerOf = (owned: readonly OwnedMasternode[], m: MnRef): OwnedMasternode | undefined => owned.find((x) => mnId(x) === mnId(m));

/**
 * Copies of the voting keys one cast needs (D-029): a lock (button or idle) during the cast wipes the keyring's keys, but the cast
 * still cancels the held votes AND signs the new ones with these. `wipe()` as soon as the votes are signed.
 */
export function castKeys(keys: readonly Pick<VotingKeyEntry, 'privateKey' | 'compressed'>[], owned: readonly OwnedMasternode[]) {
  const copies = keys.map((x) => ({ privateKey: x.privateKey.slice(), compressed: x.compressed }));
  // sign-out (or pagehide) while the cast waits on the network wipes them too
  const off = onSessionEnd(() => copies.forEach((x) => x.privateKey.fill(0)));
  return {
    ownerOf: (m: MnRef) => ownerOf(owned, m),
    keyOf: (m: MnRef) => {
      const o = ownerOf(owned, m);
      return o ? copies[o.keyIndex] : undefined;
    },
    wipe: () => {
      copies.forEach((x) => x.privateKey.fill(0));
      off();
    },
  };
}

/** A copy of one voting key for async work (a cancel): a lock meanwhile does not zero it; sign-out does. `wipe()` when done. */
export function keyCopy(k: Pick<VotingKeyEntry, 'privateKey' | 'compressed'> | undefined) {
  if (!k) return undefined;
  const c = { privateKey: k.privateKey.slice(), compressed: k.compressed };
  const off = onSessionEnd(() => c.privateKey.fill(0));
  return { ...c, wipe: () => (c.privateKey.fill(0), off()) };
}
