// Activity separation (review H1, N1). The issuer sees when a masternode's token request arrives and from where; everyone sees when
// an identity changes Platform state. If the two happen close together, the times line up and link the masternode to the identity.
// So, across every tab and identity in this browser (localStorage, not per page load):
//   - a token request goes out only if nothing was written to Platform from this browser for COOLDOWN_MS, and no other request
//     went out for COOLDOWN_MS (two identities' masternodes are not linked by one session either);
//   - the scheduler posts a badge (an identity write) only COOLDOWN_MS after the last request.
// A user's own write right after a request cannot be prevented; every tab shows a note during a Private or Extra-private request's
// cooldown. Not after a Standard one: Standard posts straight away, so timing already links the two (its documented trade-off) and
// waiting would protect nothing.
const REQUEST_KEY = 'govhub.badge.lastRequestMs';
const WRITE_KEY = 'govhub.badge.lastWriteMs';
const PRIVATE_KEY = 'govhub.badge.lastPrivateRequestMs';
export const COOLDOWN_MS = 30 * 60_000;

type Store = (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>) | undefined;
/** `localStorage` itself throws (SecurityError) when site data is blocked: resolve it inside a try. */
function local(): Store {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch {
    /* blocked: fall through */
  }
  // blocked (throws) or disabled (null): reads fail closed
  return { getItem: () => { throw new Error('storage blocked'); }, setItem: () => undefined };
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** A stored time in the future (the clock was ahead) counts as now; unreadable storage counts as "just now" (fail closed). */
function read(s: Store, k: string, now: number): number {
  try {
    const v = Number(s?.getItem(k) ?? 0) || 0;
    return Math.min(v, now);
  } catch {
    return now;
  }
}
function write(s: Store, k: string, now: number): void {
  try {
    s?.setItem(k, String(now));
  } catch {
    /* storage blocked: the read side fails closed */
  }
}

/** Called for every Platform state transition of a signed-in identity (documents, identity create/top-up/update). */
export function noteIdentityWrite(storage: Store = local(), now = Date.now()): void {
  write(storage, WRITE_KEY, now);
  emit();
}

/**
 * Called before a token request (the one that names the masternode) is sent to an issuer. A challenge alone names nothing, so a
 * request that failed at the challenge (issuer unreachable) starts no cooldown.
 */
export function noteRequestSent(storage: Store = local(), now = Date.now()): void {
  write(storage, REQUEST_KEY, now);
  emit();
}

/**
 * A Private/Extra request: Standard jobs in this browser wait for its cooldown too, so they cannot undo its separation. Marked
 * before the attempt (under the activity lock, so two tabs cannot both pass mayRequest). Returns an undo for an attempt that sent
 * no token request (the issuer was unreachable): it restores the previous marks, unless something newer was marked meanwhile.
 */
export function notePrivateRequest(storage: Store = local(), now = Date.now()): () => void {
  const keys = [PRIVATE_KEY, REQUEST_KEY];
  const prev = keys.map((k) => {
    try {
      return storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  });
  for (const k of keys) write(storage, k, now);
  emit();
  return () => {
    keys.forEach((k, i) => {
      try {
        if (storage?.getItem(k) !== String(now)) return; // newer mark: keep it
        const old = prev[i];
        if (old === null || old === undefined) storage?.removeItem?.(k);
        else storage?.setItem(k, old);
      } catch {
        /* blocked storage: the read side fails closed */
      }
    });
    emit();
  };
}

/** Standard jobs never wait for anything of their own, only for a Private request's cooldown in this browser (review M1). */
export function mayStandard(storage: Store = local(), now = Date.now()): boolean {
  return now - read(storage, PRIVATE_KEY, now) >= COOLDOWN_MS;
}

export function mayRequest(storage: Store = local(), now = Date.now()): boolean {
  return now - read(storage, REQUEST_KEY, now) >= COOLDOWN_MS && now - read(storage, WRITE_KEY, now) >= COOLDOWN_MS;
}

export function mayPost(storage: Store = local(), now = Date.now()): boolean {
  return now - read(storage, REQUEST_KEY, now) >= COOLDOWN_MS;
}

/** Milliseconds left of the cooldown after the last request (0 when none is running): the note shows while this is > 0. */
export function requestCooldownLeft(storage: Store = local(), now = Date.now()): number {
  return Math.max(0, read(storage, REQUEST_KEY, now) + COOLDOWN_MS - now);
}

/**
 * Milliseconds left of the cooldown after the last Private or Extra-private request (0 when none is running): the note shows while this
 * is > 0. A Standard request starts none, since it does not wait for anything and avoiding identity writes would not undo its timing link.
 * Unreadable storage shows no note (unlike the scheduler's checks, which fail closed): with it blocked no request can have been sent.
 */
export function privateCooldownLeft(storage: Store = local(), now = Date.now()): number {
  try {
    const at = Math.min(Number(storage?.getItem(PRIVATE_KEY) ?? 0) || 0, now);
    return Math.max(0, at + COOLDOWN_MS - now);
  } catch {
    return 0;
  }
}

/** The note shown while `privateCooldownLeft` > 0 (`left` ms). */
export function privateCooldownNote(left: number): string {
  const ago = Math.floor((COOLDOWN_MS - left) / 60_000);
  return `You asked for a Private badge ${ago < 1 ? 'a moment' : `${ago} min`} ago. To keep govhub's issuer from matching that request to this account by timing, avoid posting, commenting or reacting from this browser for ${Math.ceil(left / 60_000)} more min. Standard badges don't need this.`;
}

/** Changes in this tab, and in other tabs (storage events). */
export function onVisitChange(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === REQUEST_KEY || e.key === WRITE_KEY || e.key === PRIVATE_KEY) && l();
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
