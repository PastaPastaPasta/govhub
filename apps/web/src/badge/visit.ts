// Activity separation (review H1, N1). The issuer sees when a masternode's token request arrives and from where; everyone sees when
// an identity changes Platform state. If the two happen close together, the times line up and link the masternode to the identity.
// So, across every tab and identity in this browser (localStorage, not per page load):
//   - a token request goes out only if nothing was written to Platform from this browser for COOLDOWN_MS, and no other request
//     went out for COOLDOWN_MS (two identities' masternodes are not linked by one session either);
//   - the scheduler posts a badge (an identity write) only COOLDOWN_MS after the last request.
// A user's own write right after a request cannot be prevented; every tab shows a note during the cooldown.
const REQUEST_KEY = 'govhub.badge.lastRequestMs';
const WRITE_KEY = 'govhub.badge.lastWriteMs';
export const COOLDOWN_MS = 30 * 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const read = (s: Store, k: string) => Number(s?.getItem(k) ?? 0) || 0;

/** Called for every Platform state transition of a signed-in identity (documents, identity create/top-up/update). */
export function noteIdentityWrite(storage: Store = globalThis.localStorage, now = Date.now()): void {
  storage?.setItem(WRITE_KEY, String(now));
  emit();
}

/** Called before anything is sent to an issuer (challenge included). */
export function noteRequestSent(storage: Store = globalThis.localStorage, now = Date.now()): void {
  storage?.setItem(REQUEST_KEY, String(now));
  emit();
}

export function mayRequest(storage: Store = globalThis.localStorage, now = Date.now()): boolean {
  return now - read(storage, REQUEST_KEY) >= COOLDOWN_MS && now - read(storage, WRITE_KEY) >= COOLDOWN_MS;
}

export function mayPost(storage: Store = globalThis.localStorage, now = Date.now()): boolean {
  return now - read(storage, REQUEST_KEY) >= COOLDOWN_MS;
}

/** Milliseconds left of the cooldown after the last request (0 when none is running): the note shows while this is > 0. */
export function requestCooldownLeft(storage: Store = globalThis.localStorage, now = Date.now()): number {
  return Math.max(0, read(storage, REQUEST_KEY) + COOLDOWN_MS - now);
}

/** Changes in this tab, and in other tabs (storage events). */
export function onVisitChange(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === REQUEST_KEY || e.key === WRITE_KEY) && l();
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
